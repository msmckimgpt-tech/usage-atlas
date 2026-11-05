'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {analyze} = require('../src/analytics.cjs');
const {series} = require('../src/core.cjs');

const base = 1900000000000;
const minute = 60000;
const reset = base + 7 * 86400000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

function call(id, time = base + minute, extra = {}) {
  return {
    id: String(id)
  , provider: 'codex'
  , account: 'account-a'
  , accountSource: 'explicit'
  , homeKey: 'local'
  , time
  , startedAt: time - 1000
  , completedAt: time
  , sessionId: `session-${id}`
  , parentSessionId: null
  , project: 'project-a'
  , model: 'gpt-6.1-sol'
  , effort: 'high'
  , mode: 'Standard'
  , input: 1000000
  , cached: 0
  , cacheWrite5m: 0
  , cacheWrite1h: 0
  , output: 100000
  , reasoning: 50000
  , completionState: 'completed'
  , provenance: {source: 'fixture'}
  , missingFields: []
  , ...extra
  };
}

function record(time, used, extra = {}) {
  return {v: 1, provider: 'codex', account: 'account-a', time, plan: 'pro', windows: {five: null, week: {used, reset}}, ...extra};
}

function report(extra = {}) {
  return analyze({provider: 'codex', window: 'week', account: 'account-a', start: base, end: base + 10 * minute, now: base + 10 * minute, ...extra});
}

test('empty modal report remains complete JSON with explicit unknowns', () => {
  const result = report();
  assert.deepEqual(Object.keys(result), ['summary', 'projectLabels', 'filterOptions', 'filterOptionCounts', 'coverage', 'sessions', 'requests', 'calls', 'agents', 'comparisons', 'cache', 'cycles', 'conversion', 'estimate', 'exclusions', 'diagnostics', 'provenance']);
  assert.equal(result.summary.costUsd, null);
  assert.equal(result.summary.knownCostUsd, 0);
  assert.equal(result.cache.ratio, null);
  assert.equal(result.estimate.valueUsdPer100Pct, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('full totals and known counts survive top50/detail100 bounds', () => {
  const calls = Array.from({length: 130}, (_, index) => call(index, base + minute, index === 129 ? {mode: 'unknown'} : {}));
  const result = report({calls});
  assert.equal(result.summary.callCount, 130);
  assert.equal(result.summary.pricedCallCount, 130);
  near(result.summary.knownCostUsd, 390);
  near(result.summary.costUsd, 390);
  assert.equal(result.calls.items.length, 100);
  assert.equal(result.calls.totalCount, 130);
  assert.equal(result.calls.knownCount, 130);
  assert.equal(result.sessions.items.length, 50);
  assert.equal(result.sessions.totalCount, 130);
});

test('session/request/call bounds select the newest observations before applying display limits', () => {
  const calls = Array.from({length: 140}, (_, i) => call('recent-' + i, base + i * 1000, {turnId: 'turn-' + i, input: (140 - i) * 10000}));
  const result = report({calls});
  for (const section of [result.sessions, result.requests, result.agents]) {
    assert.equal(section.items.length, 50);
    assert.equal(section.items[0].lastObservedAt, base + 139000);
    assert.equal(section.items.at(-1).lastObservedAt, base + 90000);
    assert.ok(section.items.every((row, i, rows) => !i || row.lastObservedAt <= rows[i - 1].lastObservedAt));
  }
  assert.equal(result.calls.items[0].time, base + 139000); assert.equal(result.calls.items.at(-1).time, base + 40000);
  assert.equal(result.summary.callCount, 140);
});

test('all drilldown filters affect totals, cache, comparisons and C2 denominators', () => {
  const a = call('a', base + minute, {turnId: 'turn-a', input: 5000, cached: 4750});
  const b = call('b', base + minute, {turnId: 'turn-b', project: 'project-b', effort: 'low', mode: 'Fast'});
  const filters = {project: 'project-a', session: a.sessionId, turnId: 'turn-a', model: a.model, effort: a.effort, mode: a.mode, inputBand: '0-10k', cacheBand: '90-100%'};
  const result = report({calls: [a, b], filters, records: [record(base, 10), record(base + 2 * minute, 20)]});
  assert.equal(result.summary.callCount, 1);
  assert.equal(result.coverage.sourceCallCount, 2);
  assert.equal(result.coverage.eligibleCallCount, 1);
  assert.equal(result.comparisons.items[0].sampleCount, 1);
  assert.equal(result.cache.ratio, 0.95);
  assert.equal(result.estimate.eligibleCallCount, 1);
  assert.equal(result.estimate.quotaDelta, 10, 'account-wide quota cannot be attributed to selected project');
  const none = report({calls: [a, b], inputBand: {min: 10000, max: 20000}});
  assert.equal(none.summary.callCount, 0);
});

test('weighted cache ratio and valid sample denominators exclude invalid/unknown input', () => {
  const calls = [call(1, undefined, {input: 100, cached: 90}), call(2, undefined, {input: 900, cached: 0}), call(3, undefined, {input: null, cached: null}), call(4, undefined, {input: 0, cached: 0})];
  const result = report({calls});
  near(result.cache.ratio, 0.09);
  assert.equal(result.cache.validSampleCount, 2);
  assert.equal(result.comparisons.items[0].cacheSampleCount, 2);
  assert.equal(result.summary.input, null);
  assert.equal(result.summary.tokenCoverage.input.knownCount, 3);
  assert.equal(result.summary.tokenCoverage.input.knownSum, 1000);
});

test('comparison costs retain valid statistics while unverified latency is explicitly unknown', () => {
  const calls = [call(1, base + minute, {startedAt: base + minute - 100}), call(2, base + minute, {startedAt: base + minute - 900, output: 900000}), call(3, base + minute, {startedAt: null, output: null})];
  const result = report({calls});
  const item = result.comparisons.items[0];
  assert.equal(item.sampleCount, 3);
  assert.equal(item.pricedSampleCount, 2);
  assert.equal(item.cost.mean, 7);
  assert.equal(item.cost.median, 7);
  assert.equal(item.cost.p90, 11);
  assert.equal(item.latencySampleCount, 0);
  assert.equal(item.latencyUnknownSampleCount, 3);
  assert.deepEqual(item.latencyMs, {mean: null, median: null, p90: null});
  assert.equal(item.latencyIssue, 'unverified-request-timestamp-provenance');
  assert.match(item.latencyLabel, /미확인/);
  assert.ok(result.coverage.notes.some(note => note.includes('호출별 타임스탬프 출처')));
  assert.deepEqual(result.coverage.missingFields.find(entry => entry.field === 'latencyMs'), {field: 'latencyMs', callCount: 3});
  assert.equal(item.smallSample, true);
  assert.match(item.label, /품질/);
});

test('shared turn timestamps and local response/stream events never imply API call latency', () => {
  const calls = [
    call(1, base + minute, {startedAt: base, provenance: {source: 'codex-token-usage-record'}})
  , call(2, base + 2 * minute, {startedAt: base, provenance: {source: 'codex-response'}})
  , call(3, base + 3 * minute, {startedAt: base, provenance: {source: 'claude-stream'}})
  ];
  const item = report({calls}).comparisons.items[0];
  assert.equal(item.sampleCount, 3);
  assert.equal(item.pricedSampleCount, 3);
  assert.equal(item.latencySampleCount, 0);
  assert.deepEqual(item.latencyMs, {mean: null, median: null, p90: null});
  assert.ok(item.latencyNotes.some(note => note.includes('턴')));
});

test('sessions count own calls once and expose descendants without inflating summary', () => {
  const calls = [call('root', undefined, {sessionId: 'root'}), call('child', undefined, {sessionId: 'child', parentSessionId: 'root'}), call('grandchild', undefined, {sessionId: 'grandchild', parentSessionId: 'child'})];
  const result = report({calls});
  const root = result.sessions.items.find(row => row.sessionId === 'root');
  near(result.summary.costUsd, 9);
  near(root.ownCostUsd, 3);
  near(root.descendantCostUsd, 6);
  assert.equal(root.callCount, 1);
  assert.equal(root.descendantCallCount, 2);
  assert.equal(result.sessions.items.reduce((sum, row) => sum + row.callCount, 0), 3);
});

test('home/account boundaries and cyclic parent metadata cannot duplicate descendants', () => {
  const calls = [call(1, undefined, {sessionId: 'a', parentSessionId: 'b'}), call(2, undefined, {sessionId: 'b', parentSessionId: 'a'}), call(3, undefined, {homeKey: 'elsewhere', sessionId: 'b', parentSessionId: 'a'}), call(4, undefined, {account: 'account-b'})];
  const result = report({calls});
  assert.equal(result.summary.callCount, 3);
  assert.equal(result.sessions.items.find(row => row.sessionId === 'a').descendantCallCount, 1);
  near(result.summary.knownCostUsd, 9);
});

test('requests group optional turnId but never invent it', () => {
  const calls = [call(1, undefined, {sessionId: 's', turnId: 't'}), call(2, undefined, {sessionId: 's', turnId: 't'}), call(3, undefined, {sessionId: 's'})];
  const result = report({calls});
  assert.equal(result.requests.totalCount, 2);
  assert.equal(result.requests.items.find(row => row.turnId === 't').callCount, 2);
  assert.equal(result.requests.items.find(row => row.turnId == null).callCount, 1);
});

test('C2 matches complete request intervals, isolates unknown starts and keeps three denominators', () => {
  const records = [record(base, 10), record(base + 2 * minute, 20), record(base + 4 * minute, 30)];
  const calls = [
    call('matched', base + minute)
  , call('provisional', base + minute, {startedAt: null})
  , call('crosses', base + 3 * minute, {startedAt: base + minute})
  , call('incomplete', base + 3 * minute, {completionState: 'interrupted'})
  , call('unpriced', base + 3 * minute, {model: 'unknown'})
  ];
  const result = report({records, calls});
  assert.equal(result.estimate.matchedCallCount, 2);
  assert.equal(result.estimate.provisionalCallCount, 1);
  assert.equal(result.estimate.unmatchedCallCount, 2);
  assert.equal(result.estimate.pricedCallCount, 4);
  assert.equal(result.estimate.matchedPricedCallCount, 1);
  assert.equal(result.estimate.sourceCallCount, 5);
  assert.equal(result.estimate.eligibleCallCount, 5);
  assert.equal(result.estimate.quotaDelta, 20);
  near(result.estimate.knownCostUsd, 3);
  near(result.estimate.valueUsdPer100Pct, 15);
  assert.ok(result.estimate.sensitivity.some(row => row.id === 'include-provisional'));
  assert.ok(result.estimate.notes.some(note => note.includes('계정 전체')));
  assert.ok(result.estimate.notes.some(note => note.includes('신뢰구간')));
});

test('Claude unknown mode uses the approved Standard assumption and is explicitly marked', () => {
  const calls = [call(1, undefined, {provider: 'claude', model: 'claude-opus-5-5', mode: 'unknown'})];
  const records = [record(base, 10, {provider: 'claude'}), record(base + 2 * minute, 20, {provider: 'claude'})];
  const result = report({provider: 'claude', records, calls});
  near(result.summary.costUsd, 6); assert.equal(result.summary.pricedCallCount, 1);
  assert.equal(result.calls.items[0].priceAssumed, true); assert.equal(result.estimate.assumedCallCount, 1);
  near(result.estimate.valueUsdPer100Pct, 60); assert.equal(result.estimate.scenarios, undefined);
});

test('C2 never blends different known plans/capacities, including Standard and provisional sensitivities', () => {
  const records = [record(base, 0), record(base + minute, 10), record(base + 2 * minute, 20, {plan: 'pro-five'}), record(base + 3 * minute, 40, {plan: 'pro-five'})];
  const capacities = [
    {provider: 'codex', account: 'account-a', window: 'week', plan: 'pro', time: base, mult: 1}
  , {provider: 'codex', account: 'account-a', window: 'week', plan: 'pro-five', time: base + 2 * minute, mult: 5}
  ];
  const calls = [call(1, base + minute / 2), call(2, base + 2.5 * minute, {output: 700000}), call(3, base + 2.75 * minute, {startedAt: null, mode: 'unknown'})];
  const original = structuredClone({records, capacities, calls});
  const result = report({records, capacities, calls});
  for (const estimate of [result.estimate]) {
    assert.equal(estimate.status, 'mixed-capacity');
    assert.equal(estimate.valueUsdPer100Pct, null);
    assert.deepEqual(estimate.sensitivity, []);
    assert.equal(estimate.quotaDelta, 30, 'raw native percent remains visible for coverage');
    assert.equal(estimate.capacityCohortCount, 2);
    assert.ok(estimate.notes.includes('요금제·배율이 다른 구간은 하나의 100%로 환산하지 않습니다. 주기별로 확인하세요.'));
    assert.equal(estimate.planGroupCount, 2);
    const first = estimate.planGroups.find(group => group.plan === 'pro');
    const second = estimate.planGroups.find(group => group.plan === 'pro-five');
    assert.equal(first.mult, 1);
    assert.equal(second.mult, 5);
    near(first.valueUsdPer100Pct, 30);
    near(second.valueUsdPer100Pct, 45);
    assert.equal(first.scope, 'plan-capacity-cohort');
    assert.equal(second.quotaDelta, 20);
    assert.equal(second.matchedCallCount, 1);
    assert.equal(second.provisionalCallCount, 1);
  }
  assert.ok(result.estimate.planGroups.find(group => group.mult === 5).sensitivity.some(item => item.id === 'include-provisional'));
  assert.deepEqual({records, capacities, calls}, original);
});

test('one plan with x1/x5/x20 calibration changes is three separate positive cohorts', () => {
  const records = [0, 10, 20, 40, 50, 80].map((used, index) => record(base + index * minute, used));
  const capacities = [1, 5, 20].map((mult, index) => ({provider: 'codex', account: 'account-a', window: 'week', plan: 'pro', time: base + index * 2 * minute, mult}));
  const calls = [call(1, base + minute / 2), call(2, base + 2.5 * minute, {output: 700000}), call(3, base + 4.5 * minute)];
  const result = report({records, capacities, calls});
  for (const estimate of [result.estimate]) {
    assert.equal(estimate.status, 'mixed-capacity');
    assert.equal(estimate.valueUsdPer100Pct, null);
    assert.deepEqual(estimate.sensitivity, []);
    assert.equal(estimate.quotaDelta, 60);
    assert.equal(estimate.capacityCohortCount, 3);
    assert.deepEqual(estimate.planGroups.map(group => group.mult), [1, 5, 20]);
    assert.deepEqual(estimate.planGroups.map(group => group.valueUsdPer100Pct), [30, 45, 10]);
  }
  assert.equal(result.cycles.totalCount, 3);
});

test('same-plan unknown multipliers remain one native-percent cohort and do not invent x1', () => {
  const records = [record(base, 0), record(base + minute, 10), record(base + 2 * minute, 20)];
  const calls = [call(1, base + minute / 2), call(2, base + 1.5 * minute, {mode: 'unknown'})];
  const result = report({records, calls});
  assert.equal(result.estimate.status, 'partial-local-observation');
  assert.equal(result.estimate.capacityCohortCount, 1);
  assert.equal(result.estimate.planGroups[0].mult, null);
  near(result.estimate.valueUsdPer100Pct, 30);
  assert.equal(result.estimate.assumedCallCount, 1);
  assert.ok(result.estimate.sensitivity.length > 0);
});

test('zero-delta foreign plan does not suppress a single observed positive cohort', () => {
  const records = [record(base, 0), record(base + minute, 10), record(base + 2 * minute, 20, {plan: 'other'}), record(base + 3 * minute, 20, {plan: 'other'})];
  const result = report({records, calls: [call(1, base + minute / 2)]});
  assert.equal(result.estimate.capacityCohortCount, 1);
  assert.equal(result.estimate.status, 'partial-local-observation');
  near(result.estimate.valueUsdPer100Pct, 30);
});

test('analysis exclusion can isolate one cohort without changing raw observations', () => {
  const records = [record(base, 0), record(base + minute, 10), record(base + 2 * minute, 20, {plan: 'other'}), record(base + 3 * minute, 40, {plan: 'other'})];
  const calls = [call(1, base + minute / 2), call(2, base + 2.5 * minute)];
  const exclusion = {id: 'other-cohort', provider: 'codex', account: 'account-a', window: 'week', start: base + 2 * minute, end: base + 3 * minute, createdAt: base + 4 * minute, reason: 'isolate first cycle'};
  const mixed = report({records, calls});
  assert.equal(mixed.estimate.status, 'mixed-capacity');
  const isolated = report({records, calls, exclusions: [exclusion]});
  assert.equal(isolated.estimate.capacityCohortCount, 1);
  near(isolated.estimate.valueUsdPer100Pct, 30);
  assert.equal(isolated.exclusions.effects.beforeQuotaDelta, 30);
  assert.equal(isolated.exclusions.effects.afterQuotaDelta, 10);
});

test('bounded plan groups preserve true cohort counts and never unmask a combined estimate', () => {
  const records = [];
  const calls = [];
  for (let index = 0; index < 51; index++) {
    const time = base + index * 2 * minute;
    const plan = `plan-${index}`;
    records.push(record(time, 0, {plan}), record(time + minute, 10, {plan}));
    calls.push(call(index, time + minute / 2));
  }
  const result = report({records, calls, end: base + 103 * minute, now: base + 103 * minute});
  for (const estimate of [result.estimate]) {
    assert.equal(estimate.status, 'mixed-capacity');
    assert.equal(estimate.valueUsdPer100Pct, null);
    assert.deepEqual(estimate.sensitivity, []);
    assert.equal(estimate.capacityCohortCount, 51);
    assert.equal(estimate.planGroupCount, 51);
    assert.equal(estimate.planGroups.length, 50);
    assert.equal(estimate.planGroupsTruncated, true);
    assert.equal(estimate.quotaDelta, 510);
    assert.equal(estimate.matchedPricedCallCount, 51);
    assert.ok(estimate.planGroups.every(group => group.mult === null && group.valueUsdPer100Pct === 30));
  }
});

test('core gap, plan and reset transitions are used without interpolated C2 consumption', () => {
  const rows = [record(base, 90), record(base + minute, 100), record(base + 2 * minute, 2, {windows: {five: null, week: {used: 2, reset: reset + 3600000}}}), record(base + 3 * minute, 4)];
  const result = report({records: rows});
  assert.equal(result.cycles.totalCount, 2, 'only the actual reset starts another cycle');
  assert.ok(result.cycles.items.some(row => row.events.some(event => event.kind === 'early-reset')));
  assert.equal(result.estimate.quotaDelta, 10, 'reset zero-baseline estimate is excluded from C2');
  const gap = report({records: [record(base, 1), record(base + 40 * minute, 50)], end: base + 50 * minute});
  assert.equal(gap.estimate.quotaDelta, 0);
  assert.equal(gap.cycles.items[0].gapCount, 1);
  const plan = report({records: [record(base, 1), record(base + minute, 20, {plan: 'new-plan'})]});
  assert.equal(plan.estimate.quotaDelta, 0);
  assert.equal(plan.cycles.totalCount, 2);
});

test('schedule-only adjustments preserve one cycle, latest reset and discontinuity evidence', () => {
  const adjustedReset = reset + 3600000;
  const latestReset = adjustedReset + 3600000;
  const records = [
    record(base, 10)
  , record(base + minute, 20)
  , record(base + 2 * minute, 25, {windows: {five: null, week: {used: 25, reset: adjustedReset}}})
  , record(base + 3 * minute, 30, {windows: {five: null, week: {used: 30, reset: adjustedReset}}})
  , record(base + 4 * minute, 35, {windows: {five: null, week: {used: 35, reset: latestReset}}})
  , record(base + 5 * minute, 40, {windows: {five: null, week: {used: 40, reset: latestReset}}})
  ];
  const original = structuredClone(records);
  const result = report({records});
  assert.equal(result.cycles.totalCount, 1);
  const cycle = result.cycles.items[0];
  assert.equal(cycle.id, `codex/account-a/week/0/${base}`);
  assert.equal(cycle.start, base);
  assert.equal(cycle.reset, latestReset);
  assert.equal(cycle.current, true);
  assert.equal(cycle.partial, true);
  assert.equal(cycle.startObserved, false);
  assert.equal(cycle.endObserved, false);
  assert.equal(cycle.gapCount, 2);
  assert.deepEqual(cycle.events.map(event => event.kind), ['schedule-change', 'schedule-change']);
  assert.equal(cycle.quotaDelta, 20, 'only continuous increases before/after adjustments enter C2');
  assert.equal(result.estimate.intervalCount, 3);
  assert.equal(result.estimate.quotaDelta, 20);
  assert.deepEqual(records, original);
});

test('account switches never bridge A to A over another active account', () => {
  const records = [record(base, 1), record(base + minute, 9, {account: 'account-b'}), record(base + 2 * minute, 20)];
  const result = report({records});
  assert.equal(result.estimate.quotaDelta, 0);
  assert.equal(result.cycles.totalCount, 2);
});

test('counter recovery honors the core high-water mark rather than summing rebounds twice', () => {
  const records = [10, 80, 20, 50, 85].map((used, index) => record(base + index * minute, used));
  const coreTotal = series(records, 'codex', 'week').filter(row => row.continuous && row.delta > 0).reduce((sum, row) => sum + row.delta, 0);
  assert.equal(report({records}).estimate.quotaDelta, coreTotal);
  assert.equal(coreTotal, 75);
});

test('exclusion unions remove analysis observations once and restore is reversible', () => {
  const calls = [call(1, base + minute), call(2, base + 3 * minute), call(3, base + 5 * minute)];
  const records = [record(base, 0), record(base + 2 * minute, 10), record(base + 4 * minute, 20), record(base + 6 * minute, 30)];
  const exclusion = {id: 'a', provider: 'codex', account: 'account-a', window: 'week', start: base + 2 * minute, end: base + 4 * minute, reason: 'test', createdAt: base};
  const exclusions = [exclusion, {...exclusion, id: 'b', start: base + 3 * minute, end: base + 5 * minute}];
  const original = structuredClone({calls, records, exclusions});
  const result = report({calls, records, exclusions});
  assert.equal(result.exclusions.ranges.length, 1);
  assert.equal(result.exclusions.effects.removedCallCount, 2, 'a request crossing the exclusion end is removed in full');
  near(result.exclusions.effects.removedKnownCostUsd, 6);
  assert.equal(result.exclusions.effects.beforeQuotaDelta, 30);
  assert.equal(result.exclusions.effects.afterQuotaDelta, 10);
  assert.deepEqual(result.exclusions.items.map(row => row.exclusionId), ['b', 'a']);
  assert.deepEqual({calls, records, exclusions}, original);
  const restored = report({calls, records, exclusions: exclusions.map(item => ({...item, restoredAt: base + 8 * minute}))});
  assert.equal(restored.summary.callCount, 3);
  assert.equal(restored.estimate.quotaDelta, 30);
  assert.equal(restored.exclusions.activeCount, 0);
});

test('exclusion is scoped to exact provider/account/window and half-open boundaries', () => {
  const calls = [call(1, base + minute, {startedAt: base + minute, completedAt: base + minute})];
  const exclusion = {id: 'a', provider: 'codex', account: 'account-a', window: 'week', start: base, end: base + minute};
  assert.equal(report({calls, exclusions: [exclusion]}).summary.callCount, 1);
  assert.equal(report({calls, exclusions: [{...exclusion, window: 'five', end: base + 2 * minute}]}).summary.callCount, 1);
  assert.equal(report({calls, exclusions: [{...exclusion, account: 'other', end: base + 2 * minute}]}).summary.callCount, 1);
});

test('cache suspicion needs sustained comparable observations and resets after compaction', () => {
  const calls = [0.9, 0.85, 0.9, 0.1, 0.1, 0.1].map((ratio, index) => call(index, base + (index + 1) * minute, {sessionId: 's', input: 100000, cached: ratio * 100000}));
  assert.equal(report({calls}).cache.suspicions.length, 1);
  assert.equal(report({calls: calls.map((row, index) => index === 3 ? {...row, provenance: {compaction: true}} : row)}).cache.suspicions.length, 0);
  assert.equal(report({calls: calls.map((row, index) => index >= 3 ? {...row, mode: 'Fast'} : row)}).cache.suspicions.length, 0);
  assert.equal(report({calls: calls.map(row => ({...row, effort: null}))}).cache.suspicions.length, 0);
  assert.equal(report({calls: calls.map(row => ({...row, effort: 'unknown'}))}).cache.suspicions.length, 0);
  assert.equal(report({calls: calls.map((row, index) => ({...row, compactionEpoch: index >= 3 ? 1 : 0}))}).cache.suspicions.length, 0);
  assert.equal(report({calls: calls.map((row, index) => ({...row, resetEpoch: index >= 3 ? 1 : 0}))}).cache.suspicions.length, 0);
});

test('quota observation timestamps are bounded and preserve endpoints for host snapping', () => {
  const records = Array.from({length: 130}, (_, index) => record(base + index * 1000, index / 10));
  const result = report({records});
  assert.equal(result.coverage.observedTimeCount, 130);
  assert.equal(result.coverage.observedTimes.length, 50);
  assert.equal(result.coverage.observedTimes[0], base);
  assert.equal(result.coverage.observedTimes.at(-1), base + 129000);
  assert.equal(result.cycles.items[0].observedTimeCount, 130);
  assert.equal(result.cycles.items[0].observedStart, base);
  assert.equal(result.cycles.items[0].observedEnd, base + 129000);
});

test('cursor selects context but does not truncate explicit report/exclusion observation range', () => {
  const records = [record(base, 1), record(base + 2 * minute, 10), record(base + 4 * minute, 20)];
  const result = report({records, cursorTime: base + minute});
  assert.equal(result.coverage.observedTimes.at(-1), base + 4 * minute);
  assert.equal(result.cycles.items[0].observedEnd, base + 4 * minute);
  assert.equal(result.estimate.quotaDelta, 19);
});

test('malformed JSON metadata is sanitized without retaining prompts or changing input', () => {
  const diagnostics = {value: Infinity, count: 1n};
  diagnostics.loop = diagnostics;
  const calls = [call(1, undefined, {prompt: 'secret prompt', provenance: {source: 'fixture'}})];
  const result = report({calls, diagnostics});
  assert.equal(result.calls.items[0].prompt, undefined);
  assert.equal(result.diagnostics.loop, null);
  assert.equal(result.diagnostics.count, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('duplicate IDs are isolated by home and do not double-count one canonical request', () => {
  const original = call(1);
  const result = report({calls: [original, {...original}, {...original, homeKey: 'wsl'}]});
  assert.equal(result.summary.sourceCallCount, 3);
  assert.equal(result.summary.callCount, 2);
  assert.equal(result.coverage.duplicateCount, 1);
});

test('ambiguous accounts never combine costs or C2 attribution', () => {
  const result = analyze({provider: 'codex', calls: [call(1), call(2, undefined, {account: 'account-b'})], start: base, end: base + 10 * minute, now: base + 10 * minute});
  assert.equal(result.summary.account, null);
  assert.equal(result.summary.callCount, 0);
  assert.equal(result.estimate.valueUsdPer100Pct, null);
});

test('safe project basenames label calls and aggregate rows while duplicate names preserve hash identity', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const calls = [
    call(1, undefined, {project: first, projectName: 'extension'})
  , call(2, undefined, {project: second, projectName: 'extension'})
  ];
  const original = structuredClone(calls);
  const result = report({calls});
  assert.deepEqual(result.filterOptions.project, [first, second]);
  assert.equal(result.filterOptionCounts.project, 2);
  assert.deepEqual(result.projectLabels, {[first]: 'extension', [second]: 'extension'});
  for (const section of ['calls', 'sessions', 'requests', 'agents']) {
    assert.deepEqual(new Set(result[section].items.map(row => row.project)), new Set([first, second]));
    assert.ok(result[section].items.every(row => row.projectName === 'extension'));
  }
  const narrowed = report({calls, project: second});
  assert.equal(narrowed.summary.callCount, 1);
  assert.equal(narrowed.summary.project, second);
  assert.equal(narrowed.summary.projectName, 'extension');
  assert.equal(narrowed.calls.items[0].project, second);
  assert.deepEqual(narrowed.filterOptions.project, [first, second]);
  assert.deepEqual(calls, original);
});

test('project labels cover full source filter options and all returned detail IDs beyond top sessions', () => {
  const calls = Array.from({length: 130}, (_, index) => call(index, undefined, {project: index.toString(16).padStart(64, '0'), projectName: `repo-${index}`}));
  calls.push(call('foreign', undefined, {project: 'f'.repeat(64), projectName: 'foreign-private-repo', account: 'account-b'}));
  const result = report({calls});
  assert.equal(result.filterOptions.project.length, 50);
  assert.equal(result.filterOptionCounts.project, 130);
  const required = new Set([...result.filterOptions.project, ...['calls', 'sessions', 'requests', 'agents'].flatMap(section => result[section].items.map(row => row.project))]);
  for (const id of required) assert.equal(result.projectLabels[id], `repo-${Number.parseInt(id, 16)}`);
  assert.equal(Object.values(result.projectLabels).includes('foreign-private-repo'), false);
  const selected = calls[120].project;
  const narrowed = report({calls, project: selected});
  assert.equal(narrowed.filterOptions.project.length, 50);
  assert.ok(narrowed.filterOptions.project.includes(selected));
  assert.equal(narrowed.filterOptionCounts.project, 130);
  assert.equal(narrowed.projectLabels[selected], 'repo-120');
});

test('project names are explicit safe basenames only; raw paths and malformed names never enter labels or rows', () => {
  const names = ['C:\\private\\repository', '/home/private/repository', 'private/repository', '..', '.', 'x'.repeat(81), ' repo ', 'repo\nsecret', 'repo\u202ename', 'private／repository', 'private\u0085repo', 'private\u200brepo', null];
  const calls = names.map((name, index) => call(index, undefined, {project: index.toString(16).padStart(64, '0'), projectName: name}));
  calls.push(call('valid', undefined, {project: 'e'.repeat(64), projectName: '분석 모듈'}));
  calls.push(call('max', undefined, {project: 'd'.repeat(64), projectName: 'x'.repeat(80)}));
  const result = report({calls});
  assert.deepEqual(result.projectLabels, {['e'.repeat(64)]: '분석 모듈', ['d'.repeat(64)]: 'x'.repeat(80)});
  for (const section of ['calls', 'sessions', 'requests', 'agents']) {
    assert.ok(result[section].items.filter(row => row.project !== 'e'.repeat(64) && row.project !== 'd'.repeat(64)).every(row => row.projectName === null));
  }
  assert.equal(result.projectLabels['e'.repeat(64)], '분석 모듈');
  assert.equal(result.projectLabels['d'.repeat(64)], 'x'.repeat(80));
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('project labels use the source Unicode basename contract and never synthesize names for missing metadata', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const calls = [
    call(1, undefined, {project: first, projectName: '😀'.repeat(80)})
  , call(2, undefined, {project: second})
  ];
  const result = report({calls});
  assert.equal(result.projectLabels[first], '😀'.repeat(80));
  assert.equal(Object.hasOwn(result.projectLabels, second), false);
  assert.equal(result.calls.items.find(row => row.project === second).projectName, null);
  assert.deepEqual(result.filterOptions.project, [first, second]);
  assert.equal(report({calls, project: '__proto__'}).summary.projectName, null);
});
