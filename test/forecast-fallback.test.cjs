'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {series, project, hash} = require('../src/core.cjs');
const forecast = require('../media/forecast.js');
const {preview} = require('../src/hover.cjs');
const {PatternBook} = require('../src/pattern-book.cjs');
const fixture = require('./pattern-fixture.cjs');
const now = Date.parse('2026-11-13T12:00:00+09:00'), hour = 3600000;
function sparse(provider = 'codex') {
  const records = fixture.records(now, provider), recent = records.slice(-3);
  recent[0].time = now - 4 * hour;
  return records;
}
test('observed historical patterns recover sparse recent coverage for every subscription window and selected method', () => {
  for (const provider of ['codex', 'claude', 'antigravity-5d72436256ada538']) for (const window of ['five', 'week']) {
    const points = series(sparse(provider), provider, window), before = JSON.stringify(points);
    for (const method of ['seasonal', 'recent', 'historical', 'activity']) {
      const value = forecast.estimate(points, window, {method});
      assert.ok(value.coverage < .75); assert.equal(value.ratePerHour, null);
      assert.ok(value.trajectory?.length > 1, provider + '/' + window + '/' + method);
      const curve = forecast.curve(value, points.at(-1), {}, now);
      assert.equal(curve.points[0].y, points.at(-1).value);
      assert.equal(curve.points.at(-1).time, value.eta ?? value.reset);
      assert.ok(curve.points.every((p, i) => p.y <= 100 && (!i || p.y >= curve.points[i - 1].y)));
      if (method !== 'activity') assert.equal(value.pattern.weight, 1, 'invalid recent rates must never enter the historical blend');
    }
    assert.equal(JSON.stringify(points), before);
  }
});
test('archive fallback survives raw history compaction and agrees with the preview endpoint', () => {
  const records = sparse(), full = project(records).codex, recentRows = records.slice(-3), recent = project(recentRows).codex;
  const book = new PatternBook('unused'); book.configure([], 90); book.update('codex', records, full.windows);
  const archiveCells = book.older('codex', records[0].account, 'week', recent.windows.week.at(-1), recentRows[0].time);
  assert.equal(forecast.estimate(recent.windows.week, 'week').state, 'insufficient');
  const value = forecast.estimate(recent.windows.week, 'week', {archiveCells, method: 'recent'});
  assert.ok(value.trajectory); assert.equal(value.pattern.weight, 1);
  recent.forecast = {week: value};
  const mini = preview(recentRows, {now, projection: {codex: recent}}).summaries[0].forecasts.week;
  const curve = forecast.curve(value, recent.windows.week.at(-1), {}, now);
  if (value.state === 'predicted') assert.equal(mini.eta, curve.points.at(-1).time);
  else assert.equal(mini.remainingPercent, 100 - curve.points.at(-1).value);
});
test('usage corrections restart only the forecast at the latest value and keep high-water cumulative totals', () => {
  const records = fixture.records(now, 'antigravity-5d72436256ada538');
  records.push({...records.at(-1), time: now + 60000, windows: {five: {...records.at(-1).windows.five, used: 49}, week: {...records.at(-1).windows.week, used: 49}}});
  const points = series(records, records[0].provider, 'week'), last = points.at(-1), before = JSON.stringify(points);
  assert.equal(last.event.kind, 'decrease'); assert.equal(last.delta, null);
  for (const method of ['seasonal', 'recent', 'historical', 'activity']) {
    const value = forecast.estimate(points, 'week', {method}), curve = forecast.curve(value, last, {}, last.time);
    assert.ok(curve, method); assert.equal(curve.points[0].y, 49); assert.equal(value.ratePerHour, null);
    assert.equal(value.used, 49); assert.ok(curve.points.every(p => p.y >= 49 && p.y <= 100));
  }
  assert.equal(JSON.stringify(points), before);
  assert.equal(last.nativeCumulative, points.at(-2).nativeCumulative);
  records.push({...records.at(-1), time: now + 120000, windows: {five: {...records.at(-1).windows.five, used: 50}, week: {used: 50, reset: last.reset}}});
  assert.equal(series(records, records[0].provider, 'week').at(-1).nativeCumulative, last.nativeCumulative);
});
test('historical fallback cannot cross a missing quota, exhausted limit, stale observation, account or plan boundary', () => {
  const points = series(sparse(), 'codex', 'week'), last = points.at(-1);
  for (const value of [null, 100]) {
    const data = [...points.slice(0, -1), {...last, value}];
    assert.equal(forecast.curve(forecast.estimate(data, 'week'), data.at(-1), {}, now), null);
  }
  const value = forecast.estimate(points, 'week');
  assert.equal(forecast.curve(value, last, {}, now + 16 * 60000), null);
  assert.equal(forecast.estimate(points, 'week', {patternDays: 0}).state, 'insufficient');
  assert.equal(forecast.estimate(points, 'week', {since: now - 5 * hour}).state, 'insufficient');
  const changed = points.map(p => p.time < now - 5 * hour ? {...p, plan: 'other'} : p);
  assert.equal(forecast.estimate(changed, 'week').state, 'insufficient');
  const other = sparse().map(r => r.time < now - 5 * hour ? {...r, account: hash('other')} : r);
  const latest = project(other).codex;
  assert.equal(forecast.estimate(latest.windows.week, 'week').state, 'insufficient');
});
