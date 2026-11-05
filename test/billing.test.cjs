'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {project, hash, thin} = require('../src/core.cjs');
const billing = require('../src/billing.cjs');
const credits = require('../media/credit-series.js');
const {preview} = require('../src/hover.cjs');
const near = (a, b) => assert.ok(Number.isFinite(a) && Math.abs(a - b) < 1e-8, a + ' != ' + b);
const now = Date.now(), minute = 60000;
function rows(provider = 'claude') {
  return [0, 1, 2, 3].map(i => ({v: 1, provider, account: hash('billing'), plan: provider === 'codex' ? 'prolite' : 'team:default_claude_max_5x', time: now - (3 - i) * minute, windows: {five: {used: i, reset: now + 18000000}, week: {used: i, reset: now + 604800000}}, ...(provider === 'codex' ? {creditBalance: [1000, 1000, 900, 800][i]} : {spentUsd: [0, 0, 4, 8][i], spendPeriod: new Date(now).toISOString().slice(0, 7)})}));
}
test('official monthly list prices use explicit plan identities and never guess from capacity multipliers', () => {
  assert.equal(billing.monthlyPrice('codex', 'prolite').monthlyUsd, 100); assert.equal(billing.monthlyPrice('codex', 'pro').monthlyUsd, 200);
  assert.equal(billing.monthlyPrice('claude', 'team:default_claude_max_5x').monthlyUsd, 100);
  for (const [id, plan] of [['codex', 'enterprise'], ['codex', 'business'], ['claude', 'team:unknown'], ['claude', 'free'], ['codex', '__proto__']]) assert.equal(billing.monthlyPrice(id, plan), null);
});
test('observed Claude USD becomes official monthly-fee percentages without touching quota or raw money', () => {
  const records = rows(), raw = project(records).claude, priced = project(records, [], undefined, billing.enricher()).claude;
  near(priced.ledger.at(-1).billing.usage, 8); near(priced.ledger.at(-1).billing.delta, 4); near(priced.ledger.at(-1).billing.total, 8);
  assert.deepEqual(priced.windows, raw.windows); assert.equal(priced.creditTotal, raw.creditTotal);
  const curve = credits.series(priced, 'claude', {creditBasis: 'billing'})[0]; assert.equal(curve.billing, true); near(curve.points.at(-1).y, 8);
});
test('missing verified credit prices still preserve source credits without inventing USD', () => {
  const rates = structuredClone(billing.catalog); rates.providers.codex.usdPerCredit = null;
  const records = rows('codex'), data = project(records, [], undefined, billing.enricher(rates)).codex;
  assert.equal(data.creditTotal, 200); assert.equal(data.ledger.at(-1).billing.monthlyUsd, 100); assert.equal(data.ledger.at(-1).billing.usage, null);
  assert.equal(data.ledger.at(-1).billing.total, null); assert.equal(credits.series(data, 'codex', {creditBasis: 'billing'})[0].points.at(-1).y, null);
});
test('public US checkout base price converts positive Codex credits in every display mode by default', () => {
  const data = project(rows('codex'), [], undefined, billing.enricher()).codex;
  near(data.ledger.at(-1).billing.usage, 8); near(data.ledger.at(-1).billing.delta, 4); near(data.ledger.at(-1).billing.total, 8);
  for (const mode of ['usage', 'delta', 'total']) assert.ok(credits.series(data, 'codex', {creditBasis: 'billing', mode})[0].points.at(-1).y > 0);
  assert.equal(billing.catalog.providers.codex.usdPerCredit, .04);
  assert.equal(billing.catalog.providers.codex.creditPriceEvidence.field, 'currency_config.amount_per_credit');
  assert.equal(data.creditTotal, 200);
});
test('weekly resets restart fee usage and lifetime fees survive while long gaps do not invent per-observation deltas', () => {
  const records = rows(); records[3].time += 2 * 3600000;
  const data = project(records, [], undefined, billing.enricher()).claude; near(data.ledger.at(-1).billing.total, 8); near(data.ledger.at(-1).billing.usage, 8);
  assert.equal(data.ledger.at(-1).billing.delta, null); assert.equal(data.ledger.at(-1).billing.totalContinuous, false);
  const next = {...records.at(-1), time: records.at(-1).time + minute, spentUsd: 10, windows: {five: {used: 0, reset: now + 19000000}, week: {used: 0, reset: now + 605800000}}};
  const reset = project([...records, next], [], undefined, billing.enricher()).claude.ledger.at(-1); near(reset.billing.usage, 0); near(reset.billing.total, 10);
});
test('fee changes preserve cumulative USD and recompute its percentage against the applicable monthly plan', () => {
  const records = rows(); records[0].plan = records[1].plan = 'pro'; records[1].spentUsd = 10; records[2].spentUsd = 20; records[3].spentUsd = 30;
  const data = project(records, [], undefined, billing.enricher()).claude;
  near(data.ledger.at(-1).billing.total, 30); assert.equal(data.ledger[2].billing.totalContinuous, false);
});
test('standalone preview and projected page share billing amounts and keep fee axes separate from quota', () => {
  const records = ['codex', 'claude'].flatMap(id => rows(id)).sort((a, b) => a.time - b.time), data = project(records, [], undefined, billing.enricher());
  const a = preview(records, {now, creditBasis: 'billing', projection: data}), b = preview(records, {now, creditBasis: 'billing'});
  assert.equal(a.svg, b.svg); assert.match(a.svg, /data-series="codex-credit"/); assert.match(a.svg, /data-series="claude-credit"/); assert.match(a.svg, /data-billing-axis/); assert.match(a.svg, /data-y-billing-max/);
  const normal = preview(records, {now, projection: data}); assert.doesNotMatch(normal.svg, /data-billing-axis/);
});
test('downsampling remains bounded and preserves sharp billing deltas', () => {
  const points = Array.from({length: 10000}, (_, i) => ({time: i, amount: i, continuous: true, billing: {usage: i, delta: i === 1234 ? 10000 : 1, total: i, usageContinuous: true, totalContinuous: true, deltaContinuous: true}}));
  const reduced = thin(points, 1500); assert.ok(reduced.length <= 1502); assert.ok(reduced.some(point => point.time === 1234));
});


test('billing delta uses its observed magnitude and cannot flatten small charges against a 100-percent floor', () => {
  const charts = require('../media/chart-series.js'), points = [{time: 0, y: .002, continuous: false}, {time: 1000, y: .004, continuous: true}];
  near(charts.billingMaximum([{billing: true, points}], [0, 1000], 'delta'), .00432);
  near(charts.billingMaximum([{billing: true, points}], [0, 1000], 'usage'), 108);
  near(charts.billingMaximum([{billing: true, points: points.map(p => ({...p, y: null}))}], [0, 1000], 'delta'), 1.08);
});
