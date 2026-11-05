'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {selection, createExclusion, validateExclusions} = require('../src/details-selection.cjs');
const {hash} = require('../src/core.cjs');
const now = Date.now(), account = hash('selection');
const row = (time, used, reset = now + 86400000) => ({v: 1, provider: 'codex', account, time, plan: 'fixture', windows: {five: {used, reset}, week: {used, reset}}, source: 'app-server'});
const records = [row(now - 3000, 10), row(now - 2000, 20), row(now - 1000, 30)];
const message = () => ({requestId: 'details-1', provider: 'codex', window: 'week', start: now - 3000, end: now - 1000, time: now - 2000, reason: 'fixture'});
test('detail selection uses current account and never trusts a supplied account or arbitrary filter', () => {
  const scope = selection({...message(), account: hash('other'), filters: {model: 'gpt-fixture', authorization: 'secret'}}, records);
  assert.equal(scope.account, account); assert.deepEqual(scope.filters, {model: 'gpt-fixture'});
  assert.throws(() => selection({...message(), requestId: '<script>'}, records));
  assert.throws(() => selection({...message(), filters: {model: 'line\nbreak'}}, records));
});
test('analysis exclusions require observed endpoints within one reset cycle', () => {
  const value = createExclusion(message(), records, [], now);
  assert.equal(value.start, records[0].time); assert.equal(value.end, records[2].time); assert.equal(value.account, account);
  assert.throws(() => createExclusion({...message(), excludeStart: now - 2999}, records, [], now), /실제로 관측/);
  const reset = [records[0], row(now - 2000, 0, now + 86400000 * 2), row(now - 1000, 1, now + 86400000 * 2)];
  assert.throws(() => createExclusion(message(), reset, [], now), /초기화 주기/);
  assert.equal(JSON.stringify(records).includes('restoredAt'), false);
});
test('imported exclusions preserve restoration metadata and reject malformed or duplicate records', () => {
  const original = createExclusion(message(), records, [], now - 1); original.restoredAt = now;
  assert.deepEqual(validateExclusions([original], now), [original]);
  assert.throws(() => validateExclusions([original, original], now));
  assert.throws(() => validateExclusions([{...original, restoredAt: original.createdAt - 1}], now));
  assert.throws(() => validateExclusions([{...original, end: original.start}], now));
  const clean = validateExclusions([{...original, accessToken: 'private'}], now);
  assert.equal(JSON.stringify(clean).includes('private'), false);
});
