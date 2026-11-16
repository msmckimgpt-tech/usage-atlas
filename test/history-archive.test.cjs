'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {HistoryArchive} = require('../src/history-archive.cjs');
const {project, ProjectionStream, hash, Store, series} = require('../src/core.cjs');
const {converter} = require('../src/credit-conversion.cjs');
const billing = require('../src/billing.cjs');
const now = Date.now(), minute = 60000, day = 86400000;
function records() {
  return ['codex', 'claude', 'antigravity-5d72436256ada538'].flatMap(provider => Array.from({length: 41}, (_, i) => {
    const plan = Object.keys(billing.catalog.providers[provider]?.plans || {fixture: 1})[0];
    return {v: 1, provider, account: hash(provider), plan, source: 'import', time: now - (40 - i) * minute, windows: {five: {used: i < 20 ? 20 + i : i < 26 ? 5 + i - 20 : i < 28 ? 8 : 9 + i - 28, reset: now + (i < 20 ? 1 : 3) * 3600000}, week: {used: i < 27 ? 30 + i : 50 + i - 27, reset: now + 6 * day}}, ...(provider === 'codex' ? {creditBalance: 10000 - i * 5} : provider === 'claude' ? {spentUsd: i / 10, spendPeriod: '2026-11'} : {label: 'Gemini'})};
  })).sort((a, b) => a.time - b.time || a.provider.localeCompare(b.provider));
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-archive-'));
  const archive = new HistoryArchive(dir), resources = [archive];
  t.after(async () => {for (const resource of resources) await resource.dispose(); if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('usage-atlas-archive-')) throw Error('Unsafe cleanup'); await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});});
  return {dir, archive, resources};
}
test('streamed quotas, credits and billing match full projection across single-record and irregular batch boundaries', () => {
  const source = records(), heads = Object.values(project(source)).map(p => p.last).filter(Boolean);
  const capacities = heads.flatMap(row => ['five', 'week'].map(window => ({provider: row.provider, account: row.account, plan: row.plan, window, time: row.time, mult: 5})));
  const model = {cohorts: heads.flatMap(row => ['five', 'week'].map(window => ({id: JSON.stringify([row.provider, row.account, row.plan, 5, window]), unitsPerPercent: 10}))), paidThrough: {codex: {account: hash('codex'), time: source[0].time - 1}}};
  const fullConvert = converter(model), fullBill = billing.enricher(), expected = project(source, capacities, undefined, (...args) => {fullConvert(...args); fullBill(...args);});
  for (const size of [1, 7, 23, source.length]) {
    const multipliers = Object.fromEntries(heads.map(row => [row.provider, Object.fromEntries(['five', 'week'].map(w => [w, series([row], row.provider, w, capacities).at(-1).mult]))]));
    const convert = converter(model, {states: new Map(), multipliers}), bill = billing.enricher(billing.catalog, new Map());
    const stream = new ProjectionStream(heads, capacities, undefined, (...args) => {convert(...args); bill(...args);});
    for (let i = 0; i < source.length; i += size) stream.accept(source.slice(i, i + size));
    assert.deepEqual(stream.data(), expected, 'batch size ' + size);
  }
});
test('archive seeds existing originals, deduplicates writes and matches the core projection without changing the hot file', async t => {
  const {dir, archive} = await fixture(t), source = records();
  const original = source.slice(0, 60).map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(path.join(dir, 'history.jsonl'), original);
  await archive.append(source); await archive.append(source);
  const result = await archive.query({from: now - day, capacities: [], conversion: null, maxGap: 1800000});
  const convert = converter(null), bill = billing.enricher(), expected = project(source, [], undefined, (...args) => {convert(...args); bill(...args);});
  assert.deepEqual(result.data, expected); assert.equal(result.count, source.length);
  assert.equal(await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8'), original);
  await archive.release(); const reopened = await archive.query({from: now - day, capacities: [], conversion: null, maxGap: 1800000});
  assert.deepEqual(reopened.data, result.data);
});
test('new observations extend a cached projection, while older imports and account switches rebuild safely', async t => {
  const {archive} = await fixture(t), source = records(); await archive.append(source.slice(0, -3));
  const query = {from: now - day, capacities: [], conversion: null, maxGap: 1800000};
  const first = await archive.query(query); await archive.append(source.slice(-3)); const second = await archive.query(query);
  assert.equal(second.count, first.count + 3);
  const older = {...source[0], time: source[0].time - minute}; await archive.append([older]);
  const imported = await archive.query(query); assert.equal(imported.count, second.count + 1);
  const other = {...source.at(-1), account: hash('changed'), time: source.at(-1).time + 1}; await archive.append([other]);
  const changed = await archive.query(query); assert.equal(changed.data[other.provider].windows.week.length, 1);
});
test('hot retention compaction cannot delete originals before the archive confirms persistence', async t => {
  const {dir, archive, resources} = await fixture(t);
  const source = records().map(r => ({...r, time: r.time - 30 * day, windows: Object.fromEntries(Object.entries(r.windows).map(([w, v]) => [w, {...v, reset: v.reset - 30 * day}]))}));
  await fs.writeFile(path.join(dir, 'history.jsonl'), source.map(r => JSON.stringify(r)).join('\n') + '\n');
  const store = new Store(dir, 7, {archive: true}); resources.push(store.archive);
  await store.append([]); assert.equal((await store.read()).length, 0);
  const result = await archive.query({from: now - 40 * day, capacities: [], conversion: null, maxGap: 1800000});
  assert.equal(result.count, source.length);
});
test('archive retention excludes expired originals and canceled queries leave the archive usable', async t => {
  const {archive} = await fixture(t), source = records(); await archive.append([...source, {...source[0], time: now - 400 * day}]);
  const query = {from: now - 500 * day, capacities: [], conversion: null, maxGap: 1800000};
  const controller = new AbortController(); controller.abort(); await assert.rejects(archive.query(query, {signal: controller.signal}), /취소/);
  const result = await archive.query(query); assert.equal(result.count, source.length); assert.ok(result.first >= now - 2 * day);
  assert.equal((await archive.query(query)).count, source.length);
});
test('archived Codex debit mode defaults to estimated Standard only with a matching observed subscription cohort', async t => {
  const {archive} = await fixture(t), source = records().filter(row => row.provider === 'codex'); await archive.append(source);
  const row = source.at(-1), capacities = ['five', 'week'].map(window => ({provider: row.provider, account: row.account, plan: row.plan, time: row.time, mult: 5, window}));
  const conversion = {cohorts: ['five', 'week'].map(window => ({id: JSON.stringify([row.provider, row.account, row.plan, 5, window]), unitsPerPercent: 10})), paidThrough: {codex: {account: row.account, time: now}}};
  const result = await archive.query({from: now - day, capacities, conversion, maxGap: 1800000}), point = result.data.codex.windows.week.at(-1);
  assert.equal(point.creditEstimate.standardAssumed, true); assert.ok(point.creditEstimate.nativeTotal > 0);
  const missing = await archive.query({from: now - day, capacities, conversion: null, maxGap: 1800000});
  assert.equal(missing.data.codex.windows.week.at(-1).creditEstimate.nativeTotal, null);
  const detail = await archive.details({provider: 'codex', account: row.account, from: now - day, to: now + 1, time: now});
  assert.equal(detail.totalCount, source.length); assert.equal(detail.truncated, false); assert.deepEqual(detail.records, source);
});
