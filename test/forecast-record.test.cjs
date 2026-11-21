'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const forecast = require('../media/forecast.js');
const {ForecastRecord, record, view, merge, prune, thin, due, sanitize} = require('../src/forecast-record.cjs');

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

test('baseline() fixes one forecast per cycle: the first one made after the lead time', () => {
  // 5시간 창: 주기 시작 = reset - 5시간, 기준 = 시작 30분 뒤 이후 첫 스냅샷.
  const reset = 10 * hour, start = reset - 5 * hour;
  const early = {at: start + 5 * minute, reset, mult: 5, points: [[start + 5 * minute, 1], [reset, 90]]};
  const chosen = {at: start + 40 * minute, reset, mult: 5, points: [[start + 40 * minute, 10], [start + 2 * hour, 30], [reset, 60]]};
  const later = {at: start + 2 * hour, reset, mult: 5, points: [[start + 2 * hour, 35], [reset, 70]]};
  const now = start + 3 * hour;
  const [line, ...rest] = forecast.baseline([later, early, chosen], {now, window: 'five'});
  assert.equal(rest.length, 0, 'one line per cycle');
  assert.equal(line.at, chosen.at); assert.equal(line.start, start);
  assert.deepEqual(line.past.map(p => [p.time, p.value]), [[chosen.at, 10], [start + 2 * hour, 30], [now, 40]], 'past part is the fixed forecast, not the actual trajectory');
  assert.deepEqual(line.future.map(p => [p.time, p.value]), [[now, 40], [reset, 60]], 'the remaining part continues to the reset');
  assert.deepEqual(forecast.baseline([chosen], {now, window: 'five', basis: 'base'})[0].past.map(p => p.y), [50, 150, 200], 'base capacity scales by the stored multiplier');
});

test('baseline() handles young cycles, past cycles, jitter and invalid data', () => {
  const reset = 10 * hour, start = reset - 5 * hour;
  const early = {at: start + 5 * minute, reset, mult: null, points: [[start + 5 * minute, 1], [reset, 90]]};
  assert.deepEqual(forecast.baseline([early], {now: start + 3 * hour, window: 'five'}), [], 'no baseline before the lead time has passed');
  const chosen = {at: start + 40 * minute, reset, mult: null, points: [[start + 40 * minute, 10], [reset, 60]]};
  assert.deepEqual(forecast.baseline([chosen], {now: chosen.at, window: 'five'}), [], 'a forecast made now has no past part yet');
  // 리셋 시각이 조금 흔들린 스냅샷은 같은 주기로 묶여 기준이 바뀌지 않는다.
  const jitter = {at: start + hour, reset: reset + 20 * minute, mult: null, points: [[start + hour, 20], [reset + 20 * minute, 70]]};
  assert.equal(forecast.baseline([chosen, jitter], {now: start + 2 * hour, window: 'five'}).length, 1);
  // 지난 주기의 기준은 지금 이후 구간이 없고 그 주기의 초기화에서 끝난다.
  const next = {at: reset + 50 * minute, reset: reset + 5 * hour, mult: null, points: [[reset + 50 * minute, 5], [reset + 5 * hour, 50]]};
  const lines = forecast.baseline([chosen, next], {now: reset + 2 * hour, window: 'five'});
  assert.equal(lines.length, 2); assert.equal(lines[0].future.length, 0); assert.equal(lines[0].past.at(-1).time, reset);
  assert.equal(forecast.baseline([chosen], {now: reset + hour, window: 'five', domain: [reset + 30 * minute, reset + 2 * hour]}).length, 0, 'outside the visible range');
  assert.deepEqual(forecast.baseline([{...chosen, points: [[1, 10], [1, 20]]}], {now: reset, window: 'five'}), [], 'invalid order');
  // 주간 창은 주기 시작 6시간 뒤 예측이 기준이다.
  const wReset = 20 * day, wStart = wReset - 7 * day;
  const w = [{at: wStart + 3 * hour, reset: wReset, mult: null, points: [[wStart + 3 * hour, 2], [wReset, 50]]}, {at: wStart + 7 * hour, reset: wReset, mult: null, points: [[wStart + 7 * hour, 4], [wReset, 60]]}];
  assert.equal(forecast.baseline(w, {now: wStart + 2 * day, window: 'week'})[0].at, wStart + 7 * hour);
});

test('the recorder keeps a snapshot right after the baseline lead time', () => {
  // 주기 시작 직후 즉시 기록 → 30분 뒤(1시간 간격 전이라도) 기준용으로 한 번 더 기록.
  const start = base, fiveReset = start + 5 * hour, weekReset = start + 3 * day, entries = {};
  record(entries, {codex: provider(start, {fiveReset, weekReset})}, start);
  record(entries, {codex: provider(start + 20 * minute, {fiveReset, weekReset})}, start + 20 * minute);
  assert.equal(entries['codex:five'].length, 1, 'before the lead time the interval rule applies');
  record(entries, {codex: provider(start + 31 * minute, {fiveReset, weekReset})}, start + 31 * minute);
  assert.equal(entries['codex:five'].length, 2, 'first observation after the lead time is kept');
  record(entries, {codex: provider(start + 50 * minute, {fiveReset, weekReset})}, start + 50 * minute);
  assert.equal(entries['codex:five'].length, 2, 'only once per cycle');
  const line = forecast.baseline(entries['codex:five'], {now: start + 2 * hour, window: 'five'})[0];
  assert.equal(line.at, start + 31 * minute);
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

test('recorder and display agree on cycles under cumulative reset drift', () => {
  // 5시간 창 초기화가 스냅샷마다 20분씩 밀려도(직전 대비 흔들림) 한 주기로 본다.
  const start = base, snaps = [0, 1, 2, 3].map(i => {const at = start + 40 * minute + i * hour, reset = start + 5 * hour + i * 20 * minute; return {at, reset, mult: null, end: 'reset', points: [[at, 10 + i * 10], [reset, 90]]};});
  assert.equal(thin(snaps, 'five').length, 4, 'recorder keeps them as one cycle at the interval');
  const lines = forecast.baseline(snaps, {now: start + 4 * hour, window: 'five'});
  assert.equal(lines.length, 1); assert.equal(lines[0].at, snaps[0].at);
});

test('an early reset (usage drop) starts a new cycle and ends the old baseline there', () => {
  const start = base, reset = start + 5 * hour;
  const old = {at: start + 40 * minute, reset, mult: null, end: 'reset', points: [[start + 40 * minute, 30], [reset, 90]]};
  // 주기 첫 1시간 안의 조기 초기화: 새 초기화 시각은 55분만 늦어져 흔들림 범위지만 사용률이 30% → 2%로 줄었다.
  const freshAt = start + 55 * minute, fresh = {at: freshAt, reset: freshAt + 5 * hour, mult: null, end: 'reset', points: [[freshAt, 2], [freshAt + 5 * hour, 40]]};
  assert.equal(due(old, fresh, 'five'), true, 'recorded right away');
  const lines = forecast.baseline([old, fresh], {now: start + 70 * minute, window: 'five'});
  assert.equal(lines.length, 1, 'the new cycle has no baseline before its lead time'); assert.equal(lines[0].past.at(-1).time, fresh.at, 'old baseline stops where the new cycle began');
  assert.equal(lines[0].future.length, 0);
});

test('merging windows keeps the lead snapshot despite the minimum gap', () => {
  const start = base, reset = start + 5 * hour, mk = at => ({at, reset, mult: null, end: 'reset', points: [[at, 10 + (at - start) / minute / 10], [reset, 90]]});
  const a = {'codex:five': [mk(start + 25 * minute)]}, b = {'codex:five': [mk(start + 31 * minute)]};
  const merged = prune(merge(a, b), start + 40 * minute);
  assert.deepEqual(merged['codex:five'].map(s => s.at), [start + 25 * minute, start + 31 * minute]);
  assert.equal(forecast.baseline(merged['codex:five'], {now: start + hour, window: 'five'})[0].at, start + 31 * minute);
});

test('an exhaustion forecast ending before now has only a past part', () => {
  const start = base, reset = start + 5 * hour, snap = {at: start + 40 * minute, reset, mult: null, end: 'exhaustion', points: [[start + 40 * minute, 50], [start + 2 * hour, 100]]};
  const [line] = forecast.baseline([snap], {now: start + 3 * hour, window: 'five'});
  assert.equal(line.future.length, 0); assert.deepEqual(line.past.at(-1), {time: start + 2 * hour, value: 100, y: 100});
});
