'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, series, hash} = require('../src/core.cjs');
const forecast = require('../media/forecast.js');
const {preview} = require('../src/hover.cjs');
const now = Date.now(), minute = 60000, hour = 3600000;
function rows(values = Array.from({length: 61}, (_, i) => 20 + i / 2), extra = {}) {
  return values.map((used, i) => ({v: 1, provider: 'codex', account: hash('forecast'), plan: 'test', time: now - (values.length - 1 - i) * minute, creditBalance: 10000 - i * 50, windows: {five: {used, reset: now + 5 * hour}, week: {used, reset: now + 7 * 24 * hour}}, ...extra}));
}
function predict(records, window = 'five', capacities = [], options) {return forecast.estimate(series(records, 'codex', window, capacities), window, options);}
test('continuous recent average predicts the native 100% limit at a fixed observation-anchored time', () => {
  const source = rows(), before = JSON.stringify(source), value = predict(source);
  assert.equal(value.state, 'predicted'); assert.equal(value.ratePerHour, 30); assert.equal(value.eta, now + 100 * minute); assert.equal(value.coverage, 1);
  assert.equal(forecast.present(value, now).text, '≈1h 40m'); assert.equal(forecast.present(value, now + minute).eta, value.eta);
  assert.equal(JSON.stringify(source), before);
});
test('observed idle intervals stay in the denominator and do not become an active-only forecast', () => {
  const values = Array.from({length: 61}, (_, i) => 20 + Math.min(i, 30));
  const value = predict(rows(values)); assert.equal(value.ratePerHour, 30); assert.equal(value.eta, now + 100 * minute);
});
test('an observation interval crossing the lookback edge contributes only its clipped time and delta', () => {
  const source = rows(Array.from({length: 81}, (_, i) => 10 + i / 2));
  const value = predict(source, 'five', [], {fiveMinutes: 31}); assert.equal(value.coveredMs, 31 * minute); assert.equal(value.ratePerHour, 30);
});
test('forecasts stop at the next reset, including a deadline equal to the projected 100% point', () => {
  const source = rows(); for (const r of source) r.windows.five.reset = now + 100 * minute;
  const value = predict(source); assert.equal(value.state, 'reset-first'); assert.equal(value.eta, null); assert.equal(forecast.present(value, now).text, '초기화 우선');
});
test('exhausted, zero-slope, missing and too-short observations have distinct non-fabricated states', () => {
  assert.equal(predict(rows(Array(61).fill(100))).state, 'exhausted');
  assert.equal(predict(rows(Array(61).fill(20))).state, 'inactive');
  assert.equal(predict(rows([10, 20, 30])).state, 'insufficient');
  const source = rows(); source.at(-1).windows.five = null; assert.equal(predict(source).state, 'missing');
});
test('stale observations, past resets, future records and elapsed predictions never announce a new exhaustion', () => {
  const value = predict(rows()); assert.equal(forecast.present(value, now + 16 * minute).text, '-');
  assert.equal(forecast.present({...value, reset: now}, now).text, '-');
  assert.equal(forecast.present({...value, observedAt: now + minute}, now).text, '-');
  assert.equal(forecast.present({...value, eta: now - 1}, now).text, '-');
});
test('unknown observation gaps are excluded and insufficient coverage suppresses the ETA', () => {
  const source = rows(); for (let i = 10; i < 55; i++) source[i].windows.five = null;
  const value = predict(source); assert.equal(value.state, 'insufficient'); assert.ok(value.coverage < .75);
});
test('a long gap cannot be treated as zero use or spread a large debit over the missing duration', () => {
  const source = rows([10, 20, 30]); source[0].time = now - 3 * hour; source[1].time = now - hour;
  assert.equal(predict(source).state, 'insufficient');
});
test('the interval before a plan or capacity change cannot train the new forecast', () => {
  const source = rows(); for (let i = 0; i < 30; i++) {source[i].plan = 'old'; source[i].windows.five.used = 99;}
  const value = predict(source); assert.equal(value.state, 'predicted'); assert.equal(value.coveredMs, 30 * minute); assert.equal(value.ratePerHour, 30);
  const capacities = [{provider: 'codex', account: source[0].account, plan: 'test', window: 'five', mult: 5, time: source[0].time}, {provider: 'codex', account: source[0].account, plan: 'test', window: 'five', mult: 20, time: source[40].time}];
  assert.equal(predict(rows(), 'five', capacities).coveredMs, 20 * minute);
});
test('a usage decline without a confirmed reset blocks forecast recovery below the previous peak', () => {
  const source = rows(); source[0].windows.five.used = 80;
  assert.equal(predict(source).state, 'recovery');
});
test('confirmed scheduled and early resets start a new denominator and exclude the assumed first debit', () => {
  for (const scheduled of [false, true]) {
    const source = rows(); for (let i = 0; i < 20; i++) {source[i].windows.five.used = 90; source[i].windows.five.reset = scheduled ? source[20].time : now + hour;}
    const value = predict(source); assert.equal(value.state, 'predicted'); assert.equal(value.coveredMs, 40 * minute); assert.equal(value.ratePerHour, 30);
  }
});
test('extra credit debits and retroactive x5/x20 capacity settings cannot change native exhaustion time', () => {
  const source = rows(), account = source[0].account, base = predict(source).eta;
  for (const mult of [1, 5, 20]) assert.equal(predict(source, 'five', [{provider: 'codex', account, plan: 'test', window: 'five', mult, time: source[0].time}]).eta, base);
  const other = source.map(r => ({...r, creditBalance: 0})); assert.equal(predict(other).eta, base);
});
test('weekly and five-hour models are independent; an absent five-hour reading has no weekly fallback', () => {
  const source = rows(); for (const r of source) r.windows.five = null;
  const data = project(source, [], undefined, undefined, (_id, _mine, windows) => forecast.provider(windows));
  assert.equal(data.codex.forecast.five.state, 'missing'); assert.equal(data.codex.forecast.week.state, 'predicted');
  assert.equal(preview(source, {now, projection: data}).summaries[0].forecasts.week.text, '≈1h 40m');
});
test('forecast uses the unthinned observations and produces the same preview deadline without modifying chart values', () => {
  const source = rows(Array.from({length: 5001}, (_, i) => i <= 4940 ? i / 100 : 49.4 + (i - 4940) / 2));
  const data = project(source, [], undefined, undefined, (_id, _mine, windows) => forecast.provider(windows));
  assert.equal(data.codex.forecast.five.eta, predict(source).eta); assert.ok(data.codex.windows.five.length < source.length);
  const mini = preview(source, {now, projection: data}); assert.equal(mini.summaries[0].forecasts.five.eta, data.codex.forecast.five.eta);
  assert.equal(data.codex.windows.five.at(-1).value, 79.4); assert.equal(source.at(-1).windows.five.used, 79.4);
});
test('remaining time uses days/hours above 24h and hours/minutes below it', () => {
  assert.equal(forecast.remaining(25 * hour), '1d 1h'); assert.equal(forecast.remaining(24 * hour - 1), '23h 59m'); assert.equal(forecast.remaining(61 * minute), '1h 1m');
  assert.equal(forecast.remaining(0), '-');
});
test('invalid lookback inputs fall back to bounded defaults without an arbitrary forecast rate', () => {
  assert.equal(forecast.settings({fiveMinutes: -1, weekHours: Infinity}).fiveMinutes, 60);
  assert.equal(forecast.settings({fiveMinutes: -1, weekHours: Infinity}).weekHours, 72);
  const p = predict(rows()); assert.equal(forecast.present({...p, eta: Infinity}, now).text, '-');
});

test('switching accounts starts a fresh forecast sample scope and excludes the previous account block', () => {
  const source = rows(); const account = source[0].account;
  source[30] = {...source[30], account: hash('other')};
  for (let i = 31; i < source.length; i++) source[i].windows.five.used = 35 + (i - 30) / 10;
  const since = forecast.accountStart(source, 'codex', account, now);
  assert.equal(since, source[30].time);
  const value = forecast.estimate(series(source, 'codex', 'five'), 'five', {since});
  assert.equal(value.coveredMs, 29 * minute); assert.ok(Math.abs(value.ratePerHour - 6) < 1e-9);
});

test('forecast trend joins the native last reading to the actual 100% exhaustion endpoint', () => {
  const points = series(rows(), 'codex', 'five'), value = forecast.estimate(points, 'five');
  const trend = forecast.curve(value, points.at(-1), {}, now);
  assert.equal(trend.endKind, 'exhaustion'); assert.equal(trend.points[0].time, now); assert.equal(trend.points[0].y, 50);
  assert.equal(trend.points[1].time, value.eta); assert.equal(trend.points[1].value, 100); assert.equal(trend.points[1].y, 100);
});
test('forecast trend scales x5/x20 base capacity and preserves native quota for unknown multipliers', () => {
  const value = predict(rows()), point = series(rows(), 'codex', 'five').at(-1);
  for (const mult of [5, 20]) {
    const trend = forecast.curve(value, {...point, mult}, {basis: 'base'}, now);
    assert.equal(trend.points[0].y, 50 * mult); assert.equal(trend.points[1].y, 100 * mult);
  }
  const unknown = forecast.curve(value, point, {basis: 'base'}, now); assert.equal(unknown.known, false); assert.equal(unknown.points[1].y, 100);
});
test('cumulative forecast adds only future subscription growth to the existing cumulative amount', () => {
  const value = predict(rows()), point = series(rows(), 'codex', 'five').at(-1);
  const unknown = forecast.curve(value, point, {mode: 'total'}, now);
  assert.equal(unknown.points[0].y, 30); assert.equal(unknown.points[1].y, 80); assert.equal(unknown.known, false);
  for (const basis of ['current', 'base']) {
    const trend = forecast.curve(value, {...point, mult: 5, cumulative: 150, cumulativeKnown: true}, {mode: 'total', basis}, now);
    assert.equal(trend.points[0].y, basis === 'base' ? 150 : 30); assert.equal(trend.points[1].y, basis === 'base' ? 400 : 80);
  }
});
test('native subscription trend never invents future extra-credit debits or a per-observation delta', () => {
  const value = predict(rows()), point = series(rows(), 'codex', 'five').at(-1);
  const trend = forecast.curve(value, point, {credit: true, creditMode: 'estimate'}, now);
  assert.equal(trend.points[0].y, 50); assert.equal(trend.points[1].y, 100);
  assert.equal(forecast.curve(value, point, {mode: 'delta'}, now), null); assert.equal(forecast.present(value, now).state, 'predicted');
});
test('reset-first trends terminate at the declared reset and do not invent post-reset usage', () => {
  const source = rows(); for (const r of source) r.windows.five.reset = now + 30 * minute;
  const points = series(source, 'codex', 'five'), value = forecast.estimate(points, 'five');
  const trend = forecast.curve(value, points.at(-1), {}, now);
  assert.equal(trend.endKind, 'reset'); assert.equal(trend.points[1].time, value.reset); assert.equal(trend.points[1].y, 65);
});
test('forecast trend disappears for stale, incomplete, changed and elapsed snapshots', () => {
  const point = series(rows(), 'codex', 'five').at(-1), value = predict(rows());
  for (const wrong of [{...point, time: now - 1}, {...point, value: 51}, {...point, reset: point.reset + 1000}]) assert.equal(forecast.curve(value, wrong, {}, now), null);
  assert.equal(forecast.curve(value, point, {}, now + 16 * minute), null);
  assert.equal(forecast.curve({...value, state: 'insufficient'}, point, {}, now), null);
});
test('only the visible forecast portion participates in axis expansion when zoomed', () => {
  const chart = require('../media/chart-series.js'), point = series(rows(), 'codex', 'five').at(-1), value = predict(rows());
  const trend = forecast.curve(value, {...point, mult: 20}, {basis: 'base'}, now);
  assert.equal(chart.limits([trend], [now, value.eta], {basis: 'base'}).maximum, 2160);
  const edge = now + (value.eta - now) / 10;
  assert.equal(chart.limits([trend], [now, edge], {basis: 'base'}).maximum, 1188);
});


test('preview exhaustion shows the remaining usable time and preserves the page ETA', () => {
  const value = predict(rows()), first = forecast.summary(value, now), later = forecast.summary(value, now + minute);
  assert.equal(first.label, '사용 가능'); assert.equal(first.text, '≈1h 40m'); assert.equal(first.remainingMs, 100 * minute);
  assert.equal(later.text, '≈1h 39m'); assert.equal(later.eta, first.eta);
  assert.equal(forecast.summary({...value, eta: now + 25 * hour, reset: now + 30 * hour}, now).text, '≈1d 1h');
});
test('preview reset remainder equals the page forecast endpoint for both providers and quota windows', () => {
  const source = ['codex', 'claude'].flatMap(provider => rows().map(r => ({...r, provider, windows: {five: {...r.windows.five, reset: now + 30 * minute}, week: {...r.windows.week, reset: now + 30 * minute}}})));
  const data = project(source, [], undefined, undefined, (_id, _mine, windows) => forecast.provider(windows));
  const mini = preview(source, {now, projection: data});
  for (const [i, id] of ['codex', 'claude'].entries()) for (const w of ['five', 'week']) {
    const result = mini.summaries[i].forecasts[w], trend = forecast.curve(data[id].forecast[w], data[id].windows[w].at(-1), {}, now);
    assert.equal(result.label, '초기화 잔여'); assert.equal(result.text, '≈35%'); assert.equal(result.remainingPercent, 100 - trend.points[1].value);
    assert.equal(forecast.summary(data[id].forecast[w], now + minute).remainingPercent, result.remainingPercent);
  }
});
test('preview tie shows zero remainder while an already exhausted reading shows zero usable time', () => {
  const value = predict(rows());
  const tie = forecast.summary({...value, state: 'reset-first', eta: null, reset: value.eta}, now);
  assert.equal(tie.text, '≈0%'); assert.equal(tie.remainingPercent, 0);
  const full = forecast.summary(predict(rows(Array(61).fill(100))), now);
  assert.equal(full.label, '사용 가능'); assert.equal(full.text, '0h 0m'); assert.equal(full.remainingMs, 0);
});
test('observed zero consumption shows the projected unused quota at reset without inventing an exhaustion', () => {
  const value = predict(rows(Array(61).fill(20))), result = forecast.summary(value, now);
  assert.equal(result.label, '초기화 잔여'); assert.equal(result.text, '≈80%'); assert.equal(result.remainingPercent, 80);
  assert.equal(result.eta, undefined); assert.equal(forecast.present(value, now).state, 'inactive');
});
test('preview cannot derive a reset remainder from stale, invalid or uncertain observations', () => {
  const value = {...predict(rows()), state: 'reset-first', eta: null, reset: now + 30 * minute};
  for (const invalid of [undefined, {...value, state: 'insufficient'}, {...value, state: 'recovery'}, {...value, ratePerHour: null}, {...value, used: -1}, {...value, ratePerHour: Infinity}, {...value, observedAt: now + 1}, {...value, reset: now}]) {
    const result = forecast.summary(invalid, now); assert.equal(result.text, '-'); assert.equal(result.remainingPercent, undefined);
  }
  assert.equal(forecast.summary(value, now + 16 * minute).text, '-');
});
test('tiny positive reset remainders are distinguished from a projected zero', () => {
  const value = {...predict(rows()), state: 'reset-first', eta: null, reset: now + 30 * minute};
  const result = forecast.summary({...value, used: 84.96}, now);
  assert.ok(result.remainingPercent > 0); assert.equal(result.text, '<0.1%');
});
test('preview remainder is subscription-relative regardless of extra credit or x5/x20 capacity and respects OFF', () => {
  const source = rows().map(r => ({...r, windows: {five: {...r.windows.five, reset: now + 30 * minute}, week: r.windows.week}}));
  for (const mult of [1, 5, 20]) {
    const capacities = [{provider: 'codex', account: source[0].account, plan: 'test', window: 'five', mult, time: source[0].time}];
    const data = project(source, capacities, undefined, undefined, (_id, _mine, windows) => forecast.provider(windows));
    const result = preview(source, {now, projection: data}).summaries[0].forecasts.five;
    assert.equal(result.remainingPercent, 35); assert.equal(result.text, '≈35%');
    assert.equal(preview(source, {now, projection: data, forecastEnabled: false}).summaries[0].forecasts, undefined);
  }
});


test('five-hour recent velocity stays responsive while a full-cycle average dilutes a new workload', () => {
  const source = rows(Array.from({length: 241}, (_, i) => 20 + Math.max(0, i - 180) / 2));
  for (const r of source) r.windows.five.reset = now + hour;
  const recent = predict(source, 'five', [], {patternDays: 0}), full = predict(source, 'five', [], {fiveMinutes: 300, patternDays: 0});
  assert.equal(recent.ratePerHour, 30); assert.equal(full.ratePerHour, 7.5);
  assert.equal(recent.sampleStart, now - hour); assert.equal(full.sampleStart, now - 4 * hour);
});
test('weekly default uses three observed days while an explicit 24-hour setting remains supported', () => {
  const source = rows(Array.from({length: 145}, (_, i) => 10 + Math.min(i / 2, 48) / 10 + Math.max(0, i / 2 - 48)));
  for (const [i, r] of source.entries()) {r.time = now - (144 - i) * hour / 2; r.windows.week.reset = now + 96 * hour;}
  const normal = predict(source, 'week', [], {patternDays: 0}), explicit = predict(source, 'week', [], {weekHours: 24, patternDays: 0});
  assert.equal(normal.lookbackMs, 72 * hour); assert.equal(normal.coveredMs, 72 * hour); assert.ok(Math.abs(normal.ratePerHour - .4) < 1e-10);
  assert.equal(explicit.lookbackMs, 24 * hour); assert.ok(Math.abs(explicit.ratePerHour - 1) < 1e-10);
  assert.equal(normal.state, 'reset-first'); assert.equal(explicit.state, 'predicted');
});
