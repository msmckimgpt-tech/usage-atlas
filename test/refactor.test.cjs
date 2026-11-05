'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const current = require('../src/core.cjs');
const baseline = require('./fixtures/core-0.1.9.cjs');
const now = Date.now(), account = current.hash('fixture');
const record = (i, provider = 'codex') => ({v: 1, provider, account, plan: i % 3 ? 'one' : 'five', time: now - 5000000 + i * 10000, windows: {five: i % 11 ? {used: Math.min(100, i / 5), reset: now + 3600000} : null, week: {used: Math.min(100, i / 5), reset: now + 86400000}}, creditBalance: 65000 - i, spentUsd: i / 10, spendPeriod: '2026-10'});
async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-refactor-'));
  try {await fn(dir);} finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('usage-atlas-refactor-'));
    await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
}
test('non-reset projection matches released calculations for both providers, accounts, gaps and tied capacities', () => {
  const records = Array.from({length: 400}, (_, i) => ({...record(i, i % 2 ? 'claude' : 'codex'), ...(i < 30 ? {account: current.hash('old')} : {})})).reverse();
  const caps = Array.from({length: 100}, (_, i) => ({provider: i % 2 ? 'claude' : 'codex', account, plan: i % 3 ? 'one' : 'five', window: i % 5 ? 'five' : 'week', mult: i % 3 + 1, time: now - 5000000 + Math.floor(i / 2) * 10000}));
  caps.push({...caps[20], mult: 20});
  const output = current.project(records, caps, 60000);
  const keys = new Set(), retroCaps = [...caps];
  for (const c of [...caps].sort((a,b) => a.time-b.time)) {const key = [c.provider,c.account,c.plan,c.window].join('/'); if (!keys.has(key)) {keys.add(key); retroCaps.push({...c,time:0});}}
  for (const id of ['codex', 'claude']) {
    for (const w of ['five', 'week']) assert.deepEqual(output[id].windows[w].map(({credit,event,segment,cumulativeSegment,estimatedDelta,cumulativeEstimated,recoveryExcluded,recoveryPeak,...p}) => p), baseline.series(records, id, w, retroCaps, 60000));
    const ledger = baseline.creditLedger(records, id, 60000);
    assert.deepEqual(output[id].ledger.map(({credit,event,estimatedDelta,cumulativeEstimated,recoveryExcluded,recoveryPeak,...p}) => p), ledger.points); assert.equal(output[id].creditTotal, ledger.total);
  }
});
test('dense projections retain original observed values, extrema, endpoints and gaps within budget', () => {
  const records = Array.from({length: 10000}, (_, i) => ({...record(i, i % 2 ? 'claude' : 'codex'), time: now - 10000000 + i * 1000}));
  const output = current.project(records);
  for (const id of ['codex', 'claude']) {
    for (const w of ['five', 'week']) {
      const full = baseline.series(records, id, w), index = new Map(full.map((p,i) => [p.time,i]));
      const points = output[id].windows[w]; assert.ok(points.length <= 2002);
      assert.equal(points[0].time,full[0].time); assert.equal(points.at(-1).time,full.at(-1).time);
      for (const [i,p] of points.entries()) {
        const raw = full[index.get(p.time)], {credit,event,segment,cumulativeSegment,estimatedDelta,cumulativeEstimated,recoveryExcluded,recoveryPeak,continuous,totalContinuous,...values}=p;
        const {continuous:oldContinuous,totalContinuous:oldTotal,...original}=raw;
        assert.deepEqual(values,original);
        const between=full.slice(i ? index.get(points[i-1].time)+1 : 0,index.get(p.time)+1);
        assert.equal(continuous,i>0 && between.every(p=>p.continuous));
        assert.equal(totalContinuous,i>0 && between.every(p=>p.totalContinuous));
      }
    }
    const full=baseline.creditLedger(records,id).points,index=new Map(full.map(p=>[p.time,p]));
    assert.ok(output[id].ledger.length<=1502);
    for(const p of output[id].ledger){assert.equal(p.amount,index.get(p.time).amount);assert.equal(p.delta,index.get(p.time).delta);}
  }
});
test('append preserves file identity and bytes; duplicate/no-op collections do not rewrite history', () => temporary(async dir => {
  const store = new current.Store(dir), file = path.join(dir, 'history.jsonl');
  await store.append([record(0)]); const first = await fs.readFile(file), stat = await fs.stat(file);
  await store.append([record(1), record(1)]); const second = await fs.readFile(file), appended = await fs.stat(file);
  assert.equal(stat.ino, appended.ino); assert.ok(second.subarray(0, first.length).equals(first));
  assert.equal((await store.read()).length, 2);
  await store.append([]); await store.append([record(1)]); const unchanged = await fs.stat(file);
  assert.equal(unchanged.mtimeMs, appended.mtimeMs); assert.equal(unchanged.size, appended.size);
}));
test('another window follows append and atomic replacement without stale or duplicate rows', () => temporary(async dir => {
  const writer = new current.Store(dir), reader = new current.Store(dir);
  await writer.append([record(2)]); await reader.read();
  await writer.append([record(3)]); assert.deepEqual(await reader.read(), await writer.read());
  await writer.append([record(1)]); assert.deepEqual((await reader.read()).map(r => r.time), [1, 2, 3].map(i => record(i).time));
  await reader.append([record(4)]); assert.deepEqual(await writer.read(), await reader.read());
}));
test('interrupted append is repaired before new valid rows; corruption never consumes the next snapshot', () => temporary(async dir => {
  const store = new current.Store(dir), file = path.join(dir, 'history.jsonl');
  await store.append([record(0)]); await fs.appendFile(file, '{"v":1');
  assert.equal((await store.read()).length, 1);
  await store.append([record(1)]); const independent = new current.Store(dir);
  assert.deepEqual(await independent.read(), await store.read()); assert.equal((await independent.read()).length, 2);
}));
test('retention and 50k cap remain exact between periodic physical compactions', () => temporary(async dir => {
  const store = new current.Store(dir, 7), file = path.join(dir, 'history.jsonl');
  const records = Array.from({length: 50000}, (_, i) => ({...record(i), time: now - 1000000 + i}));
  await store.append([{...record(0), time: now - 8 * 86400000}, ...records]);
  const ino = (await fs.stat(file)).ino;
  await store.append([{...record(1), time: now}]);
  assert.equal((await store.read()).length, 50000); assert.equal((await store.read())[0].time, records[1].time);
  assert.equal((await fs.stat(file)).ino, ino);
  assert.equal((await new current.Store(dir, 7).read()).length, 50000);
  await store.append(Array.from({length: 256}, (_, i) => ({...record(1), time: now + i + 1})));
  assert.notEqual((await fs.stat(file)).ino, ino, 'physical compaction runs after the append allowance');
  assert.equal((await store.read()).length, 50000); assert.equal((await fs.readFile(file, 'utf8')).trim().split('\n').length, 50000);
}));
test('overlapping follower reads during writes converge to the exact committed history', () => temporary(async dir => {
  const writer = new current.Store(dir), reader = new current.Store(dir);
  await writer.append([record(0)]); await reader.read();
  for (let i = 1; i < 15; i++) {await Promise.all([writer.append([record(i)]), reader.read()]); assert.deepEqual(await reader.read(), await writer.read());}
}));
test('legacy atomic writers can replace the file repeatedly while a follower is idle', () => temporary(async dir => {
  const writer = new baseline.Store(dir), reader = new current.Store(dir);
  await writer.append([record(0)]); await reader.read();
  for (let i = 1; i < 12; i++) await writer.append([record(i)]);
  assert.deepEqual(await reader.read(), await writer.read());
}));
