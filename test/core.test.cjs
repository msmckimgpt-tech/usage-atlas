const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {codexSnapshot, claudeSnapshot, series, Store, sanitize, hash, thin} = require('../src/core.cjs');
const time = Date.now() - 1000000;
const sample = (used, t, reset = time + 10000000, plan = 'one') => ({v: 1, provider: 'codex', account: hash('a'), time: t, plan, windows: {five: {used, reset}, week: null}});
test('primary duration is authoritative; absent five-hour is never zero', () => {
  const s = codexSnapshot({rateLimits: {primary: {usedPercent: 47, windowDurationMins: 10080, resetsAt: 1900000000}, credits: {balance: '62500'}}}, {email: 'test'});
  assert.equal(s.windows.five, null); assert.equal(s.windows.week.used, 47); assert.equal(s.spentUsd, undefined);
});
test('Claude quota and explicitly typed currency only', () => {
  const a = claudeSnapshot({five_hour: {utilization: 21, resets_at: '2026-10-15T10:00:00Z'}, extra_usage: {used_credits: 1234}}, 'account', 'team');
  assert.equal(a.windows.five.used, 21); assert.equal(a.spentUsd, null); assert.equal(a.windows.week, null);
  const b = claudeSnapshot({spend: {used: {amount_minor: 120, currency: 'USD', exponent: 2}}}, 'account', 'team');
  assert.equal(b.spentUsd, 1.2);
});
test('delta excludes reset, decreases, plan change, gaps and accounts', () => {
  const reset = time + 500000;
  const records = [sample(10, time, reset), sample(25, time + 100000, reset), sample(20, time + 200000, reset), sample(30, time + 300000, reset, 'five'), sample(5, time + 400000, reset + 100000), sample(8, time + 600000, reset + 100000)];
  const p = series(records, 'codex', 'five');
  assert.deepEqual(p.map(x => x.delta), [null, 15, null, null, null, null]);
  const gap = series([sample(1, time), sample(2, time + 1900000)], 'codex', 'five'); assert.equal(gap[1].delta, null);
  records.push({...sample(50, time + 700000), account: hash('b')}); assert.equal(series(records, 'codex', 'five').length, 1);
});
test('first capacity calibrates same-plan history, separately for each window', () => {
  const r = [sample(10, time), sample(15, time + 100000), sample(20, time + 200000)];
  const c = [{provider: 'codex', account: hash('a'), plan: 'one', window: 'five', mult: 5, time: time + 100000}];
  const p = series(r, 'codex', 'five', c);
  assert.deepEqual(p.map(x => x.mult), [5, 5, 5]); assert.equal(p[1].delta, 5); assert.equal(p[2].delta, 5); assert.equal(p[2].cumulative, 50);
});
test('later calibration recalculates historical cumulative with the entered multiplier', () => {
  const r = [sample(49, time), sample(60, time + 100000), sample(82, time + 200000), sample(82, time + 300000), sample(84, time + 400000)];
  const c = [{provider: 'codex', account: hash('a'), plan: 'one', window: 'five', mult: 5, time: time + 300000}];
  const p = series(r, 'codex', 'five', c);
  assert.deepEqual(p.map(x => x.nativeCumulative), [0, 11, 33, 33, 35]);
  assert.deepEqual(p.map(x => x.cumulativeKnown), [true, true, true, true, true]);
  assert.equal(p.at(-1).cumulative, 175);
  assert.equal(p[3].continuous, true); assert.equal(p[3].totalContinuous, true);
});
test('fully calibrated cumulative survives reset and plan changes, with gaps disconnected', () => {
  const reset = time + 250000;
  const r = [sample(10, time, reset), sample(20, time + 100000, reset), sample(0, time + 300000), sample(5, time + 400000), sample(1, time + 500000, undefined, 'five'), sample(3, time + 600000, undefined, 'five'), sample(4, time + 2600000, undefined, 'five')];
  const c = ['one', 'five'].map(plan => ({provider: 'codex', account: hash('a'), plan, window: 'five', mult: plan === 'one' ? 1 : 5, time}));
  const p = series(r, 'codex', 'five', c);
  assert.deepEqual(p.map(x => x.nativeCumulative), [0, 10, 10, 15, 15, 17, 17]);
  assert.deepEqual(p.map(x => x.cumulative), [0, 10, 10, 15, 15, 25, 25]);
  assert.ok(p.every(x => x.cumulativeKnown));
  assert.equal(p[2].totalContinuous, true); assert.equal(p[4].totalContinuous, true); assert.equal(p[6].totalContinuous, false);
});
test('downsampling keeps cumulative continuity independent of quota resets and missing samples', () => {
  const points = Array.from({length: 80}, (_, i) => ({time: i, value: i, continuous: i !== 10, totalContinuous: i !== 23}));
  const out = thin(points, 16);
  const reset = out.findIndex((p, i) => i > 0 && out[i - 1].time < 10 && p.time >= 10);
  const gap = out.findIndex((p, i) => i > 0 && out[i - 1].time < 23 && p.time >= 23);
  assert.equal(out[reset].continuous, false); assert.equal(out[reset].totalContinuous, true);
  assert.equal(out[gap].totalContinuous, false);
});
test('import strips unknown fields and secrets', () => {
  const s = sanitize({...sample(10, time), token: 'secret', windows: {five: {used: 10, reset: time, auth: 'secret'}, week: null}});
  assert.equal(JSON.stringify(s).includes('secret'), false); assert.throws(() => sanitize(sample(101, time)));
});
test('atomic storage, duplicate import, corrupt tail, concurrent writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-test-'));
  try {
    const store = new Store(dir);
    const s = sample(10, time);
    await store.append([s, s]); assert.equal((await store.read()).length, 1);
    await fs.appendFile(path.join(dir, 'history.jsonl'), '{broken');
    await store.append([sample(15, time + 1000)]); assert.equal((await store.read()).length, 2);
    await Promise.all([store.append([sample(20, time + 2000)]), store.append([sample(30, time + 3000)])]);
    assert.equal((await store.read()).length, 4); assert.equal((await fs.readdir(dir)).includes('writer.lock'), false);
    await fs.writeFile(path.join(dir, 'writer.lock'), '{interrupted');
    const old = new Date(Date.now() - 180000); await fs.utimes(path.join(dir, 'writer.lock'), old, old);
    await store.append([sample(40, time + 4000)]); assert.equal((await store.read()).length, 5);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^usage-atlas-test-/);
    await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
});
