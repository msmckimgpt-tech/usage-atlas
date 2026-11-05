'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {queryAnalysis} = require('../src/analysis-worker.cjs');
const {analyze} = require('../src/analytics.cjs');
const {hash} = require('../src/core.cjs');
function fixture(provider) {
  const now = Date.now(), account = hash('worker-fixture');
  return {
      provider
    , account
    , window: 'week'
    , now
    , start: now - 5000
    , end: now
    , cursorTime: now - 1500
    , calls: [{id: 'response-1', provider, account, homeKey: hash('worker-home'), sessionId: 'session-1', turnId: 'turn-1', project: 'fixture', time: now - 1500, startedAt: now - 2000, completedAt: now - 1500, completionState: 'completed', model: provider === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', effort: 'high', mode: 'Standard', input: 1000, cached: 100, cacheWrite5m: 0, cacheWrite1h: 0, output: 100, reasoning: provider === 'codex' ? 10 : null}]
    , records: [0, 1].map(i => ({v: 1, provider, account, time: now - (i ? 1000 : 3000), plan: 'fixture', source: 'import', windows: {five: null, week: {used: i ? 11 : 10, reset: now + 86400000}}}))
  };
}
test('isolated analysis preserves the exact provider report without mutating source observations', async () => {
  for (const provider of ['codex', 'claude']) {
    const input = fixture(provider), original = structuredClone(input);
    assert.deepEqual(await queryAnalysis(input, {threshold: 0}), analyze(input));
    assert.deepEqual(input, original);
  }
});
test('closing or superseding a detail request cancels the owned analysis worker', async () => {
  const controller = new AbortController();
  const operation = queryAnalysis(fixture('codex'), {threshold: 0, signal: controller.signal});
  controller.abort(); await assert.rejects(operation, error => error.code === 'ABORT_ERR');
  await assert.rejects(queryAnalysis(fixture('claude'), {signal: controller.signal}), error => error.code === 'ABORT_ERR');
});
