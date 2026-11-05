'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, hash, series} = require('../src/core.cjs');
const forecast = require('../media/forecast.js');
const learning = require('../src/forecast-learning.cjs');
const {PatternBook} = require('../src/pattern-book.cjs');
const fixture = require('./pattern-fixture.cjs');
const minute = 60000, hour = 3600000, now = Date.now();
function incomplete() {
  const start = now - 400 * minute;
  return Array.from({length: 401}, (_, i) => ({v: 1, provider: 'codex', account: hash('quality'), plan: 'one', time: start + i * minute, windows: {five: null, week: {used: i < 181 ? 0 : i < 241 ? 6 : i < 301 ? 7 : i < 361 ? 8 : 9, reset: now + 7 * 24 * hour}}})).filter((_row, i) => i <= 120 || i >= 181);
}
test('time coverage alone cannot legitimize a rate missing most of the observed quota increase', () => {
  const records = incomplete(), provider = project(records).codex, before = JSON.stringify(provider);
  const result = forecast.estimate(provider.windows.week, 'week');
  assert.ok(result.coverage > .75); assert.equal(result.observedGrowth, 3); assert.equal(result.netGrowth, 9);
  assert.equal(result.consumptionCoverage, 1 / 3); assert.equal(result.state, 'insufficient'); assert.equal(result.reason, 'unobserved-growth'); assert.equal(result.eta, null);
  assert.equal(JSON.stringify(provider), before); assert.equal(provider.windows.week.at(-1).nativeCumulative, 3, 'missing consumption is not imputed into source totals');
});
test('reliable historical profiles replace a biased recent rate without losing the actual curve endpoint', () => {
  const past = fixture.records(now).slice(0, -3).map(row => ({...row, account: hash('quality'), plan: 'one'}));
  const records = [...past, ...incomplete()].sort((a, b) => a.time - b.time), points = project(records).codex.windows.week;
  const value = forecast.estimate(points, 'week'); assert.equal(value.reason, 'unobserved-growth'); assert.ok(value.trajectory?.length > 1); assert.equal(value.ratePerHour, null);
  const curve = forecast.curve(value, points.at(-1), {}, points.at(-1).time); assert.ok(curve); assert.equal(curve.points[0].y, points.at(-1).value);
  assert.equal(curve.points.at(-1).time, value.eta ?? value.reset);
  const recentPolicy = forecast.estimate(points, 'week', {method: 'recent'}); assert.ok(recentPolicy.trajectory, 'a selected recent policy also rejects its biased scalar');
  const idleHistory = points.map(point => point.time < incomplete()[0].time ? {...point, value: 0, delta: 0} : point);
  for (const method of ['seasonal', 'historical', 'activity']) {
    const unsupported = forecast.estimate(idleHistory, 'week', {method});
    assert.equal(unsupported.state, 'insufficient'); assert.equal(unsupported.trajectory, undefined, 'past idle-only samples cannot explain missing positive consumption');
  }
});
test('historical quarterly archive actually preserves pattern learning after its raw records leave the visible store', () => {
  const rows = fixture.records(now), full = project(rows).codex, recentRows = rows.slice(-3), recent = project(recentRows).codex;
  const book = new PatternBook('unused'); book.configure([], 90); book.update('codex', rows, full.windows);
  const archive = book.older('codex', rows[0].account, 'five', recent.windows.five.at(-1), recentRows[0].time);
  const without = forecast.estimate(recent.windows.five, 'five'), withArchive = forecast.estimate(recent.windows.five, 'five', {archiveCells: archive});
  assert.equal(without.pattern, undefined); assert.ok(withArchive.pattern); assert.ok(archive.length);
  assert.ok(Math.abs(withArchive.eta - forecast.estimate(full.windows.five, 'five').eta) < 1);
});
test('calendar/activity forecasts learn work persistence and observed rest rather than spreading current activity across every future hour', () => {
  const points = fixture.points(now), value = forecast.estimate(points, 'five', {method: 'activity'});
  assert.equal(value.pattern.policy, 'calendar-activity'); assert.ok(value.trajectory.length > 3);
  const slopes = value.trajectory.slice(1).map((p, i) => (p.value - value.trajectory[i].value) / (p.time - value.trajectory[i].time));
  assert.ok(Math.max(...slopes) > Math.min(...slopes) * 1.5);
  assert.equal(forecast.estimate(points, 'five', {patternDays: 0, method: 'activity'}).pattern, undefined);
});
test('learned methods require separate chronological validation and residual bands require sufficient observed dates', () => {
  const points = fixture.points(now), model = learning.calibrate(points, 'five', forecast.settings());
  assert.equal(model.method, 'seasonal'); assert.equal(model.validated, false); assert.equal(model.errors.length, 0);
  assert.ok(model.evaluatedThrough <= points.at(-1).time);
  const packed = learning.pack(points), restored = learning.unpack(packed);
  assert.equal(restored.length, points.length); assert.deepEqual(restored.map(p => [p.time, p.value, p.delta, p.plan, p.mult]), points.map(p => [p.time, p.value, p.delta, p.plan, p.mult]));
});
test('repeatable multi-day work/rest patterns can adopt a model only when it improves both chronological partitions', () => {
  const start = Math.floor((now - 18 * 24 * hour) / (24 * hour)) * 24 * hour, rows = [];
  let used = 0;
  for (let i = 0; i <= 18 * 24 * 6; i++) {
    const time = start + i * 10 * minute, inCycle = i % (7 * 24 * 6), localHour = (Math.floor(time / hour) + 9) % 24;
    if (inCycle === 0) used = 0; else if (localHour >= 9 && localHour < 17) used += 1 / 6;
    rows.push({v: 1, provider: 'codex', account: hash('scheduled'), plan: 'one', time, windows: {five: null, week: {used, reset: start + (Math.floor(i / (7 * 24 * 6)) + 1) * 7 * 24 * hour}}});
  }
  const model = learning.calibrate(series(rows, 'codex', 'week'), 'week', forecast.settings());
  assert.equal(model.validated, true); const chosen = model.train.find(row => row.method === model.method), baseline = model.train[0];
  assert.ok(chosen.mae <= baseline.mae * .95); assert.ok(chosen.validationMae <= baseline.validationMae * .95);
  assert.ok(model.evaluatedThrough <= rows.at(-1).time); assert.ok(model.errors.length);
});
test('empirical error ranges preserve units, stop at validated horizons and never become confidence claims or extra-credit forecasts', () => {
  const points = fixture.points(now), value = forecast.estimate(points, 'five');
  value.calibration = {errors: [{hours: 1, samples: 10, dates: 3, low: -8, high: 12}]};
  for (const mode of ['usage', 'total']) for (const basis of ['current', 'base']) {
    const last = {...points.at(-1), mult: 5, cumulative: 250, cumulativeKnown: true, nativeCumulative: 50};
    const curve = forecast.curve(value, last, {mode, basis, credit: true}, last.time);
    assert.ok(curve.range.length >= 2); assert.equal(curve.range[0].low, curve.points[0].y); assert.equal(curve.range[0].high, curve.points[0].y);
    assert.ok(curve.range.every(p => p.low <= p.high)); assert.equal(curve.range.at(-1).time, last.time + hour);
  }
  value.calibration.errors[0].samples = 2; assert.equal(forecast.curve(value, points.at(-1), {}, points.at(-1).time).range.length, 0);
});
test('background model fitting supports cancellation without leaving a process or modifying original points', async () => {
  const points = fixture.points(now), before = JSON.stringify(points), input = {key: 'x', observedAt: now, config: forecast.settings(), providers: {codex: {windows: {five: learning.pack(points)}}}};
  const controller = new AbortController(); controller.abort();
  await assert.rejects(learning.fitWorker(input, {signal: controller.signal}), /cancelled/);
  assert.equal(JSON.stringify(points), before);
});
test('refitting one quota scope preserves a still-valid model for another scope instead of replacing it with an empty model', () => {
  const prior = {method: 'historical', scopeKey: 'old-valid', samples: 20, errors: []};
  const result = learning.fit({key: 'new', observedAt: now, config: forecast.settings(), providers: {codex: {windows: {five: {...learning.pack(fixture.points(now)), scopeKey: 'new-scope'}, week: {data: new Float64Array(0), plans: [], scopeKey: 'old-valid', priorModel: prior}}}}});
  assert.deepEqual(result.providers.codex.week, prior); assert.equal(result.providers.codex.five.scopeKey, 'new-scope');
});

test('forecast error bounds cannot imply refunds and only expand outward to respect monotone consumption', () => {
  const last = {time: now, value: 60, reset: now + 5 * hour, mult: 5, cumulative: 800, cumulativeKnown: true, nativeCumulative: 160};
  const value = {state: 'reset-first', observedAt: now, reset: last.reset, used: 60, staleAfterMs: 15 * minute, ratePerHour: 1, calibration: {errors: [{hours: 1, samples: 10, dates: 3, low: -15, high: 15}, {hours: 3, samples: 10, dates: 3, low: -30, high: 2}]}};
  const original = JSON.stringify({last, value});
  for (const mode of ['usage', 'total']) for (const basis of ['current', 'base']) for (const known of [true, false]) {
    const point = {...last, cumulativeKnown: known}, curve = forecast.curve(value, point, {mode, basis}, now);
    const factor = basis === 'base' && (mode !== 'total' || known) ? 5 : 1, start = mode === 'total' ? known ? 800 / (basis === 'base' ? 1 : 5) : 160 : 60 * factor;
    assert.deepEqual(curve.range.map(p => [p.low, p.high]), [[start, start], [start, start + 16 * factor], [start, start + 16 * factor]]);
    assert.equal(curve.range.at(-1).time, now + 3 * hour, 'do not extend beyond measured error horizons');
    assert.equal(curve.points.at(-1).time, last.reset, 'the central forecast still stops at reset');
    assert.equal(curve.points.at(-1).y, start + 5 * factor, 'neither center line nor ETA is changed');
  }
  assert.equal(JSON.stringify({last, value}), original, 'render bounds do not modify observations or calibration residuals');
});

test('a future lower bound is relaxed backwards rather than narrowing the empirical range', () => {
  const last = {time: now, value: 20, reset: now + 5 * hour, mult: 1};
  const value = {state: 'reset-first', observedAt: now, reset: last.reset, used: 20, staleAfterMs: 15 * minute, ratePerHour: 10, calibration: {errors: [{hours: 1, samples: 10, dates: 3, low: -1, high: 20}, {hours: 3, samples: 10, dates: 3, low: -30, high: 1}]}};
  const curve = forecast.curve(value, last, {}, now);
  assert.deepEqual(curve.range.map(p => [p.low, p.high]), [[20, 20], [20, 50], [20, 51]]);
  assert.ok(curve.range[1].low < 29, 'a running maximum on lower bounds would falsely shrink the later error range');
});

test('monotone error envelopes contain piecewise work/rest forecasts and stop before reset or exhaustion', () => {
  for (const exhausted of [false, true]) {
    const used = exhausted ? 90 : 35, end = now + 3 * hour, reset = exhausted ? end + hour : end;
    const last = {time: now, value: used, reset, mult: 20, cumulative: 1200, cumulativeKnown: true};
    const trajectory = [{time: now, value: used}, {time: now + hour / 2, value: used}, {time: now + hour, value: used + 2}, {time: now + 2 * hour, value: used + 2}, {time: end, value: exhausted ? 100 : 60}];
    const value = {state: exhausted ? 'predicted' : 'reset-first', eta: exhausted ? end : null, observedAt: now, reset, used, trajectory, staleAfterMs: 15 * minute, calibration: {errors: [{hours: 1, samples: 12, dates: 4, low: -8, high: 10}, {hours: 3, samples: 12, dates: 4, low: -25, high: 2}, {hours: 6, samples: 12, dates: 4, low: -40, high: 1}]}};
    for (const mode of ['usage', 'total']) for (const basis of ['current', 'base']) {
      const curve = forecast.curve(value, last, {mode, basis}, now);
      const factor = basis === 'base' ? 20 : 1, floor = curve.points[0].y, cap = floor + (100 - used) * factor;
      assert.equal(curve.range.at(-1).time, end);
      for (let i = 0; i < curve.range.length; i++) {
        const p = curve.range[i], center = curve.points.find(q => q.time === p.time).y;
        assert.ok(p.low >= floor && p.low <= center && p.high >= center && p.high <= cap);
        if (i) {assert.ok(p.low >= curve.range[i - 1].low); assert.ok(p.high >= curve.range[i - 1].high);}
      }
      assert.equal(curve.endKind, exhausted ? 'exhaustion' : 'reset');
    }
  }
});

test('invalid or unverified error horizons cannot displace the observed anchor or create a forecast band', () => {
  const last = {time: now, value: 50, reset: now + 3 * hour, mult: 1};
  const value = {state: 'reset-first', observedAt: now, reset: last.reset, used: 50, staleAfterMs: 15 * minute, ratePerHour: 1, calibration: {errors: [
      {hours: 0, samples: 10, dates: 3, low: -5, high: 8}
    , {hours: -1, samples: 10, dates: 3, low: -5, high: 8}
    , {hours: 1, samples: 10, dates: 3, low: 5, high: -8}
    , {hours: 1, samples: 2, dates: 3, low: -5, high: 8}
    , {hours: 1, samples: 10, dates: 1, low: -5, high: 8}
    , {hours: 1, samples: 10, dates: 3, low: NaN, high: 8}
  ]}};
  assert.deepEqual(forecast.curve(value, last, {}, now).range, []);
});
