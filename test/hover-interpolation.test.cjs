const test = require('node:test');
const assert = require('node:assert/strict');
const {hash, project} = require('../src/core.cjs');
const {preview: renderPreview} = require('../src/hover.cjs');
function preview(records, options = {}) {
  const projection = project(records, options.capacities || []);
  for (const [id, provider] of Object.entries(projection)) for (const points of Object.values(provider.windows)) for (const p of points) {const factor = id === 'codex' ? .1 : 10; p.creditEstimate = {nativeUsage: p.credit.usage == null ? null : p.credit.usage * factor, nativeUsageContinuous: p.credit.usageContinuous};}
  return renderPreview(records, {...options, projection});
}
const {bridges} = require('../media/gaps.js');
const now = +new Date(2026, 9, 20, 12), hour = 3600000;
const row = (provider, ago, used, extra = {}) => ({
  v: 1, provider, account: hash(provider), plan: 'one', time: now - ago * hour
  , windows: {five: {used, reset: now + hour}, week: {used, reset: now + 7 * 24 * hour}}
  , ...(provider === 'codex' ? {creditBalance: 1000 - used * 10} : {spentUsd: used / 10, spendPeriod: '2026-10'})
  , ...extra
});
const trace = (svg, key) => svg.match(new RegExp(`<path[^>]*data-interpolated="${key}"[^>]*d="([^"]*)"[^>]*/>`))?.[1];
test('preview fills missing quota and credit interiors for both providers using the shared rules without rewriting observations', () => {
  const records = ['codex', 'claude'].flatMap(provider => [
    row(provider, 2, 10)
    , row(provider, 1.9, 11, {windows: {five: null, week: null}, creditBalance: null, spentUsd: null})
    , row(provider, 1.8, 20)
  ]).sort((a, b) => a.time - b.time);
  const before = JSON.stringify(records), totals = project(records);
  const p = preview(records, {now});
  for (const provider of ['codex', 'claude']) {
    for (const w of ['five', 'week', 'credit']) {
      assert.match(trace(p.svg, `${provider}-${w}`), /^M[\d.]+,[\d.]+L[\d.]+,[\d.]+$/);
      if (w !== 'credit') assert.equal(bridges(totals[provider].windows[w].map(p => ({...p, gapContext: p.segment})), 'value').length, 1);
    }
    assert.equal(p.summaries.find(s => s.name === (provider === 'codex' ? 'Codex' : 'Claude Code')).five, '20%');
  }
  assert.equal(JSON.stringify(records), before);
  assert.deepEqual(project(records), totals);
  assert.match(p.svg, /data-interpolated="codex-five"[^>]*stroke-width=".75"[^>]*stroke-dasharray="3 4"[^>]*opacity=".5"/);
});
test('left boundary retains an anchor beyond the old maxGap cutoff and clips interpolation and credit scale to the visible interval', () => {
  const rows = ['codex', 'claude'].flatMap(provider => [row(provider, 6, 20), row(provider, 4, 40)]).sort((a, b) => a.time - b.time);
  const p = preview(rows, {now});
  for (const provider of ['codex', 'claude']) {
    assert.equal(trace(p.svg, `${provider}-five`), 'M34.0,119.0L97.2,107.3');
    assert.equal(trace(p.svg, `${provider}-week`), 'M34.0,119.0L97.2,107.3');
    assert.equal(trace(p.svg, `${provider}-credit`), 'M34.0,142.3L97.2,130.7');
  }
});
test('preview never bridges resets, counter corrections, account or plan changes, capacity changes, topups or USD month boundaries', () => {
  for (const provider of ['codex', 'claude']) {
    const a = row(provider, 2, 30), missing = row(provider, 1.9, 31, {windows: {five: null, week: null}, creditBalance: null, spentUsd: null});
    const b = row(provider, 1.8, 40);
    const cases = [
      [a, missing, {...b, windows: {five: {used: 1, reset: now + 2 * hour}, week: {used: 1, reset: now + 8 * 24 * hour}}}]
      , [a, missing, {...b, windows: {five: {used: 1, reset: now + hour}, week: {used: 1, reset: now + 7 * 24 * hour}}}]
      , [a, {...missing, plan: 'other'}, b]
      , [a, missing, {...b, account: hash('other')}]
    ];
    for (const records of cases) assert.doesNotMatch(preview(records, {now}).svg, new RegExp(`data-interpolated="${provider}-`));
    const capacities = ['five', 'week'].flatMap(window => [
      {provider, account: a.account, plan: a.plan, window, time: a.time, mult: 1}
      , {provider, account: a.account, plan: a.plan, window, time: missing.time, mult: 5}
    ]);
    for (const w of ['five', 'week']) assert.equal(trace(preview([a, missing, b], {now, capacities}).svg, `${provider}-${w}`), undefined);
    const topup = {...b, ...(provider === 'codex' ? {creditBalance: 2000} : {spentUsd: 0})};
    assert.equal(trace(preview([a, missing, topup], {now}).svg, `${provider}-credit`), undefined);
    if (provider === 'claude') assert.equal(trace(preview([a, missing, {...b, spendPeriod: '2026-11'}], {now}).svg, 'claude-credit'), undefined);
  }
});
test('preview does not extrapolate to now, use future readings or invent missing cycle anchors', () => {
  for (const provider of ['codex', 'claude']) {
    const a = row(provider, 2, 10), missing = row(provider, 1, 20, {windows: {five: null, week: null}});
    assert.equal(trace(preview([a, missing, row(provider, -.1, 30)], {now}).svg, `${provider}-five`), undefined);
    const unknown = [a, row(provider, .1, 20)].map(r => ({...r, windows: {five: {...r.windows.five, reset: null}, week: null}}));
    assert.doesNotMatch(preview(unknown, {now}).svg, /data-interpolated/);
    assert.doesNotMatch(preview([row(provider, 9, 40)], {now}).svg, /data-interpolated/);
  }
});
test('many tiny gaps keep the SVG bounded and estimate only actual eligible pairs', () => {
  const records = ['codex', 'claude'].flatMap(provider => Array.from({length: 5000}, (_, i) => row(provider, (5000 - i) / 1000, i / 100, i % 2 ? {windows: {five: null, week: null}, creditBalance: null, spentUsd: null} : {}))).sort((a, b) => a.time - b.time);
  const p = preview(records, {now, dark: true});
  assert.ok(p.svg.length < 120000, `bounded SVG: ${p.svg.length}`);
  for (const provider of ['codex', 'claude']) for (const w of ['five', 'week', 'credit']) {
    const path = trace(p.svg, `${provider}-${w}`);
    assert.ok(path); assert.ok((path.match(/M/g) || []).length <= 122);
  }
  assert.doesNotMatch(p.svg, /NaN|Infinity/);
});
