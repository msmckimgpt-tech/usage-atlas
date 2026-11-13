'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {project} = require('../src/core.cjs');
const forecast = require('../media/forecast.js');
const {preview} = require('../src/hover.cjs');
const fixture = require('./pattern-fixture.cjs');
const hour = 3600000, now = Date.parse('2026-09-21T11:00:00+09:00');
function history(days, scale = 1) {
  return days.flatMap(day => fixture.records(now).slice(0, 11).map(r => {
    const shift = (14 - day) * 24 * hour;
    const windows = Object.fromEntries(['five', 'week'].map(w => [w, {used: r.windows[w].used * scale, reset: r.windows[w].reset + shift}]));
    return {...r, time: r.time + shift, windows};
  }));
}
function tiered(days, scale = 1, extra = []) {
  const source = [...history(days, scale), ...extra, ...fixture.records(now).slice(-3)].sort((a, b) => a.time - b.time);
  return project(source, [], undefined, undefined, (_id, _mine, windows) => forecast.provider(windows));
}
test('default 21-day weekday/hour correction combines recent and observed historical rates equally', () => {
  const input = fixture.points(now), before = JSON.stringify(input), value = forecast.estimate(input, 'five');
  assert.equal(value.pattern.days, 21); assert.equal(value.pattern.timeZone, 'Asia/Seoul'); assert.equal(value.pattern.weight, .5);
  assert.equal(value.ratePerHour, 20); assert.equal(value.eta, now + 3.5 * hour);
  assert.deepEqual(value.trajectory.map(p => [p.time - now, p.value]), [[0, 50], [hour, 60], [2 * hour, 80], [3 * hour, 90], [3.5 * hour, 100]]);
  assert.equal(JSON.stringify(input), before);
});
test('configured period and zero-disable control learning without fabricating absent weekly patterns', () => {
  const input = fixture.points(now);
  for (const patternDays of [0, 7, 13]) {
    const value = forecast.estimate(input, 'five', {patternDays}); assert.equal(value.pattern, undefined); assert.equal(value.eta, now + 2.5 * hour);
  }
  assert.equal(forecast.estimate(input, 'five', {patternDays: 14}).eta, now + 3.5 * hour);
  assert.equal(forecast.settings({patternDays: -1, timeZone: 'not/a-zone'}).patternDays, 21);
  assert.equal(forecast.settings({patternDays: 21.5}).patternDays, 21);
  assert.equal(forecast.settings({timeZone: 'not/a-zone'}).timeZone, 'Asia/Seoul');
});
test('two separate dates and a full observed hour per weekday/hour are required', () => {
  const input = fixture.points(now), short = input.filter(p => p.time >= now - hour || (p.time % hour) === 0);
  for (const p of short) if (p.time < now - hour) p.continuous = false;
  assert.equal(forecast.estimate(short, 'five').pattern, undefined);
  const missing = input.map(p => p.time < now - hour ? {...p, continuous: false} : p);
  assert.equal(forecast.estimate(missing, 'five').pattern, undefined);
});
test('past plans, capacity changes and an account boundary cannot train the current pattern', () => {
  const input = fixture.points(now);
  for (const change of [{plan: 'other'}, {mult: 5}]) {
    const mixed = input.map(p => p.time < now - hour ? {...p, ...change} : p);
    assert.equal(forecast.estimate(mixed, 'five').pattern, undefined);
  }
  assert.equal(forecast.estimate(input, 'five', {since: now - 2 * 24 * hour}).pattern, undefined);
});
test('unobserved reset debits, recovery and exhausted plateaus never become historical working or idle samples', () => {
  const input = fixture.points(now);
  for (const change of [{estimatedDelta: true}, {recoveryExcluded: 1}, {value: 100}, {event: {kind: 'early-reset'}}]) {
    const invalid = input.map(p => p.time < now - hour ? {...p, ...change} : p);
    assert.equal(forecast.estimate(invalid, 'five').pattern, undefined);
  }
  const recovery = input.map(p => p.time < now - hour ? {...p, value: p.value === 0 ? 99 : 20, delta: 0} : p);
  assert.equal(forecast.estimate(recovery, 'five').pattern, undefined);
});
test('missing future weekday/hour evidence falls back to the recent rate instead of zero activity', () => {
  const input = fixture.points(now), value = forecast.estimate(input.filter(p => p.time >= now - hour || p.time <= now - 7 * 24 * hour + hour), 'five');
  assert.ok(value.pattern); assert.ok(value.trajectory.at(-1).value === 100);
  assert.equal(value.eta, now + 3 * hour);
});
test('reset-first preview remainder exactly matches the corrected piecewise page endpoint for both providers/windows', () => {
  const input = ['codex', 'claude'].flatMap(id => fixture.records(now, id, 3));
  const data = project(input, [], undefined, undefined, (_id, _mine, windows) => forecast.provider(windows));
  const mini = preview(input, {now, projection: data});
  for (const [i, id] of ['codex', 'claude'].entries()) for (const w of ['five', 'week']) {
    const value = data[id].forecast[w], curve = forecast.curve(value, data[id].windows[w].at(-1), {}, now);
    assert.equal(value.state, 'reset-first'); assert.ok(curve.points.length > 2);
    assert.equal(mini.summaries[i].forecasts[w].remainingPercent, 100 - curve.points.at(-1).value);
    assert.equal(mini.summaries[i].forecasts[w].text, '≈10%');
  }
});
test('corrected curves share ETA across base, cumulative and credit displays; delta never invents a future interval', () => {
  const input = fixture.points(now), value = forecast.estimate(input, 'five'), last = {...input.at(-1), mult: 5, cumulative: 250, cumulativeKnown: true};
  for (const mode of ['usage', 'total']) for (const basis of ['current', 'base']) {
    const curve = forecast.curve(value, last, {mode, basis, credit: true, creditMode: 'estimate'}, now);
    assert.equal(curve.points.at(-1).time, value.eta); assert.equal(curve.points.at(-1).y, basis === 'base' ? 500 : 100);
  }
  assert.equal(forecast.curve(value, last, {mode: 'delta'}, now), null);
  assert.equal(forecast.curve(value, last, {}, now + 16 * 60000), null);
});
test('observed idle time blends history while an insufficient recent reading uses qualified history only', () => {
  const input = fixture.points(now), idle = input.map(p => p.time >= now - hour ? {...p, value: 30, delta: p.continuous ? 0 : p.delta} : p);
  const value = forecast.estimate(idle, 'five'); assert.ok(value.pattern); assert.equal(value.ratePerHour, 0);
  assert.ok(forecast.curve(value, idle.at(-1), {}, now));
  const short = input.slice(0, -1); short.at(-1).continuous = false;
  const fallback = forecast.estimate(short, 'five');
  assert.equal(fallback.pattern.weight, 1); assert.equal(fallback.ratePerHour, null);
  const curve = forecast.curve(fallback, short.at(-1), {}, short.at(-1).time);
  assert.equal(curve.points[0].y, short.at(-1).value);
});
test('explicit pattern timezone supports fractional UTC offsets', () => {
  const input = fixture.points(now);
  for (const timeZone of ['Asia/Seoul', 'Asia/Kathmandu', 'America/New_York']) {
    const value = forecast.estimate(input, 'five', {timeZone}); assert.equal(value.pattern.timeZone, timeZone);
    assert.ok(value.trajectory.length > 2);
  }
});
test('host timezone does not change weekday pattern, ETA or trajectory', async () => {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  const code = "const f=require('./media/forecast.js'),p=require('./test/pattern-fixture.cjs').points(); console.log(JSON.stringify(f.estimate(p,'five')))";
  const results = await Promise.all(['UTC', 'Asia/Seoul', 'America/Los_Angeles'].map(TZ => run(process.execPath, ['-e', code], {cwd: require('node:path').resolve(__dirname, '..'), env: {...process.env, TZ}, windowsHide: true})));
  assert.equal(results[0].stdout, results[1].stdout); assert.equal(results[1].stdout, results[2].stdout);
});
test('fewer than seven days can learn same weekday class instead of returning a straight recent-average extension', () => {
  const value = tiered([4, 3]).codex.forecast.five;
  assert.ok(value.pattern); assert.equal(value.pattern.policy, 'weekday-daytype-hour');
  assert.equal(value.eta, now + 3.5 * hour); assert.ok(value.trajectory.length > 2);
  assert.equal(value.pattern.tierMatchedMs.weekday, 0); assert.equal(value.pattern.tierMatchedMs.hour, 0);
  assert.equal(value.pattern.tierMatchedMs.dayType, 3.5 * hour);
});
test('matching weekday evidence takes priority over a different pooled weekday rate', () => {
  const value = tiered([14, 7], 1, history([4, 3], 0)).codex.forecast.five;
  assert.equal(value.eta, now + 3.5 * hour); assert.equal(value.pattern.tierMatchedMs.weekday, 3.5 * hour);
  assert.equal(value.pattern.tierMatchedMs.dayType, 0); assert.equal(value.pattern.tierMatchedMs.hour, 0);
});
test('weekday class evidence takes priority over mixed weekend and weekday hours', () => {
  const value = tiered([4, 3], 1, history([2, 1], 1.5)).codex.forecast.five;
  assert.equal(value.eta, now + 3.5 * hour); assert.equal(value.pattern.tierMatchedMs.dayType, 3.5 * hour);
  assert.equal(value.pattern.tierMatchedMs.hour, 0);
});
test('all-date same-hour evidence is used only when the target weekday class is insufficient', () => {
  const value = tiered([2, 1]).codex.forecast.five;
  assert.equal(value.eta, now + 3.5 * hour); assert.equal(value.pattern.tierMatchedMs.hour, 3.5 * hour);
  assert.equal(value.pattern.tierMatchedMs.weekday, 0); assert.equal(value.pattern.tierMatchedMs.dayType, 0);
});
test('a single observed date still cannot train a pooled hour; unavailable hours keep the recent rate', () => {
  const value = tiered([3]).codex.forecast.five;
  assert.equal(value.pattern, undefined); assert.equal(value.eta, now + 2.5 * hour);
});
test('observed zero historical use remains valid at the broadest tier and agrees with reset remainder', () => {
  const source = [...history([2, 1], 0), ...fixture.records(now, 'codex', 3).slice(-3)].sort((a, b) => a.time - b.time);
  const data = project(source, [], undefined, undefined, (_id, _mine, windows) => forecast.provider(windows));
  const value = data.codex.forecast.five, curve = forecast.curve(value, data.codex.windows.five.at(-1), {}, now);
  assert.equal(value.pattern.tierMatchedMs.hour, 3 * hour); assert.equal(value.state, 'reset-first');
  assert.equal(curve.points.at(-1).value, 80); assert.equal(preview(source, {now, projection: data}).summaries[0].forecasts.five.text, '≈20%');
});


test('a reset-shortened recent window excludes only its actual samples from multi-day pattern training', () => {
  const source = [...history([2, 1]), ...fixture.records(now).slice(-3)].sort((a, b) => a.time - b.time);
  const data = project(source, [], undefined, undefined, (_id, _mine, windows) => forecast.provider(windows, {weekHours: 168}));
  const value = data.codex.forecast.week;
  assert.equal(value.lookbackMs, 168 * hour); assert.equal(value.sampleStart, now - hour); assert.equal(value.coveredMs, hour);
  assert.ok(value.pattern); assert.equal(value.pattern.observedMs, 10 * hour); assert.equal(value.eta, now + 3.5 * hour);
  assert.equal(value.trajectory[0].time, now); assert.equal(value.trajectory[0].value, 50);
});
