'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {priceCall, catalog} = require('../src/pricing.cjs');

function call(extra = {}) {
  return {
    id: 'request'
  , provider: 'codex'
  , model: 'gpt-6.1-sol'
  , mode: 'Standard'
  , input: 1000000
  , cached: 200000
  , cacheWrite5m: 0
  , cacheWrite1h: 0
  , output: 100000
  , reasoning: 60000
  , ...extra
  };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('inclusive cache input is charged once; reasoning stays inside output', () => {
  const result = priceCall(call());
  near(result.costUsd, 2.62);
  near(result.reasoningCostUsd, 0.6);
  near(Object.values(result.costComponents).reduce((a, b) => a + b), result.costUsd);
  assert.equal(result.actualCredits, null);
  assert.equal(result.actualBillingUsd, null);
  assert.equal(result.costKind, 'cost-equivalent');
});

test('Codex uses an explicit included-weighted comparison policy, never purchased-credit multipliers', () => {
  const standard = priceCall(call());
  const fast = priceCall(call({mode: 'Fast'}));
  const ultra = priceCall(call({mode: 'Ultrafast'}));
  near(fast.costUsd, standard.costUsd * 2.5);
  near(ultra.costUsd, standard.costUsd * 8);
  assert.match(fast.pricePolicy, /included-weighted/);
  assert.ok(fast.priceNotes.some(note => note.includes('2배')));
  assert.equal(priceCall(call({model: 'gpt-6-luna', mode: 'Ultrafast'})).costUsd, null);
});

test('unknown mode needs an explicit scenario and never claims an observed mode', () => {
  const original = call({mode: 'unknown'});
  assert.equal(priceCall(original).costUsd, null);
  const scenario = priceCall(original, {assumeMode: 'Standard'});
  assert.equal(scenario.mode, 'unknown');
  assert.equal(scenario.priceMode, 'Standard');
  assert.equal(scenario.priceAssumed, true);
  assert.equal(scenario.estimated, true);
  near(scenario.costUsd, 2.62);
  const confirmed = priceCall(call({mode: 'Fast'}), {assumeMode: 'Standard'});
  assert.equal(confirmed.priceMode, 'Fast');
  assert.equal(confirmed.priceAssumed, false);
});

test('unknown, malformed, negative and contradictory token quantities cannot produce a total', () => {
  for (const extra of [
    {input: null}
  , {cached: undefined}
  , {output: NaN}
  , {input: '100'}
  , {cacheWrite5m: null}
  , {cacheWrite1h: -1}
  , {cached: 1000001}
  , {reasoning: 100001}
  , {input: 1.5}
  , {provenance: {inputConflict: true}}
  ]) {
    const result = priceCall(call(extra));
    assert.equal(result.costUsd, null, JSON.stringify(extra));
    assert.ok(result.priceIssue);
  }
});

test('zero is observed zero; null never becomes zero', () => {
  const result = priceCall(call({input: 0, cached: 0, output: 0, reasoning: 0}));
  assert.equal(result.costUsd, 0);
  assert.equal(priceCall(call({input: 0, cached: null, output: 0})).costUsd, null);
});

test('unsupported model, provider, mode, category and TTL are explicit unknowns', () => {
  for (const extra of [
    {model: 'gpt-6.1-sol-fictional'}
  , {model: '__proto__'}
  , {provider: 'other'}
  , {mode: 'priority'}
  , {tokenCategory: 'audio'}
  , {cacheWrite5m: 100}
  , {cacheWrite1h: 100}
  , {cacheWrite: 100}
  , {missingFields: ['cacheWriteTtl']}
  , {provenance: {cacheWriteTtl: 'unknown'}}
  ]) assert.equal(priceCall(call(extra)).costUsd, null, JSON.stringify(extra));
});

test('known OpenAI cache-write TTL replaces ordinary input pricing', () => {
  const result = priceCall(call({cacheWrite30m: 100000, cacheWrite12h: 100000}));
  near(result.costUsd, 2.97);
  near(result.costComponents.uncachedInput, 1.2);
  near(result.costComponents.cacheWrite30m, 0.25);
  near(result.costComponents.cacheWrite12h, 0.5);
  assert.equal(priceCall(call({cacheWrite30m: 900000})).costUsd, null);
});

test('Claude 5m and 1h writes replace their portion of inclusive input', () => {
  const result = priceCall(call({provider: 'claude', model: 'claude-opus-5-5', cached: 200000, cacheWrite5m: 100000, cacheWrite1h: 100000}));
  near(result.costUsd, 5.74);
  near(result.costComponents.uncachedInput, 2.4);
  near(result.costComponents.cachedInput, 0.04);
  near(result.costComponents.cacheWrite5m, 0.5);
  near(result.costComponents.cacheWrite1h, 0.8);
  near(result.costComponents.output, 2);
  near(priceCall({...result, mode: 'Fast'}).costUsd, 11.48);
});

test('Claude cache-write TTL must be known, including in explicit Standard scenario', () => {
  const original = call({provider: 'claude', model: 'claude-opus-5-5', cacheWrite5m: null, mode: 'unknown'});
  assert.equal(priceCall(original, {assumeMode: 'Standard'}).costUsd, null);
  assert.equal(priceCall({...original, cacheWrite5m: 0}, {assumeMode: 'Standard'}).costUsd, 5.24);
});

test('observed zero write total proves zero cost without inventing missing TTL token fields', () => {
  const original = call({provider: 'claude', model: 'claude-opus-5-5', cacheWrite5m: null, cacheWrite1h: null, mode: 'unknown', provenance: {cacheWriteTotal: 0}, missingFields: ['cacheWriteTTL']});
  const result = priceCall(original, {assumeMode: 'Standard'});
  near(result.costUsd, 5.24);
  assert.equal(result.cacheWrite5m, null);
  assert.equal(result.cacheWrite1h, null);
  const unknown = priceCall({...original, provenance: {cacheWriteTotal: 100}}, {assumeMode: 'Standard'});
  assert.equal(unknown.costUsd, null);
  const conflict = priceCall(call({provenance: {cacheWriteTotal: 10}}));
  assert.equal(conflict.costUsd, null);
});

test('Claude Haiku long threshold counts all inclusive input; boundary is strict', () => {
  const original = call({provider: 'claude', model: 'claude-haiku-5-5', input: 100000, cached: 50000, output: 0, reasoning: 0});
  near(priceCall(original).costUsd, 0.0055);
  near(priceCall({...original, input: 100001}).costUsd, (50001 * 0.1 + 50000 * 0.01) * 5 / 1000000);
  assert.equal(priceCall({...original, model: 'claude-haiku-4-5', input: 200001}).costUsd, null);
});

test('catalog is immutable, versioned and retains official verification metadata', () => {
  assert.ok(Object.isFrozen(catalog.models['gpt-6.1-sol']));
  assert.match(catalog.version, /^2026-10-22\./);
  const original = call();
  const snapshot = structuredClone(original);
  const result = priceCall(original);
  assert.deepEqual(original, snapshot);
  assert.equal(result.pricePolicyRef, `${catalog.version}/${result.pricePolicy}`);
  for (const source of catalog.sources) {
    assert.match(source.url, /^https:\/\/(?:developers\.openai\.com|learn\.chatgpt\.com|platform\.claude\.com|code\.claude\.com)\//);
    assert.equal(source.verifiedAt, '2026-10-22');
    assert.equal(source.documentVersion, null);
    assert.ok(source.rawMetadata.section || source.rawMetadata.sections);
  }
});
