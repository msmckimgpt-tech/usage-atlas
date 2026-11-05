'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chart = require('../media/chart-series.js');
const {project, hash} = require('../src/core.cjs');
const {preview} = require('../src/hover.cjs');
const now = Date.now(), hour = 3600000;
test('axis uses the continuous values clipped at viewport boundaries, not invisible historical peaks', () => {
  const points = [{time: 0, y: 1000}, {time: 10, y: 0, continuous: true}];
  const result = chart.limits([{known: true, points}], [9, 11]);
  assert.equal(result.maximum, 108);
  const split = chart.limits([{known: false, points}], [9, 11], {basis: 'base'});
  assert.equal(split.unscaledMaximum, 108);
  assert.equal(chart.limits([{known: true, points}], [5, 6]).maximum, 540);
});
test('axis never extrapolates isolated or discontinuous observations into a viewport', () => {
  for (const points of [[{time: 0, y: 1000}], [{time: 0, y: 1000}, {time: 10, y: 0, continuous: false}]]) {
    assert.equal(chart.limits([{known: true, points}], [5, 6]).maximum, 108);
  }
});
test('preview uses the supplied page projection for both quota coordinates and summaries', () => {
  const rows = [0, 1, 2].map(i => ({v: 1, provider: 'codex', account: hash('projection'), plan: 'test', time: now - hour + i * 60000, windows: {five: {used: i * 10, reset: now + hour}, week: {used: i * 10, reset: now + 7 * 86400000}}, creditBalance: 1000}));
  const projection = project(rows);
  // A narrowed authoritative snapshot must not be replaced with a fresh raw-history calculation.
  projection.codex.windows.five = projection.codex.windows.five.slice(0, 2);
  projection.codex.windows.week = projection.codex.windows.week.slice(0, 2);
  const result = preview(rows, {now, projection});
  const path = result.svg.match(/data-series="codex-five"><path d="([^"]*)"/)[1];
  const y = Number([...path.matchAll(/[ML][\d.-]+,([\d.-]+)/g)].at(-1)[1]);
  assert.ok(Math.abs(y - (154 - 10 / 108 * 126)) < .06);
  assert.equal(result.summaries[0].five, '20%');
});
test('shared quota transformations preserve source data in all modes and comparison bases', () => {
  const p = {time: now, value: 10, delta: 2, cumulative: 50, nativeCumulative: 10, cumulativeKnown: true, mult: 5, continuous: true, segment: 0, credit: {segment: 0, usageContinuous: true, deltaContinuous: true, totalContinuous: true}, creditEstimate: {usage: 25, delta: 5, total: 25, nativeUsage: 5, nativeDelta: 1, nativeTotal: 5, usageContinuous: true, deltaContinuous: true, totalContinuous: true, nativeUsageContinuous: true, nativeDeltaContinuous: true, nativeTotalContinuous: true}};
  const provider = {ledgerAvailable: true, windows: {five: [p]}}, original = JSON.stringify(provider);
  for (const mode of ['usage', 'delta', 'total']) for (const basis of ['current', 'base']) {
    const list = chart.quota(provider, 'codex', 'five', {mode, basis, credit: true, creditMode: 'estimate'});
    const value = list.flatMap(s => s.points).find(p => Number.isFinite(p.y)).y;
    assert.equal(value, (mode === 'delta' ? 3 : 15) * (basis === 'base' ? 5 : 1));
  }
  assert.equal(JSON.stringify(provider), original);
});
test('current cumulative calibrated and raw axes share numeric spacing with native or additive credits', () => {
  const series = (known, y, extra = {}) => ({known, points: [{time: 0, y}, {time: 10, y, continuous: true}], ...extra});
  const quota = [series(true, 746), series(false, 1327)];
  const credit = [series(true, 3101, {w: 'credit'}), series(false, 0, {w: 'credit'})];
  const original = JSON.stringify([...quota, ...credit]);
  for (const plotted of [quota, [...quota, ...credit], [series(true, 3847), quota[1]]]) {
    const limits = chart.limits(plotted, [0, 10], {mode: 'total', basis: 'current'});
    assert.equal(limits.split, true);
    assert.equal(limits.maximum, limits.unscaledMaximum);
    assert.equal(limits.maximum, Math.max(...plotted.map(s => s.points[0].y)) * 1.08);
    const percent100 = 100 / limits.maximum, pp100 = 100 / limits.unscaledMaximum;
    assert.equal(percent100, pp100, '100% and 100pp have the same numeric grid spacing without converting units');
  }
  assert.equal(JSON.stringify([...quota, ...credit]), original);
});
test('current cumulative shared scale clips to the viewport and handles focus and raw-only views', () => {
  const plotted = [
      {known: true, points: [{time: 0, y: 10000}, {time: 10, y: 100, continuous: true}]}
    , {known: false, points: [{time: 0, y: 100}, {time: 10, y: 200, continuous: true}]}
  ];
  const focused = chart.limits([plotted[1]], [9, 10], {mode: 'total'});
  assert.equal(focused.rawTotal, true); assert.equal(focused.split, false); assert.equal(focused.maximum, 216);
  const mixed = chart.limits(plotted, [9, 10], {mode: 'total'});
  assert.equal(mixed.maximum, 1090 * 1.08); assert.equal(mixed.unscaledMaximum, mixed.maximum);
  const empty = chart.limits([{known: false, points: [{time: 0, y: null}]}], [0, 10], {mode: 'total'});
  assert.ok(Number.isFinite(empty.maximum));
});
test('base cumulative and usage axes keep their independent units and existing reference zoom', () => {
  const plotted = [{known: true, points: [{time: 0, y: 500}]}, {known: false, points: [{time: 0, y: 100}]}];
  const normal = chart.limits(plotted, [0, 10], {mode: 'total', basis: 'base'});
  const refs = chart.limits(plotted, [0, 10], {mode: 'total', basis: 'base', refs: true});
  assert.equal(normal.maximum, 540); assert.equal(normal.unscaledMaximum, 108);
  assert.equal(refs.maximum / normal.maximum, refs.unscaledMaximum / normal.unscaledMaximum);
  assert.equal(chart.limits(plotted, [0, 10]).maximum, 540);
});
