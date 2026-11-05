'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, hash, thin} = require('../src/core.cjs');
const chart = require('../media/chart-series.js');
const credits = require('../media/credit-series.js');
const {bridges, at} = require('../media/gaps.js');
const hour = 3600000, start = Date.UTC(2026, 9, 18);
const row = (provider, hours, used, reset, extra = {}) => ({
    v: 1, provider, account: hash(provider), plan: 'one', time: start + hours * hour
  , windows: {five: {used, reset: start + reset * hour}, week: {used, reset: start + reset * hour}}
  , ...(provider === 'codex' ? {creditBalance: 1000 - hours} : {spentUsd: hours, spendPeriod: '2026-10'})
  , ...extra
});
const fixture = provider => [
    row(provider, 0, 10, 5)
  , row(provider, .1, 20, 5)
  , row(provider, 7, 2, 12)
  , row(provider, 7.1, 3, 12)
];
const view = (provider, window, mode = 'total', options = {}) => chart.quota(provider, 'claude', window, {mode, ...options})[0].points;
test('both providers interpolate cumulative gaps across resets without estimating actual consumption', () => {
  for (const id of ['codex', 'claude']) {
    const records = fixture(id), original = JSON.stringify(records), provider = project(records)[id];
    const totals = JSON.stringify(provider);
    for (const window of ['five', 'week']) {
      const points = view(provider, window), found = bridges(points, 'y');
      assert.equal(found.length, 1);
      assert.deepEqual(found[0].map(p => p.time), [records[1].time, records[2].time]);
      assert.equal(at(found[0], 'y', (records[1].time + records[2].time) / 2), 11);
      assert.equal(provider.windows[window][2].delta, 2, 'only the approved first post-reset observation is counted');
      assert.equal(provider.windows[window].at(-1).nativeCumulative, 13);
      for (const mode of ['usage', 'delta']) assert.equal(bridges(view(provider, window, mode), 'y').length, 0);
    }
    assert.equal(JSON.stringify(provider), totals); assert.equal(JSON.stringify(records), original);
  }
});
test('early resets and missing window observations use cumulative-only interpolation', () => {
  const records = [row('claude', 0, 80, 5), row('claude', .1, 90, 5), row('claude', .2, 0, 5, {windows: {five: null, week: null}}), row('claude', .3, 1, 7)];
  const provider = project(records).claude;
  assert.equal(provider.windows.five.at(-1).event.kind, 'early-reset');
  assert.equal(bridges(view(provider, 'five'), 'y').length, 1);
  assert.equal(bridges(view(provider, 'five', 'usage'), 'y').length, 0);
});
test('cumulative interpolation still respects plan round-trips, capacity changes and counter corrections', () => {
  const records = fixture('claude');
  const cases = [
      [records[0], records[1], row('claude', 6, 0, 12, {plan: 'other', windows: {five: null, week: null}}), records[2], records[3]]
    , [records[0], records[1], {...records[2], plan: 'other'}, {...records[3], plan: 'other'}]
    , [row('claude', 0, 10, 12), row('claude', .1, 20, 12), row('claude', 7, 2, 12)]
    , [records[0], records[1], {...records[2], account: hash('new')}, {...records[3], account: hash('new')}]
  ];
  for (const rows of cases) assert.equal(bridges(view(project(rows).claude, 'five'), 'y').length, 0);
  const capacities = [
      {provider: 'claude', account: hash('claude'), plan: 'one', window: 'five', time: records[0].time, mult: 1}
    , {provider: 'claude', account: hash('claude'), plan: 'one', window: 'five', time: records[2].time, mult: 5}
  ];
  assert.equal(bridges(view(project(records, capacities).claude, 'five'), 'y').length, 0);
});
test('credit cumulative and additive curves bridge weekly resets while usage and monetary safety boundaries remain intact', () => {
  for (const id of ['codex', 'claude']) {
    const records = fixture(id), provider = project(records)[id];
    for (const points of Object.values(provider.windows)) for (const p of points) p.creditEstimate = {
        nativeTotal: p.credit.total, nativeUsage: p.credit.usage
      , nativeTotalKind: 'same-cohort', nativeTotalContinuous: p.credit.totalContinuous, nativeUsageContinuous: p.credit.usageContinuous
    };
    for (const s of credits.series(provider, id, {mode: 'total'})) assert.equal(bridges(s.points, 'y').length, 1);
    for (const s of credits.series(provider, id, {mode: 'usage'})) assert.equal(bridges(s.points, 'y').length, 0);
    assert.equal(bridges(view(provider, 'five', 'total', {credit: true, creditMode: 'estimate'}), 'y').length, 1);
    for (const extra of id === 'codex' ? [{creditBalance: 2000}] : [{spentUsd: 0}, {spendPeriod: '2026-11'}]) {
      const changed = project([records[0], records[1], {...records[2], ...extra}])[id];
      const points = changed.ledger.map(p => ({...p, y: p.credit.total, gapPolicy: 'cumulative', gapContext: p.credit.cumulativeSegment, continuous: p.credit.totalContinuous}));
      assert.equal(bridges(points, 'y').length, 0);
    }
  }
});
test('cumulative policy requires two monotonic endpoints in the same scope and survives thinning', () => {
  const a = {time: 0, y: 10, gapContext: 'same', gapPolicy: 'cumulative'}, b = {...a, time: 10, y: 20};
  assert.equal(bridges([a, b], 'y').length, 1);
  for (const other of [{...b, y: 9}, {...b, gapContext: null}, {...b, gapContext: 'other'}, {...b, gapPolicy: 'cycle'}]) assert.equal(bridges([a, other], 'y').length, 0);
  assert.equal(bridges([a, {time: 5, y: null}], 'y').length, 0);
  assert.equal(bridges([{time: 5, y: null}, b], 'y').length, 0);
  const p = project(fixture('claude')).claude;
  p.windows.five = thin(p.windows.five, 2);
  assert.equal(bridges(view(p, 'five'), 'y').length, 1);
});
