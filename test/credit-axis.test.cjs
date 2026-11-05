'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, hash} = require('../src/core.cjs');
const {buildConversion, converter} = require('../src/credit-conversion.cjs');
const {preview} = require('../src/hover.cjs');
const creditGraphs = require('../media/credit-series.js');
const base = Date.now() - 300000, now = base + 180000, account = hash('credit-axis');
const near = (a, b) => assert.ok(Math.abs(a - b) < .11, String(a) + ' != ' + b);
function fixture(mult = 5) {
  const records = [0, 1, 2].map(i => ({v: 1, provider: 'codex', account, plan: 'pro', time: base + i * 60000, creditBalance: i < 2 ? 1000 : 900, windows: {five: {used: [0, 10, 25][i], reset: now + 18000000}, week: {used: [0, 5, 25][i], reset: now + 604800000}}}));
  const calls = [1, 2].map(i => ({id: 'c' + i, provider: 'codex', account, homeKey: 'fixture', time: base + i * 60000 - 1000, startedAt: base + (i - 1) * 60000 + 1000, completedAt: base + i * 60000 - 1000, completionState: 'completed', model: 'gpt-6.1-sol', mode: i === 1 ? 'Standard' : 'Fast', input: 1000000, cached: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0}));
  const capacities = mult == null ? [] : ['five', 'week'].map(window => ({provider: 'codex', account, plan: 'pro', window, time: base, mult}));
  const model = buildConversion({records, calls, capacities, now});
  return {records, calls, capacities, model, data: project(records, capacities, undefined, converter(model))};
}
function path(svg, key) {return svg.match(new RegExp('<g[^>]*data-series="' + key + '"[^>]*><path d="([^"]*)"'))?.[1];}
const endY = d => Number([...d.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].at(-1)?.[2]);
test('preview credit 25% and subscription 25% share the exact same y coordinate', () => {
  const f = fixture(), result = preview(f.records, {now, capacities: f.capacities, projection: f.data});
  const quota = endY(path(result.svg, 'codex-five')), credit = endY(path(result.svg, 'codex-credit-five'));
  near(quota, credit); assert.ok(credit > 100, '100 raw credits must not stretch to the plot top');
  const week = endY(path(result.svg, 'codex-credit')); assert.ok(week > credit, 'weekly 12.5% is below five-hour 25%');
  assert.equal(f.data.codex.ledger.at(-1).credit.usage, 100); assert.match(result.svg, /data-y-max="108"/);
});
test('shared series agree with additive credit height in every mode and current/base basis', () => {
  const f = fixture();
  for (const mode of ['usage', 'delta', 'total']) for (const basis of ['current', 'base']) {
    const series = creditGraphs.series(f.data.codex, 'codex', {mode, basis});
    for (const window of ['five', 'week']) {
      const point = f.data.codex.windows[window].at(-1), expected = point.creditEstimate[mode] / (basis === 'base' ? 1 : 5);
      const trace = series.find(s => s.creditWindow === window && s.points.at(-1)?.y != null);
      near(trace.points.at(-1).y, expected); assert.equal(trace.points.at(-1).amount, 100);
    }
  }
});
test('native percent calibration works without inventing a base capacity multiplier', () => {
  const f = fixture(null), last = f.data.codex.windows.five.at(-1);
  assert.equal(last.mult, null); assert.equal(last.creditEstimate.usage, null); near(last.creditEstimate.nativeUsage, 25);
  const trace = creditGraphs.series(f.data.codex, 'codex', {basis: 'base'}).find(s => s.creditWindow === 'five' && !s.known);
  near(trace.points.at(-1).y, 25);
  const svg = preview(f.records, {now, projection: f.data}).svg;
  near(endY(path(svg, 'codex-five')), endY(path(svg, 'codex-credit-five')));
});
test('missing conversion never promotes a native credit range to 0..100 percent', () => {
  const f = fixture(), data = project(f.records, f.capacities, undefined, converter(null));
  const trace = creditGraphs.series(data.codex, 'codex').find(s => s.creditWindow === 'five');
  assert.equal(trace.points.at(-1).y, null); assert.equal(trace.points.at(-1).amount, 100);
  const svg = preview(f.records, {now, projection: data}).svg;
  const credit = path(svg, 'codex-credit-five'); if (credit) for (const match of credit.matchAll(/[ML][\d.-]+,([\d.-]+)/g)) near(Number(match[1]), 154);
});
test('preview extends one common scale when converted credits exceed 100 percent', () => {
  const f = fixture(); f.records[2].creditBalance = 100;
  f.model = buildConversion({...f, now}); f.data = project(f.records, f.capacities, undefined, converter(f.model));
  const svg = preview(f.records, {now, projection: f.data}).svg;
  const max = Number(svg.match(/data-y-max="([\d.]+)"/)[1]); near(max, 225 * 1.08);
  const expected = 154 - 25 / max * 126;
  near(endY(path(svg, 'codex-five')), expected);
});
test('unknown capacity and plan changes cannot silently add incompatible lifetime percentages', () => {
  const f = fixture(null);
  f.records.push({...f.records[2], time: base + 150000, plan: 'other'});
  const data = project(f.records, [], undefined, converter(buildConversion({...f, capacities: [], now})));
  assert.equal(data.codex.windows.five.at(-1).creditEstimate.nativeTotal, null);
});
test('unmatched calls touching a paid interval invalidate its purchased-to-subscription weight', () => {
  const f = fixture();
  f.records.splice(2, 0, {...f.records[1], time: base + 90000});
  f.calls[1].startedAt = base + 91000;
  f.calls.push({...f.calls[1], id: 'cross', startedAt: base + 89999});
  const model = buildConversion({...f, now});
  assert.equal(model.cohorts.length, 2); assert.equal(model.debitWeights.length, 0);
});

test('Claude USD and subscription percentages use the same preview height without Codex multipliers', () => {
  const f = fixture(), account = hash('claude');
  f.records = f.records.map((r, i) => ({...r, provider: 'claude', account, creditBalance: undefined, spentUsd: i === 2 ? 10 : 0, spendPeriod: 'fixture'}));
  f.calls = f.calls.map((c, i) => ({...c, provider: 'claude', account, model: 'claude-opus-5-5', mode: 'Standard', input: i === 1 ? 2500000 : 1000000}));
  f.capacities = f.capacities.map(c => ({...c, provider: 'claude', account}));
  const model = buildConversion({...f, now}), projection = project(f.records, f.capacities, undefined, converter(model));
  const svg = preview(f.records, {now, projection}).svg;
  near(endY(path(svg, 'claude-five')), endY(path(svg, 'claude-credit-five')));
  near(projection.claude.windows.five.at(-1).creditEstimate.nativeUsage, 25);
  assert.equal(preview(f.records, {now, projection}).summaries[1].credit, '10 USD');
});
