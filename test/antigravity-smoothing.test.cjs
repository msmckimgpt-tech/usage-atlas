'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, hash, series, thin} = require('../src/core.cjs');
const chart = require('../media/chart-series.js');
const forecast = require('../media/forecast.js');
const {preview} = require('../src/hover.cjs');
const now = Date.parse('2026-11-16T12:00:00+09:00'), minute = 60000, id = 'antigravity-5d72436256ada538';
function records(provider = id) {
  return Array.from({length: 121}, (_, i) => ({v: 1, provider, account: hash('display-fixture'), plan: 'one', label: 'Gemini', time: now - (120 - i) * minute, windows: {five: {used: 20 + i * .1 + (i % 2 ? .4 : 0), reset: now + 3 * 3600000}, week: {used: 40 + i * .1 + (i % 2 ? .4 : 0), reset: now + 4 * 86400000}}}));
}
test('AGY usage stabilization joins tiny corrections and preserves the latest reading, source and forecast', () => {
  const source = records(), data = project(source)[id], before = JSON.stringify(data), value = forecast.estimate(data.windows.week, 'week'), raw = chart.quota(data, id, 'week', {antigravitySmoothingMinutes: 0})[0];
  const line = chart.quota(data, id, 'week')[0];
  assert.ok(raw.points.filter(p => !p.continuous).length > 50);
  assert.equal(line.points.filter(p => !p.continuous).length, 1);
  assert.equal(line.points[0].y, raw.points[0].y); assert.equal(line.points.at(-1).y, raw.points.at(-1).y);
  assert.ok(line.points.some(p => p.estimated && p.y !== p.rawValue));
  assert.equal(chart.events(data, id).length, 0); assert.ok(chart.events(data, id, {antigravitySmoothingMinutes: 0}).length > 50);
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(forecast.estimate(data.windows.week, 'week'), value);
  assert.equal(line.points.at(-1).value, value.used);
});
test('the centered mean is time-weighted, bounded and deterministic on irregular observation intervals', () => {
  const points = [0, .8, 0, .8, 0].map((value, i) => ({time: i * minute, value, displayCycle: 0, plan: 'one', mult: 1, reset: 3600000, continuous: true, totalContinuous: true}));
  const before = JSON.stringify(points), out = chart.stabilize(points, 3);
  assert.ok(Math.abs(out[1].value - .36) < 1e-10); assert.ok(Math.abs(out[2].value - 1050 / 180 * .08) < 1e-10);
  assert.equal(out[0].value, 0); assert.equal(out.at(-1).value, 0);
  assert.ok(out.every(p => p.value >= 0 && p.value <= .8));
  const irregular = [points[0], {...points[1], time: 30 * 1000}, points[2], points[3], points[4]];
  assert.notDeepEqual(chart.stabilize(irregular, 3).map(p => p.value), out.map(p => p.value));
  assert.equal(JSON.stringify(points), before);
  for (const value of [NaN, Infinity, -1, 61, null]) assert.equal(chart.smoothing(value), 5);
  assert.equal(chart.stabilize(points, 0), points);
});
test('reset, capacity, plan and large correction boundaries remain disconnected, including thinned hidden resets', () => {
  const source = records();
  for (let i = 60; i < source.length; i++) source[i].windows.five = {used: (i - 60) * .1, reset: now + 5 * 3600000};
  const data = project(source)[id], line = chart.quota(data, id, 'five')[0], start = line.points[60], end = line.points[59];
  assert.equal(start.continuous, false); assert.equal(start.y, 0); assert.equal(end.y, source[59].windows.five.used);
  assert.notEqual(start.gapContext, end.gapContext);
  assert.ok(chart.events(data, id).some(e => e.kind === 'early-reset'));
  const compressed = thin(series(source, id, 'five'), 12), a = compressed.findLast(p => p.time < source[60].time), b = compressed.find(p => p.time >= source[60].time);
  assert.notEqual(a.displayCycle, b.displayCycle);
  assert.equal(chart.stabilize([a, b])[1].displayContinuous, false);
  for (const mutation of [p => ({...p, plan: 'two'}), p => ({...p, mult: 5}), p => ({...p, value: p.value - 2})]) {
    const points = series(records(), id, 'week').slice(0, 3); points[2] = mutation(points[2]);
    assert.equal(chart.stabilize(points)[2].displayContinuous, false);
  }
});
test('missing data and long gaps stay outside the smoothing window and retain separate estimated bridges', () => {
  const points = series(records(), id, 'week').slice(0, 5);
  points[2] = {...points[2], value: null, totalContinuous: false}; points[3] = {...points[3], totalContinuous: false};
  const stable = chart.stabilize(points);
  assert.equal(stable[2].value, null); assert.equal(stable[3].displayContinuous, false);
  assert.equal(stable[1].value, points[1].value); assert.equal(stable[3].value, points[3].value);
  const provider = {windows: {week: points}}, line = chart.quota(provider, id, 'week')[0];
  assert.equal(require('../media/gaps.js').bridges(line.points, 'y').length, 1);
  // 수집 공백 판단은 core가 설정한 최대 간격으로 계산한 totalContinuous를 따른다.
  const long = [{...points[0]}, {...points[1], time: points[0].time + 3600000, totalContinuous: false}];
  assert.equal(chart.stabilize(long)[1].displayContinuous, false);
  const idle = [{...points[0]}, {...points[1], time: points[0].time + 37 * minute, totalContinuous: true}];
  assert.equal(chart.stabilize(idle)[1].displayContinuous, true);
  const legacy = [{...points[0]}, {...points[1], time: points[0].time + 3600000, totalContinuous: undefined}];
  assert.equal(chart.stabilize(legacy)[1].displayContinuous, false);
});
test('returning to an account cannot smooth across the other account interval', () => {
  const source = records(); source[60] = {...source[60], account: hash('other-account')};
  const points = project(source)[id].windows.week, line = chart.stabilize(points), index = line.findIndex(p => p.time === source[61].time);
  assert.notEqual(line[index].displayCycle, line[index - 1].displayCycle);
  assert.equal(line[index].displayContinuous, false); assert.equal(line[index].value, source[61].windows.week.used);
});
test('other services, delta and cumulative outputs and native credit behavior are untouched', () => {
  for (const provider of [id, 'codex', 'claude']) {
    const data = project(records(provider))[provider];
    for (const mode of ['delta', 'total', ...(provider === id ? [] : ['usage'])]) {
      assert.deepEqual(chart.quota(data, provider, 'week', {mode}), chart.quota(data, provider, 'week', {mode, antigravitySmoothingMinutes: 0}));
      assert.deepEqual(chart.events(data, provider, {mode}), data.events);
    }
  }
});
test('preview uses the same stable usage coordinates and exact last summary as the page', () => {
  const source = records(), data = project(source), before = JSON.stringify(data);
  const raw = preview(source, {now, projection: data, antigravitySmoothingMinutes: 0}), stable = preview(source, {now, projection: data});
  const chartPath = svg => svg.match(new RegExp('<g[^>]*data-series="' + id + '-week"[^>]*><path d="([^"]*)"'))[1];
  assert.ok((chartPath(raw.svg).match(/M/g) || []).length > 50);
  assert.equal((chartPath(stable.svg).match(/M/g) || []).length, 1);
  assert.deepEqual(stable.summaries, raw.summaries);
  assert.equal(JSON.stringify(data), before);
});
