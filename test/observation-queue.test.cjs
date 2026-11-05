'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {ObservationQueue} = require('../src/observation-queue.cjs');
const {Store, hash} = require('../src/core.cjs');
const sample = (time, provider = 'codex') => ({v: 1, provider, account: hash(provider), time, plan: 'fixture', source: 'app-server', windows: {five: null, week: {used: 5, reset: time + 86400000}}});
async function temporary(operation) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-queue-'));
  try {await operation(dir);}
  finally {assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('usage-atlas-queue-')); await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});}
}
test('durable observations replay once after a commit failure and a process restart', async () => temporary(async dir => {
  const store = new Store(dir), queue = new ObservationQueue(dir), now = Date.now(), original = store.commit;
  store.commit = async () => {throw Object.assign(new Error('disk fixture'), {code: 'ENOSPC'});};
  await assert.rejects(queue.accept([sample(now), sample(now + 1, 'claude')], store));
  assert.match(queue.status().issue, /ENOSPC/);
  assert.equal(queue.status().pending, 2); assert.equal(await queue.ready(store), false);
  store.commit = original;
  const reopened = new ObservationQueue(dir);
  assert.equal(await reopened.ready(store), true); assert.equal((await store.read()).length, 2);
  assert.equal(await reopened.ready(store), true); assert.equal((await store.read()).length, 2);
  assert.equal(await fs.readFile(queue.file, 'utf8'), '');
}));
test('ordinary durable writes are not reported as recovery incidents', async () => temporary(async dir => {
  const store = new Store(dir), queue = new ObservationQueue(dir);
  await queue.accept([sample(Date.now())], store);
  assert.equal(queue.status().pending, 0); assert.equal(queue.status().recovered, 0); assert.equal(queue.status().issue, '');
}));
test('invalid retention settings never turn a stored history into an immediate-expiry policy', async () => temporary(async dir => {
  const store = new Store(dir, 365), now = Date.now();
  await store.append([sample(now - 120 * 86400000)]);
  for (const value of [null, undefined, 0, -1, NaN, Infinity, '7']) {
    store.retentionDays = value; assert.equal(store.retentionDays, 365);
    assert.equal((await store.read()).length, 1);
  }
  assert.equal(new Store(dir, null).retentionDays, 90);
  store.retentionDays = 7; assert.equal((await store.read()).length, 0);
}));
test('crash between durable history commit and queue acknowledgment does not double count', async () => temporary(async dir => {
  const store = new Store(dir), queue = new ObservationQueue(dir), now = Date.now(), rename = fs.rename;
  fs.rename = async (a, b) => {if (b === queue.file) throw Object.assign(new Error('ack fixture'), {code: 'EACCES'}); return rename(a, b);};
  try {await assert.rejects(queue.accept([sample(now)], store));} finally {fs.rename = rename;}
  assert.equal((await store.read()).length, 1);
  const restarted = new ObservationQueue(dir); assert.equal(await restarted.ready(store), true);
  assert.equal((await store.read()).length, 1);
}));
test('partially written receipt is preserved while valid observations recover', async () => temporary(async dir => {
  const store = new Store(dir), queue = new ObservationQueue(dir), now = Date.now();
  const raw = JSON.stringify({v: 1, snapshot: sample(now)}) + '\n{"v":1,"snapshot":';
  await fs.writeFile(queue.file, raw);
  assert.equal(await queue.ready(store), true); assert.equal((await store.read()).length, 1);
  const backups = (await fs.readdir(dir)).filter(name => name.startsWith('pending-damaged-'));
  assert.equal(backups.length, 1); assert.equal(await fs.readFile(path.join(dir, backups[0]), 'utf8'), raw);
}));
test('a full pending budget retains the fetched sample and pauses until recovery', async () => temporary(async dir => {
  const store = new Store(dir), queue = new ObservationQueue(dir, {maxItems: 1}), now = Date.now();
  await fs.writeFile(queue.file, JSON.stringify({v: 1, snapshot: sample(now)}) + '\n');
  await assert.rejects(queue.accept([sample(now + 1)], store));
  assert.equal(queue.status().memory, 1);
  assert.equal(await queue.ready(store), true); assert.equal((await store.read()).length, 2);
}));
