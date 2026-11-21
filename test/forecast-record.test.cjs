'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const forecast = require('../media/forecast.js');
const {ForecastRecord, record, view, merge, prune, sanitize} = require('../src/forecast-record.cjs');

const minute = 60000, hour = 60 * minute, day = 24 * hour;
const base = Date.UTC(2026, 10, 20, 0, 0);
// 한 시간 동안 분당 0.5%p 씩 오르는 5시간 창과 주간 창을 만든다.
function provider(now, {fiveReset = now + 4 * hour, weekReset = now + 3 * day, mult = 5} = {}) {
  const make = (reset, start, slope) => Array.from({length: 61}, (_, i) => {
    const time = now - (60 - i) * minute;
    return {time, value: start + i * slope, delta: i ? slope : 0, continuous: i > 0, reset, plan: 'fixture', mult};
  });
  const windows = {five: make(fiveReset, 10, .5), week: make(weekReset, 20, .05)};
  return {windows, forecast: forecast.provider(windows)};
}

test('records one snapshot per window and respects the per-window interval', () => {
  const entries = {}, now = base;
  assert.equal(record(entries, {codex: provider(now)}, now), true);
  assert.deepEqual(Object.keys(entries).sort(), ['codex:five', 'codex:week']);
  const snap = entries['codex:five'][0];
  assert.equal(snap.at, now); assert.equal(snap.mult, 5);
  assert.ok(snap.points.length >= 2 && snap.points.length <= 24);
  assert.equal(snap.points[0][1], 40);
  // 30분 뒤에는 5시간 창 간격(1시간) 전이므로 새로 남기지 않는다.
  assert.equal(record(entries, {codex: provider(now + 30 * minute, {fiveReset: now + 4 * hour, weekReset: now + 3 * day})}, now + 30 * minute), false);
  // 1시간 뒤에는 5시간 창만 새로 남고 주간 창(6시간 간격)은 그대로다.
  assert.equal(record(entries, {codex: provider(now + hour, {fiveReset: now + 4 * hour, weekReset: now + 3 * day})}, now + hour), true);
  assert.equal(entries['codex:five'].length, 2); assert.equal(entries['codex:week'].length, 1);
});

test('a new cycle is recorded immediately', () => {
  const entries = {}, now = base;
  record(entries, {claude: provider(now)}, now);
  const next = now + 10 * minute;
  assert.equal(record(entries, {claude: provider(next, {fiveReset: next + 5 * hour, weekReset: now + 3 * day})}, next), true);
  assert.equal(entries['claude:five'].length, 2);
});

test('view only exposes snapshots that already started and prune drops old ones', () => {
  const entries = {}, now = base;
  record(entries, {codex: provider(now)}, now);
  assert.deepEqual(view(entries, now), {});
  assert.equal(view(entries, now + 1).codex.five.length, 1);
  prune(entries, now + 8 * day);
  assert.equal(entries['codex:five'], undefined, 'five-hour snapshots are kept for 7 days');
  assert.equal(entries['codex:week'].length, 1, 'weekly snapshots are kept for 21 days');
});

test('sanitize rejects malformed data and merge deduplicates by time', () => {
  const good = {at: 1, reset: 10, mult: null, end: 'reset', points: [[1, 5], [2, 6]]};
  const clean = sanitize({version: 1, entries: {'codex:five': [good, {at: 2, reset: 1, points: [[1, 2]]}, {...good, at: 3, points: [[1, 5], [1, 6]]}], 'bad key': [good], 'codex:month': [good]}});
  assert.deepEqual(Object.keys(clean), ['codex:five']); assert.equal(clean['codex:five'].length, 1);
  assert.deepEqual(sanitize({version: 2, entries: {}}), {});
  const merged = merge(clean, {'codex:five': [good, {...good, at: 0}]});
  assert.deepEqual(merged['codex:five'].map(s => s.at), [0, 1]);
});

test('recorded() clips snapshots to the past and scales by the stored multiplier', () => {
  const snap = {at: 0, reset: 10 * hour, mult: 5, points: [[0, 10], [2 * hour, 30], [4 * hour, 50]]};
  const [line] = forecast.recorded([snap], {now: 3 * hour});
  assert.deepEqual(line.points.map(p => [p.time, p.value]), [[0, 10], [2 * hour, 30], [3 * hour, 40]]);
  assert.deepEqual(forecast.recorded([snap], {now: 3 * hour, basis: 'base'})[0].points.map(p => p.y), [50, 150, 200]);
  assert.equal(forecast.recorded([{...snap, at: 3 * hour}], {now: 3 * hour}).length, 0, 'snapshots from now have no past part');
  assert.equal(forecast.recorded([snap], {now: 3 * hour, domain: [5 * hour, 6 * hour]}).length, 0, 'outside the visible range');
  assert.equal(forecast.recorded([{...snap, points: [[0, 10], [0, 20]]}], {now: 3 * hour}).length, 0, 'invalid order');
  assert.equal(forecast.recorded([{...snap, reset: hour}], {now: 3 * hour})[0].points.at(-1).time, hour, 'stops at reset');
});

test('ForecastRecord persists to disk and merges with another window', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ua-record-'));
  try {
    const now = Date.now();
    const a = new ForecastRecord(dir), b = new ForecastRecord(dir);
    await a.load(); await b.load();
    a.record({codex: provider(now)}, now); await a.save();
    b.record({claude: provider(now)}, now); await b.save();
    const c = new ForecastRecord(dir); await c.load();
    assert.deepEqual(Object.keys(c.entries).sort(), ['claude:five', 'claude:week', 'codex:five', 'codex:week']);
    const stat = await fs.stat(path.join(dir, 'forecast-record.json'));
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});

test('reset jitter is the same cycle; a real cycle change records right away', () => {
  const start = base, fiveReset = start + 4 * hour, weekReset = start + 3 * day;
  for (const [shift, expected] of [[5 * minute, 1], [20 * minute, 1], [-20 * minute, 1], [70 * minute, 2]]) {
    const entries = {}, next = start + 15 * minute;
    record(entries, {codex: provider(start, {fiveReset, weekReset})}, start);
    record(entries, {codex: provider(next, {fiveReset: fiveReset + shift, weekReset})}, next);
    assert.equal(entries['codex:five'].length, expected, 'reset shift ' + shift / minute + 'min');
  }
  // 새 주기여도 10분 안에는 다시 남기지 않는다.
  const entries = {}, soon = start + 5 * minute;
  record(entries, {codex: provider(start, {fiveReset, weekReset})}, start);
  record(entries, {codex: provider(soon, {fiveReset: soon + 5 * hour, weekReset})}, soon);
  assert.equal(entries['codex:five'].length, 1);
});

test('stale observations are not recorded', () => {
  const entries = {}, observed = base;
  assert.equal(record(entries, {codex: provider(observed)}, observed + 20 * minute), false);
  assert.deepEqual(entries, {});
});

test('two windows recording the same key are thinned to the interval after merge', () => {
  const fiveReset = base + 4 * hour, weekReset = base + 3 * day, a = {}, b = {};
  record(a, {codex: provider(base, {fiveReset, weekReset})}, base);
  record(b, {codex: provider(base + 12 * minute, {fiveReset, weekReset})}, base + 12 * minute);
  const merged = prune(merge(a, b), base + 20 * minute);
  assert.deepEqual(merged['codex:five'].map(s => s.at), [base]);
});
