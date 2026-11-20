'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, hash} = require('../src/core.cjs');
const forecast = require('../media/forecast.js');
const chart = require('../media/chart-series.js');
const minute = 60000, hour = 60 * minute, now = Date.parse('2026-11-21T01:00:00+09:00');
const id = 'antigravity-5d72436256ada538';
// 실제 Antigravity 주간 한도처럼 꾸준히 오르되 1%p 미만으로 자주 되돌아가는 기록을 만든다.
function jitter(provider = id) {
  return Array.from({length: 240}, (_, i) => {
    const base = 10 + i * .03, used = i % 7 === 3 ? base - .5 : base;
    return {v: 1, provider, account: hash('denoise-fixture'), plan: 'one', label: 'Gemini', time: now - (239 - i) * 5 * minute, windows: {five: {used: Math.min(100, (i % 60) * .5), reset: now + 2 * hour}, week: {used, reset: now + 5 * 24 * hour}}};
  });
}
const options = {fiveMinutes: 60, weekHours: 72, patternDays: 0, intervalSeconds: 300};
test('sub-point Antigravity jitter no longer blocks the weekly forecast and its line starts at the raw last observation', () => {
  const rows = jitter();
  rows.at(-1).windows.week.used -= .4;
  const windows = project(rows, [], 3600000)[id].windows;
  const raw = forecast.provider(windows, options).week;
  assert.ok(['recovery', 'insufficient'].includes(raw.state), raw.state);
  const denoised = {five: forecast.denoise(windows.five), week: forecast.denoise(windows.week)};
  const value = forecast.provider(denoised, options).week;
  assert.ok(['predicted', 'reset-first'].includes(value.state), value.state);
  assert.ok(value.ratePerHour > 0);
  const last = windows.week.at(-1);
  assert.equal(value.observedValue, last.value);
  const line = forecast.curve(value, last, {}, last.time + minute);
  assert.ok(line, 'curve');
  assert.equal(line.points[0].y, last.value);
  assert.ok(line.points.every((p, i) => i === 0 || p.y >= line.points[i - 1].y));
});
test('denoise keeps large corrections, resets, plan changes and collection gaps as boundaries', () => {
  const base = {plan: 'one', mult: null, reset: 10 * hour, totalContinuous: true, continuous: true, delta: 0};
  const points = [
      {...base, time: 0, value: 10}
    , {...base, time: minute, value: 9.6, continuous: false, delta: null, event: {kind: 'decrease'}}
    , {...base, time: 2 * minute, value: 8, continuous: false, delta: null, event: {kind: 'decrease'}}
    , {...base, time: 3 * minute, value: 8.5, delta: .5}
    , {...base, time: 4 * minute, value: 8.2, continuous: false, delta: null, totalContinuous: false}
    , {...base, time: 5 * minute, value: 9, plan: 'two', continuous: false, delta: null}
    , {...base, time: 6 * minute, value: 1, reset: 20 * hour, continuous: false, delta: 1, event: {kind: 'scheduled-reset'}}
  ];
  const out = forecast.denoise(points);
  assert.deepEqual(out.map(p => p.value), [10, 10, 8, 8.5, 8.2, 9, 1]);
  assert.equal(out[1].rawValue, 9.6); assert.equal(out[1].continuous, true); assert.equal(out[1].delta, 0); assert.equal(out[1].event, undefined);
  assert.equal(out[2], points[2]);
  assert.equal(out[4], points[4]);
  assert.equal(out[5], points[5]);
  assert.equal(out[6], points[6]);
  assert.equal(forecast.denoise(points, 0), points);
});
test('a reading taken seconds after the nominal reset that still reports the old cycle stays on the usage line', () => {
  const reset = now, rows = [0, 1, 2].map(i => ({v: 1, provider: 'claude', account: hash('tail'), plan: 'max', time: reset - 2 * minute + i * 61000, windows: {five: {used: 16, reset}, week: {used: 5, reset: reset + 3 * 24 * hour}}}));
  rows.push({...rows[2], time: reset + 120000, windows: {five: {used: 0, reset: reset + 5 * hour}, week: {used: 5, reset: reset + 3 * 24 * hour}}});
  const provider = project(rows, [], 3600000).claude;
  const tail = provider.windows.five.find(p => p.time === rows[2].time);
  assert.ok(tail.time > reset); assert.equal(tail.continuous, false);
  const usage = chart.quota(provider, 'claude', 'five', {mode: 'usage'})[0].points;
  assert.equal(usage.find(p => p.time === rows[2].time).continuous, true);
  assert.equal(usage.find(p => p.time === rows[3].time).continuous, false);
  const delta = chart.quota(provider, 'claude', 'five', {mode: 'delta'})[0].points;
  assert.equal(delta.find(p => p.time === rows[2].time).continuous, false);
  const late = [...rows.slice(0, 2), {...rows[2], time: reset + 10 * minute}];
  const lateLine = chart.quota(project(late, [], 3600000).claude, 'claude', 'five', {mode: 'usage'})[0].points;
  assert.equal(lateLine.at(-1).continuous, false);
});
