'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, hash} = require('../src/core.cjs');
const {priceCall, creditCall} = require('../src/pricing.cjs');
const {buildConversion, converter, callConverter, validConversion, scopeKey, sourceKey} = require('../src/credit-conversion.cjs');
const {analyze} = require('../src/analytics.cjs');
const base = Date.now() - 600000, minute = 60000;
const account = hash('conversion-fixture');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, String(a) + ' != ' + b);
function record(i, five, week, balance = 1000, extra = {}) {
  return {v: 1, provider: 'codex', account, plan: 'pro', time: base + i * minute, creditBalance: balance, windows: {five: {used: five, reset: base + 18000000}, week: {used: week, reset: base + 604800000}}, ...extra};
}
function call(id, i, mode = 'Standard', extra = {}) {
  return {id, provider: 'codex', account, homeKey: 'fixture', sessionId: id, time: base + i * minute - 1000, startedAt: base + (i - 1) * minute + 1000, completedAt: base + i * minute - 1000, completionState: 'completed', model: 'gpt-6.1-sol', mode, input: 1000000, cached: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...extra};
}
function fixture(extra = {}) {
  return {records: [record(0, 0, 0), record(1, 10, 2), record(2, 10, 2, 900)], calls: [call('included', 1), call('paid', 2, 'Fast')], capacities: ['five', 'week'].map(window => ({provider: 'codex', account, plan: 'pro', time: base, window, mult: 5})), now: base + 3 * minute, ...extra};
}
function projected(options) {const model = buildConversion(options); return {model, data: project(options.records, options.capacities, undefined, converter(model))};}
test('official credit rates distinguish Standard, Fast and Ultrafast from subscription consumption', () => {
  for (const [mode, paid, included] of [['Standard', 50, 50], ['Fast', 100, 125], ['Ultrafast', 300, 400]]) {
    const result = creditCall(call('x', 1, mode)); near(result.purchasedCredits, paid); near(result.subscriptionCredits, included); assert.equal(result.creditIssue, null);
  }
  const cached = creditCall(call('cached', 1, 'Fast', {cached: 1000000})); near(cached.purchasedCredits, 5); near(cached.subscriptionCredits, 6.25);
});
test('credit cache writes have no separate charge and do not inherit API cache TTL uncertainty', () => {
  const row = call('ttl', 1, 'Standard', {cacheWrite5m: null, cacheWrite1h: null, missingFields: ['cacheWriteTtl']});
  const result = priceCall(row); assert.equal(result.costUsd, null); near(result.purchasedCredits, 50); near(result.subscriptionCredits, 50);
});
test('unsupported/prototype model, invalid token types and unknown mode never invent credits', () => {
  for (const row of [call('x', 1, 'unknown'), call('x', 1, 'Standard', {model: '__proto__'}), call('x', 1, 'Standard', {input: '1000'}), call('x', 1, 'Fast', {cached: 1000001})]) {
    const result = creditCall(row); assert.equal(result.purchasedCredits, null); assert.equal(result.subscriptionCredits, null); assert.ok(result.creditIssue);
  }
});
test('native paid credits and per-call cost share the same five-hour and weekly calibration', () => {
  const options = fixture(), before = JSON.stringify(options), {model, data} = projected(options);
  const five = data.codex.windows.five.at(-1).creditEstimate, week = data.codex.windows.week.at(-1).creditEstimate;
  near(five.usage, 125); near(week.usage, 25); near(five.delta, 125); near(five.total, 125);
  const cost = priceCall(options.calls[1]);
  const convert = callConverter(model, options.records, options.capacities, 'five');
  const perCall = convert(cost); near(perCall.quotaPercent, 25); near(perCall.quotaBasePercent, five.delta);
  near(cost.purchasedCredits, 100); assert.equal(model.cohorts.length, 2); assert.equal(model.debitWeights.length, 1);
  assert.equal(JSON.stringify(options), before, 'source observations/calls are immutable');
});
test('extra credit intervals, mixed paid/included usage and missing native balances do not train the baseline', () => {
  const options = fixture(); options.records[1].creditBalance = 999;
  assert.equal(buildConversion(options).cohorts.length, 0);
  delete options.records[0].creditBalance; assert.equal(buildConversion(options).cohorts.length, 0);
});
test('incomplete and cross-interval calls cannot bias the denominator', () => {
  for (const patch of [{completionState: 'incomplete'}, {startedAt: base - 1}]) {
    const options = fixture(); options.calls[0] = {...options.calls[0], ...patch}; assert.equal(buildConversion(options).cohorts.length, 0);
  }
  const options = fixture(); options.calls.push(call('crossing', 1, 'Standard', {startedAt: base - 1})); assert.equal(buildConversion(options).cohorts.length, 0);
});
test('unknown Codex mode uses the approved Standard assumption in both calibration and paid normalization', () => {
  const options = fixture(); options.calls[0].mode = 'unknown'; options.calls[1].mode = 'unknown';
  const {model, data} = projected(options); assert.equal(model.debitWeights.length, 1); assert.equal(model.assumedMode, 'Standard');
  assert.equal(model.cohorts[0].assumedCallCount, 1); near(data.codex.windows.five.at(-1).creditEstimate.usage, 100);
  const result = analyze({...options, provider: 'codex', window: 'five', start: base, end: base + 3 * minute, cursorTime: base + 3 * minute});
  const paid = result.calls.items.find(row => row.id === 'paid'); assert.equal(paid.creditAssumed, true); near(paid.purchasedCredits, 50); near(paid.subscriptionCredits, 50); near(paid.quotaPercent, 10);
});
test('week resets restart usage while lifetime total preserves converted credits', () => {
  const options = fixture();
  options.records.push(record(3, 0, 0, 850, {windows: {five: {used: 0, reset: base + 19000000}, week: {used: 0, reset: base + 605800000}}})); options.calls.push(call('reset-paid', 3)); options.now = base + 4 * minute;
  const {data} = projected(options), points = data.codex.windows.five;
  near(points[3].creditEstimate.usage, 0); assert.equal(points[3].creditEstimate.delta, null); near(points[3].creditEstimate.total, 175);
  near(data.codex.ledger[3].credit.total, 150);
});
test('retroactive capacity settings rescale base percentages while current-plan percentages remain equal', () => {
  const a = fixture(), b = fixture(); for (const c of b.capacities) c.mult = 20;
  const first = projected(a), second = projected(b);
  near(first.data.codex.windows.five.at(-1).creditEstimate.usage / 5, second.data.codex.windows.five.at(-1).creditEstimate.usage / 20);
  near(second.data.codex.windows.five.at(-1).creditEstimate.usage, 500);
});
test('zero extra usage remains zero without any automatic calibration', () => {
  const options = fixture({calls: []}); for (const r of options.records) r.creditBalance = 1000;
  const {data} = projected(options); near(data.codex.windows.five.at(-1).creditEstimate.usage, 0); near(data.codex.windows.week.at(-1).creditEstimate.total, 0);
});
test('Claude observed USD uses its own model rates and never receives Codex credit multipliers', () => {
  const options = fixture(); options.records = options.records.map((r, i) => ({...r, provider: 'claude', creditBalance: undefined, spentUsd: i === 2 ? 4 : 0, spendPeriod: 'fixture'}));
  options.calls = options.calls.map(c => ({...c, provider: 'claude', model: 'claude-opus-5-5', mode: 'Standard'})); options.capacities = options.capacities.map(c => ({...c, provider: 'claude'}));
  const {model, data} = projected(options); assert.equal(model.debitWeights.length, 0);
  near(data.claude.windows.five.at(-1).creditEstimate.usage, 50); near(data.claude.windows.week.at(-1).creditEstimate.usage, 10);
  assert.equal(priceCall(options.calls[0]).purchasedCredits, null);
});
test('exclusions remove only the relevant window calibration; source data remain intact', () => {
  const options = fixture({exclusions: [{provider: 'codex', account, window: 'five', start: base, end: base + minute, restoredAt: null}]});
  const {model, data} = projected(options); assert.equal(model.cohorts.length, 1); assert.equal(data.codex.windows.five.at(-1).creditEstimate.usage, null); near(data.codex.windows.week.at(-1).creditEstimate.usage, 25); near(data.codex.last.creditBalance, 900);
});
test('cache scope binds to the price catalog, capacities, exclusions and exact source observation prefix', () => {
  const options = fixture(), model = buildConversion(options);
  assert.equal(validConversion(model, scopeKey(options.capacities, [])), true);
  assert.equal(model.inputKey, sourceKey(options.records, options.capacities, []));
  assert.equal(validConversion(model, 'wrong'), false); assert.equal(validConversion({...model, catalogVersion: 'old'}, model.scopeKey), false);
  assert.equal(validConversion({...model, debitWeights: [['a'.repeat(64), Infinity]]}, model.scopeKey), false);
});
test('modal filtering never changes the shared calibration used by chart and call conversion', () => {
  const options = fixture(), result = analyze({...options, provider: 'codex', window: 'five', start: base, end: base + 3 * minute, cursorTime: base + 3 * minute, filters: {session: 'paid'}});
  assert.equal(result.calls.items.length, 1); near(result.calls.items[0].purchasedCredits, 100); near(result.calls.items[0].quotaPercent, 25);
  assert.equal(result.conversion.cohorts[0].callCount, 1);
});

test('missing start uses the completion event without changing canonical calls', () => {
  const options = fixture(); for (const row of options.calls) row.startedAt = null;
  const before = JSON.stringify(options), {model, data} = projected(options);
  assert.equal(model.cohorts.length, 2); assert.equal(model.cohorts[0].eventCallCount, 1);
  near(data.codex.windows.five.at(-1).creditEstimate.nativeUsage, 25);
  const converted = callConverter(model, options.records, options.capacities, 'five')(priceCall(options.calls[1]));
  assert.equal(converted.quotaTimingAssumed, true); near(converted.quotaPercent, 25);
  assert.equal(JSON.stringify(options), before);
});
test('Codex observed token event can train with unknown completion while terminal failures cannot', () => {
  const options = fixture();
  for (const row of options.calls) {row.startedAt = null; row.completedAt = null; row.completionState = 'unknown'; row.provenance = {observedAt: row.time};}
  assert.equal(buildConversion(options).cohorts[0].eventCallCount, 1);
  for (const state of ['failed', 'cancelled', 'incomplete', 'in_progress']) {
    const sample = structuredClone(options); sample.calls[0].completionState = state;
    assert.equal(buildConversion(sample).cohorts.length, 0);
  }
});
test('events match only (previous observation, current observation] and do not cross gaps or excluded windows', () => {
  const options = fixture(); options.calls[0].startedAt = null; options.calls[0].completedAt = base;
  assert.equal(buildConversion(options).cohorts.length, 0);
  options.calls[0].completedAt = base + minute;
  assert.equal(buildConversion(options).cohorts.length, 2);
  options.exclusions = [{provider: 'codex', account, window: 'five', start: base, end: base + minute}];
  assert.equal(buildConversion(options).cohorts.length, 1);
  options.records[0].time = base - 31 * minute;
  assert.equal(buildConversion(options).cohorts.length, 0);
});
test('unattributed paid activity uses explicit Standard without replacing known Fast weighting', () => {
  const options = fixture(); options.calls.pop();
  const {model, data} = projected(options);
  assert.equal(model.assumedDebitCount, 1); near(data.codex.windows.five.at(-1).creditEstimate.nativeUsage, 20);
  near(projected(fixture()).data.codex.windows.five.at(-1).creditEstimate.nativeUsage, 25);
});
test('Claude completion events support native percent with no capacity multiplier', () => {
  const options = fixture(); options.capacities = [];
  options.records = options.records.map((r, i) => ({...r, provider: 'claude', creditBalance: undefined, spentUsd: i === 2 ? 4 : 0, spendPeriod: 'fixture'}));
  options.calls = options.calls.map(c => ({...c, provider: 'claude', model: 'claude-opus-5-5', startedAt: null}));
  const {model, data} = projected(options);
  assert.equal(model.cohorts[0].eventCallCount, 1); near(data.claude.windows.five.at(-1).creditEstimate.nativeUsage, 10);
  assert.equal(data.claude.windows.five.at(-1).creditEstimate.usage, null);
});

test('canonical call time before history cannot discard a later observed usage event', () => {
  const options = fixture(); options.calls[0].startedAt = null; options.calls[0].completedAt = null;
  options.calls[0].completionState = 'unknown'; options.calls[0].provenance = {observedAt: options.calls[0].time}; options.calls[0].time = base - minute;
  const {model} = projected(options); assert.equal(model.cohorts[0].eventCallCount, 1);
  near(callConverter(model, options.records, options.capacities, 'five')(priceCall(options.calls[0])).quotaPercent, 10);
});

test('missing paid model and token details cannot erase later cumulative credits with a uniform known mode ratio', () => {
  const options = fixture();
  options.records.push(record(3, 10, 2, 850), record(4, 10, 2, 800));
  options.calls.push(call('metadata-only', 3, 'unknown', {model: null, input: null, cached: null, output: null, startedAt: null, completedAt: null, completionState: 'unknown', provenance: {observedAt: base + 3 * minute - 1000}}), call('last', 4));
  options.now = base + 5 * minute;
  const before = JSON.stringify(options), {model, data} = projected(options);
  assert.equal(model.ratioOnlyDebitCount, 1); assert.equal(model.assumedDebitCount, 1);
  assert.equal(model.cohorts.length, 2); assert.equal(model.debitWeights.length, 3);
  const points = data.codex.windows.five;
  near(points[2].creditEstimate.nativeTotal, 25); near(points[3].creditEstimate.nativeTotal, 35); near(points[4].creditEstimate.nativeTotal, 45);
  for (const p of points.slice(2)) assert.equal(p.creditEstimate.nativeTotalContinuous, true);
  near(data.codex.ledger.at(-1).credit.total, 200); assert.equal(JSON.stringify(options), before);
  assert.equal(creditCall(options.calls[2], {assumeMode: 'Standard'}).purchasedCredits, null, 'no per-call token cost is invented');
});
test('uniform Standard/Fast/Ultrafast ratios use observed credits without a model price or token quantity', () => {
  for (const [mode, ratio] of [['Standard', 1], ['Fast', 1.25], ['Ultrafast', 8 / 6]]) {
    const options = fixture(); options.calls[1] = {...options.calls[1], mode, model: null, input: null};
    const {model, data} = projected(options); assert.equal(model.ratioOnlyDebitCount, 1);
    near(data.codex.windows.five.at(-1).creditEstimate.nativeTotal, 20 * ratio);
    assert.equal(model.cohorts[0].callCount, 1, 'metadata-only paid calls never train quota calibration');
  }
});
test('mixed speed modes still require known purchased-credit shares rather than an arbitrary average', () => {
  const options = fixture(); options.calls.push(call('other-mode', 2));
  const priced = projected(options); near(priced.data.codex.windows.five.at(-1).creditEstimate.nativeTotal, 100 * (175 / 150) / 5);
  options.calls[2].model = null;
  const uncertain = projected(options); assert.equal(uncertain.model.debitWeights.length, 0); assert.equal(uncertain.data.codex.windows.five.at(-1).creditEstimate.nativeTotal, null);
});
test('mode conflict, unsupported mode/category and unfinished calls remain excluded from paid weights', () => {
  for (const patch of [{provenance: {modeConflict: true}}, {mode: 'unsupported'}, {tokenCategory: 'image'}, {completionState: 'failed'}]) {
    const options = fixture(); options.calls[1] = {...options.calls[1], model: null, ...patch};
    assert.equal(projected(options).model.debitWeights.length, 0);
  }
});
test('paid mode ratios do not create a missing five-hour or weekly subscription denominator', () => {
  const options = fixture(); options.calls[0].model = null;
  const {model, data} = projected(options); assert.equal(model.cohorts.length, 0);
  assert.equal(data.codex.windows.five.at(-1).creditEstimate.nativeTotal, null);
});
test('Claude USD cumulative values remain independent of missing paid token details and Codex speed ratios', () => {
  const options = fixture(); options.records = options.records.map((r, i) => ({...r, provider: 'claude', creditBalance: undefined, spentUsd: i === 2 ? 4 : 0, spendPeriod: 'fixture'}));
  options.calls = options.calls.map((c, i) => ({...c, provider: 'claude', model: i === 0 ? 'claude-opus-5-5' : null, input: i === 0 ? c.input : null})); options.capacities = options.capacities.map(c => ({...c, provider: 'claude'}));
  const {model, data} = projected(options); assert.equal(model.ratioOnlyDebitCount, 0); assert.equal(model.debitWeights.length, 0);
  near(data.claude.windows.five.at(-1).creditEstimate.nativeTotal, 10);
});
test('derived schema five rejects obsolete caches and invalid ratio-only counters', () => {
  const options = fixture(), model = buildConversion(options), key = scopeKey(options.capacities, []);
  assert.equal(model.schema, 5); assert.equal(validConversion(model, key), true);
  for (const schema of [1, 2, 3, 4]) assert.equal(validConversion({...model, schema}, key), false);
  for (const ratioOnlyDebitCount of [-1, null, Infinity, 120001]) assert.equal(validConversion({...model, ratioOnlyDebitCount}, key), false);
  for (const paidThrough of [null, [], {codex: {account, time: -1}}, {codex: {account: 'other', time: base}}, {codex: {account, time: model.measuredAt + 1}}]) assert.equal(validConversion({...model, paidThrough}, key), false);
});


test('observed long-gap credit debits stay in weekly usage and lifetime totals without inventing interval timing', () => {
  const options = fixture(); options.calls[1].mode = 'Standard';
  options.records.push(record(144, 10, 2, 700), record(145, 10, 2, 650)); options.now = base + 146 * minute;
  const before = JSON.stringify(options), {model, data} = projected(options), points = data.codex.windows.five;
  near(points[3].credit.total, 300); near(points[3].creditEstimate.nativeTotal, 60); near(points[4].creditEstimate.nativeUsage, 70);
  assert.equal(points[3].credit.delta, null); assert.equal(points[3].creditEstimate.nativeDelta, null);
  assert.equal(points[3].creditEstimate.nativeTotalContinuous, false); assert.equal(points[4].creditEstimate.nativeTotalContinuous, true);
  near(points[4].creditEstimate.nativeDelta, 10); assert.equal(model.cohorts[0].intervalCount, 1);
  assert.equal(JSON.stringify(options), before);
});

test('paid gap normalization uses recorded Fast ratios and never trains quota or per-call timing from a gap', () => {
  const options = fixture(); options.records.push(record(144, 10, 2, 700));
  options.calls.push(call('gap-fast', 144, 'Fast', {startedAt: base + 3 * minute, completedAt: base + 143 * minute})); options.now = base + 145 * minute;
  const {model, data} = projected(options); near(data.codex.windows.five.at(-1).creditEstimate.nativeTotal, 75);
  assert.equal(model.cohorts[0].intervalCount, 1);
  assert.equal(callConverter(model, options.records, options.capacities, 'five')(priceCall(options.calls.at(-1))).quotaPercent, null);
  options.calls.at(-1).mode = 'unsupported'; assert.equal(projected(options).data.codex.windows.five.at(-1).creditEstimate.nativeTotal, null);
});

test('new observed credit debits render immediately with approved Standard pending the next local mode analysis', () => {
  const options = fixture(), model = buildConversion(options), initial = project(options.records, options.capacities, undefined, converter(model));
  const records = [...options.records, record(3, 10, 2, 850)];
  const pending = project(records, options.capacities, undefined, converter(model)).codex.windows.five.at(-1);
  near(pending.creditEstimate.nativeTotal, initial.codex.windows.five.at(-1).creditEstimate.nativeTotal + 10);
  assert.equal(pending.creditEstimate.standardPending, true); near(pending.creditEstimate.nativeDelta, 10);
  const refreshed = projected({...options, records, calls: [...options.calls, call('fresh-fast', 3, 'Fast')], now: base + 4 * minute});
  near(refreshed.data.codex.windows.five.at(-1).creditEstimate.nativeTotal, 37.5);
  assert.equal(refreshed.data.codex.windows.five.at(-1).creditEstimate.standardPending, false);
  const other = records.map(row => ({...row, account: hash('unrelated-credit-owner')}));
  assert.equal(project(other, [], undefined, converter(model)).codex.windows.five.at(-1).creditEstimate.nativeTotal, null);
});
