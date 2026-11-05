const test = require('node:test');
const assert = require('node:assert/strict');
const {format, digits} = require('../media/amount-format.js');
const {preview} = require('../src/hover.cjs');
const {hash} = require('../src/core.cjs');
test('amount precision supports integer through eight places with grouping, rounding and trailing zero omission', () => {
  assert.equal(format(1234567.89123456), '1,234,567.8912');
  assert.equal(format(1234567.89123456, 8), '1,234,567.89123456');
  assert.equal(format(1.005, 2), '1.01'); assert.equal(format(1.6, 0), '2');
  assert.equal(format(.123456789, 8), '0.12345679'); assert.equal(format(3.5, 8), '3.5');
  assert.equal(format(-0), '0'); assert.equal(format(-.004, 2), '0');
});
test('invalid precision falls back to four while unavailable amounts never become zero', () => {
  for (const value of [undefined, null, -1, 9, 1.5, '2', NaN, Infinity]) {
    assert.equal(digits(value), 4); assert.equal(format(.123456, value), '0.1235');
  }
  for (const value of [undefined, null, '0', NaN, Infinity, -Infinity]) assert.equal(format(value, 2), '-');
});
test('provider precision is independent in preview summaries and never changes graph values or source records', () => {
  const now = +new Date(2026, 9, 21, 12);
  const rows = ['codex', 'claude'].flatMap(provider => [0, 1].map(i => ({
      v: 1, provider, account: hash(provider), plan: 'test', time: now - (1 - i) * 60000
    , windows: {five: {used: 30 + i, reset: now + 3600000}, week: {used: 40 + i, reset: now + 7 * 86400000}}
    , ...(provider === 'codex' ? {creditBalance: 1000 - i * 12.345678} : {spentUsd: i * .12345678, spendPeriod: '2026-10'})
  }))).sort((a, b) => a.time - b.time);
  const before = JSON.stringify(rows), original = preview(rows, {now});
  const custom = preview(rows, {now, codexCreditDecimals: 2, claudeUsdDecimals: 6});
  assert.equal(custom.summaries[0].credit, '12.35 크레딧'); assert.equal(custom.summaries[1].credit, '0.123457 USD');
  const zero = preview(rows, {now, codexCreditDecimals: 0, claudeUsdDecimals: 0});
  assert.equal(zero.summaries[0].credit, '12 크레딧'); assert.equal(zero.summaries[1].credit, '0 USD');
  assert.equal(custom.svg, original.svg); assert.equal(zero.svg, original.svg); assert.equal(JSON.stringify(rows), before);
});
