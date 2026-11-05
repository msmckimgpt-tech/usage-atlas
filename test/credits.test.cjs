const test = require('node:test');
const assert = require('node:assert/strict');
const {creditLedger, codexSnapshot, hash} = require('../src/core.cjs');
const time = Date.now() - 86400000;
const record = (i, creditBalance, extra = {}) => ({provider: 'codex', account: hash('a'), time: time + i * 300000, creditBalance, ...extra});
test('Codex credits are native balance decreases and retain decimal precision', () => {
  const result = creditLedger([record(0, 65000), record(1, 62500), record(2, 61311.9780955)], 'codex');
  assert.equal(result.unit, 'credits'); assert.equal(result.available, true);
  assert.ok(Math.abs(result.total - 3688.0219045) < 1e-8);
  assert.deepEqual(result.points.map(p => p.delta), [null, 2500, 1188.0219044999976]);
  assert.deepEqual(result.points.map(p => p.continuous), [false, true, true]);
});
test('credit top-ups, missing readings and account changes never become consumption', () => {
  const rows = [record(0, 100), record(1, 90), record(2, 200), record(3, 190), record(4, null), record(5, 180), record(6, 170)];
  const result = creditLedger(rows, 'codex');
  assert.equal(result.total, 30); assert.equal(result.points[2].delta, null);
  assert.equal(result.points[4].amount, null); assert.equal(result.points[5].delta, null);
  rows.push(record(7, 500, {account: hash('b')})); const changed = creditLedger(rows, 'codex');
  assert.equal(changed.total, 0); assert.equal(changed.points.length, 1);
  assert.equal(creditLedger([record(0, null)], 'codex').available, false);
});
test('gaps keep net observed credit decrease but never interpolate its timing; USD is separate', () => {
  const gap = creditLedger([record(0, 100), record(20, 80)], 'codex');
  assert.equal(gap.total, 20); assert.equal(gap.points[1].continuous, false);
  const usd = creditLedger([
    record(0, 1000, {provider: 'claude', spentUsd: 10, spendPeriod: '2026-09'})
    , record(1, 0, {provider: 'claude', spentUsd: 12, spendPeriod: '2026-09'})
    , record(2, 0, {provider: 'claude', spentUsd: 1, spendPeriod: '2026-10'})
    , record(3, 0, {provider: 'claude', spentUsd: 2, spendPeriod: '2026-10'})
  ], 'claude');
  assert.equal(usd.unit, 'USD'); assert.equal(usd.total, 3); assert.equal(usd.points[2].continuous, false);
});
test('empty or invalid Codex balances cannot fabricate a drop to zero', () => {
  for (const balance of ['', '  ', null, false, true, 'no', -1, Infinity]) assert.equal(codexSnapshot({rateLimits: {credits: {balance}}}, {}).creditBalance, null);
  assert.equal(codexSnapshot({rateLimits: {credits: {balance: '0'}}}, {}).creditBalance, 0);
  assert.equal(codexSnapshot({rateLimits: {credits: {balance: '61311.9780955'}}}, {}).creditBalance, 61311.9780955);
});
