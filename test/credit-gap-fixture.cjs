'use strict';
const {hash, sanitize} = require('../src/core.cjs');
function fixture(now = Date.now()) {
  const base = now - 145 * 60000, records = [], calls = [], capacities = [];
  for (const provider of ['codex', 'claude']) {
    const account = hash('credit-gap-' + provider);
    for (const window of ['five', 'week']) capacities.push({provider, account, plan: 'one', window, mult: 5, time: base});
    for (const [index, minute] of [0, 1, 2, 144, 145].entries()) records.push({
        v: 1, provider, account, plan: 'one', time: base + minute * 60000
      , ...(provider === 'codex' ? {creditBalance: [1000, 1000, 900, 700, 650][index]} : {spentUsd: [0, 0, 4, 12, 14][index], spendPeriod: new Date(now).toISOString().slice(0, 7)})
      , windows: {five: {used: index ? 10 : 0, reset: now + 18000000}, week: {used: index ? 2 : 0, reset: now + 604800000}}
    });
    for (const minute of [1, 2]) calls.push({
        id: provider + minute, provider, account, homeKey: 'fixture', sessionId: 'session-' + provider
      , startedAt: base + (minute - 1) * 60000 + 1000, completedAt: base + minute * 60000 - 1000, time: base + minute * 60000 - 1000
      , completionState: 'completed', model: provider === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', mode: provider === 'codex' && minute === 2 ? 'Fast' : 'Standard'
      , input: 1000000, cached: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0
    });
  }
  return {records: records.sort((a, b) => a.time - b.time).map(sanitize), calls, capacities, now};
}
module.exports = {fixture};
