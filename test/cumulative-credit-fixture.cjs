'use strict';
const {hash, sanitize} = require('../src/core.cjs');
function fixture(now = Date.now()) {
  const records = [], calls = [], capacities = [], minute = 60000, start = now - 4 * minute;
  for (const provider of ['codex', 'claude']) {
    const account = hash('cumulative-' + provider), plan = 'cumulative-fixture';
    for (const window of ['five', 'week']) capacities.push({provider, account, plan, window, time: start, mult: 5});
    for (let i = 0; i < 5; i++) records.push(sanitize({v: 1, provider, account, plan, source: 'import', time: start + i * minute, windows: {five: {used: i ? 10 : 0, reset: now + 18000000}, week: {used: i ? 2 : 0, reset: now + 604800000}}, ...(provider === 'codex' ? {creditBalance: [1000, 1000, 900, 850, 800][i]} : {spentUsd: Math.max(0, i - 1) * 4, spendPeriod: new Date(now).toISOString().slice(0, 7)})}));
    for (let i = 1; i < 5; i++) {
      const incompleteMetadata = i === 3, time = start + i * minute - 1000;
      calls.push({id: provider + '-' + i, provider, account, homeKey: 'fixture', sessionId: 'cumulative', model: incompleteMetadata ? null : provider === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', mode: incompleteMetadata ? 'unknown' : i === 2 && provider === 'codex' ? 'Fast' : 'Standard', time, startedAt: incompleteMetadata ? null : start + (i - 1) * minute + 1000, completedAt: incompleteMetadata ? null : time, completionState: incompleteMetadata ? 'unknown' : 'completed', input: incompleteMetadata ? null : 1000000, cached: incompleteMetadata ? null : 0, output: incompleteMetadata ? null : 0, cacheWrite5m: 0, cacheWrite1h: 0, ...(incompleteMetadata ? {provenance: {observedAt: time}} : {})});
    }
  }
  records.sort((a, b) => a.time - b.time);
  return {records, calls, capacities, exclusions: [], now};
}
module.exports = {fixture};
