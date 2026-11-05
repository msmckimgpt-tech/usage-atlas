'use strict';

// Copyright (c) 2026 jisoq; design adapted from https://github.com/jisoq/Codexon.
// See licenses/Codexon-LICENSE.txt. Usage Atlas implementation and catalog are new.

const catalog = require('./price-catalog.json');
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokens = value => numeric(value) && Number.isSafeInteger(value);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
freeze(catalog);
const policyMetadata = new Map(Object.entries(catalog.policies).map(([provider, policy]) => [provider, {
  notes: policy.notes
, sources: Object.freeze(catalog.sources.filter(source => policy.sourceIds.includes(source.id)).map(source => source.url))
}]));

function creditCall(call = {}, {assumeMode} = {}) {
  const result = {purchasedCredits: null, subscriptionCredits: null, creditIssue: null, creditAssumed: false, creditCatalogVersion: catalog.version};
  if (call.provider !== 'codex') return result;
  const rate = Object.hasOwn(catalog.creditModels, call.model || '') ? catalog.creditModels[call.model] : null;
  const policy = catalog.policies.codex;
  const mode = (!call.mode || call.mode === 'unknown') && assumeMode !== undefined ? assumeMode : call.mode;
  result.creditAssumed = mode !== call.mode;
  const fail = issue => {result.creditIssue = issue; return result;};
  if (!rate) return fail('unsupported-credit-model');
  if (!catalog.models[call.model]?.modes.includes(mode)) return fail('unknown-or-unsupported-credit-mode');
  if (call.provenance?.modeConflict || call.provenance?.inputConflict) return fail('conflicting-observation');
  if ((call.tokenCategory ?? call.provenance?.tokenCategory ?? 'text') !== 'text' || call.missingFields?.some(field => /(?:tokenCategor|unsupported.*token)/i.test(field))) return fail('unsupported-token-category');
  if (!['input', 'cached', 'output'].every(key => tokens(call[key])) || call.cached > call.input) return fail('unknown-or-invalid-tokens');
  if (call.reasoning != null && (!tokens(call.reasoning) || call.reasoning > call.output)) return fail('invalid-reasoning-subset');
  const standard = ((call.input - call.cached) * rate.input + call.cached * rate.cached + call.output * rate.output) / 1000000;
  const paid = standard * policy.purchasedCreditMultipliers[mode];
  const included = standard * policy.modeMultipliers[mode];
  if (!numeric(paid) || !numeric(included)) return fail('credit-overflow');
  result.purchasedCredits = paid; result.subscriptionCredits = included;
  return result;
}

function priceCall(call = {}, {assumeMode} = {}) {
  const policy = catalog.policies[call.provider];
  const rate = Object.hasOwn(catalog.models, call.model || '') ? catalog.models[call.model] : null;
  const observedMode = call.mode;
  const assumed = (!observedMode || observedMode === 'unknown') && assumeMode !== undefined;
  const mode = assumed ? assumeMode : observedMode;
  const metadata = policyMetadata.get(call.provider);
  const extraSource = rate?.sourceId && !policy?.sourceIds.includes(rate.sourceId) ? catalog.sources.find(source => source.id === rate.sourceId)?.url : null;
  const result = {
    ...call
  , ...creditCall(call, {assumeMode})
  , costUsd: null
  , costComponents: null
  , pricePolicy: policy?.id ?? null
  , pricePolicyRef: policy ? `${catalog.version}/${policy.id}` : null
  , priceCatalogVersion: catalog.version
  , priceSource: extraSource ? [...(metadata?.sources ?? []), extraSource] : metadata?.sources ?? []
  , priceVerifiedAt: catalog.verifiedAt
  , priceIssue: null
  , priceIssues: []
  , priceMode: mode ?? 'unknown'
  , priceAssumed: assumed
  , estimated: true
  , costKind: 'cost-equivalent'
  , actualCredits: null
  , actualBillingUsd: null
  , priceNotes: metadata?.notes ?? []
  };
  const fail = issue => {
    result.priceIssues.push(issue);
    result.priceIssue = result.priceIssues.join('; ');
    return result;
  };
  if (!policy) return fail('unsupported-provider');
  if (!rate || rate.provider !== call.provider) return fail('unsupported-model');
  if (!rate.modes.includes(mode)) return fail(mode === 'unknown' || mode == null ? 'unknown-mode' : 'unsupported-mode');
  if (call.provenance?.modeConflict || call.provenance?.inputConflict) return fail('conflicting-observation');
  const category = call.tokenCategory ?? call.provenance?.tokenCategory;
  if (category != null && category !== 'text') return fail('unsupported-token-category');
  const missing = Array.isArray(call.missingFields) ? call.missingFields : [];
  const writeTotal = call.provenance?.cacheWriteTotal;
  const noWritesObserved = tokens(writeTotal) && writeTotal === 0;
  if (missing.some(field => /(?:tokenCategor|unsupported.*token)/i.test(field) || !noWritesObserved && /cache.*ttl/i.test(field))) return fail('unknown-token-category-or-cache-ttl');
  for (const key of ['input', 'cached', 'output']) {
    if (!tokens(call[key])) return fail(`unknown-or-invalid-${key}`);
  }
  if (call.cached > call.input) return fail('cache-exceeds-inclusive-input');
  // Reasoning is already a subset of output in the canonical call contract.
  if (call.reasoning != null && (!tokens(call.reasoning) || call.reasoning > call.output)) return fail('invalid-reasoning-subset');
  let writes;
  const writeCount = key => call[key] == null && noWritesObserved ? 0 : call[key];
  if (call.provider === 'claude') {
    writes = ['cacheWrite5m', 'cacheWrite1h'];
    if (['cacheWrite30m', 'cacheWrite12h'].some(key => call[key] != null && call[key] !== 0)) return fail('unsupported-cache-write-ttl');
  } else {
    for (const key of ['cacheWrite5m', 'cacheWrite1h']) {
      if (!tokens(writeCount(key))) return fail(`unknown-or-invalid-${key}`);
      if (writeCount(key) > 0) return fail('unsupported-cache-write-ttl');
    }
    writes = ['cacheWrite30m', 'cacheWrite12h'].filter(key => Object.hasOwn(call, key));
  }
  for (const key of writes) {
    if (!tokens(writeCount(key))) return fail(`unknown-or-invalid-${key}`);
    if (writeCount(key) > 0 && !numeric(rate[key])) return fail('unsupported-cache-write-ttl');
  }
  if (call.cacheWrite != null || call.cacheWriteUnknown != null || call.provenance?.cacheWriteTtl === 'unknown') return fail('unclassified-cache-write');
  const written = writes.reduce((sum, key) => sum + writeCount(key), 0);
  if (writeTotal != null && (!tokens(writeTotal) || writeTotal !== written)) return fail('unclassified-or-conflicting-cache-write-total');
  if (call.cached + written > call.input) return fail('cache-exceeds-inclusive-input');
  if (rate.unverifiedLongAbove && call.input > rate.unverifiedLongAbove) return fail('unverified-long-context-rate');
  let multiplier = call.provider === 'codex' ? policy.modeMultipliers[mode] : mode === 'Fast' ? rate.fastMultiplier : 1;
  const longContext = !!(rate.longThreshold && call.input > rate.longThreshold);
  if (longContext) multiplier *= rate.longMultiplier;
  if (!numeric(multiplier)) return fail('unsupported-mode-multiplier');
  const component = (count, amount) => count === 0 ? 0 : count * amount * multiplier / 1000000;
  const components = {
    uncachedInput: component(call.input - call.cached - written, rate.input)
  , cachedInput: component(call.cached, rate.cached)
  , cacheWrite5m: 0
  , cacheWrite1h: 0
  , cacheWrite30m: 0
  , cacheWrite12h: 0
  , output: component(call.output, rate.output)
  };
  for (const key of writes) components[key] = component(writeCount(key), rate[key]);
  const cost = Object.values(components).reduce((sum, amount) => sum + amount, 0);
  if (!Number.isFinite(cost)) return fail('cost-overflow');
  result.costComponents = components;
  result.costUsd = cost;
  result.priceMultiplier = multiplier;
  result.longContext = longContext;
  if (noWritesObserved && ['cacheWrite5m', 'cacheWrite1h'].some(key => call[key] == null)) result.priceNotes = [...result.priceNotes, '캐시 쓰기 합계 0이 직접 관측되어 TTL별 쓰기 비용도 0으로 확인했습니다. 원본 미확인 필드는 유지합니다.'];
  result.reasoningCostUsd = tokens(call.reasoning) ? component(call.reasoning, rate.output) : null;
  if (assumed) result.priceNotes = [...result.priceNotes, `미확인 모드에 ${mode}를 명시적으로 가정한 시나리오입니다.`];
  return result;
}

module.exports = {priceCall, creditCall, catalog};
