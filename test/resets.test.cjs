const test = require('node:test');
const assert = require('node:assert/strict');
const {project, series, hash, thin} = require('../src/core.cjs');
const {preview} = require('../src/hover.cjs');
const now = Date.now(), minute = 60000, week = 7 * 86400000;
const sample = (id, i, used, reset, extra = {}) => ({v: 1, provider: id, account: hash(id), plan: 'one', time: now - (10 - i) * minute, windows: {five: null, week: {used, reset}}, ...(id === 'codex' ? {creditBalance: 1000 - i * 10} : {spentUsd: i / 10, spendPeriod: '2026-10'}), ...extra});
test('downsampling retains the true cycle end before missing readings at a reset', () => {
  const points = Array.from({length:5000},(_,i) => ({time:i,value:i > 1234 && i < 1301 ? null : i >= 1301 ? 1 : 43,continuous:i !== 1301}));
  points[1301].event = {kind:'scheduled-reset',time:1301,fromTime:1234};
  const reduced = thin(points,80);
  assert.ok(reduced.some(p => p.time === 1234 && p.value === 43));
  assert.ok(reduced.some(p => p.time === 1301 && p.event?.fromTime === 1234 && !p.continuous));
  assert.ok(reduced.length <= 82);
});
for (const id of ['codex', 'claude']) {
  test(`${id}: early weekly reset preserves total, restarts credits, and counts first observed quota from assumed zero`, () => {
    const reset = now + 3 * 86400000;
    const rows = [sample(id, 0, 90, reset), sample(id, 1, 100, reset), sample(id, 2, 1, now + week), sample(id, 3, 4, now + week)];
    const capacities = [{provider: id, account: hash(id), plan: 'one', window: 'week', time: now, mult: 5}];
    const p = project(rows, capacities)[id], points = p.windows.week;
    assert.deepEqual(points.map(p => p.delta), [null, 10, 1, 3]);
    assert.deepEqual(points.map(p => p.nativeCumulative), [0, 10, 11, 14]);
    assert.equal(points.at(-1).cumulative, 70);
    assert.equal(points[2].event.kind, 'early-reset'); assert.equal(points[2].estimatedDelta, true);
    assert.equal(points[2].continuous, false); assert.equal(points[2].totalContinuous, true);
    assert.equal(points.at(-1).cumulativeEstimated, true);
    const credit = p.ledger.map(p => p.credit);
    const factor = id === 'codex' ? 10 : .1;
    for (const [i, expected] of [0, 1, 0, 1].entries()) assert.ok(Math.abs(credit[i].usage - expected * factor) < 1e-9);
    assert.ok(Math.abs(credit.at(-1).total - 3 * factor) < 1e-9);
    assert.equal(credit[2].delta, null); assert.equal(credit[2].usageContinuous, false);
    const image = preview(rows, {now});
    assert.match(image.svg, new RegExp(`data-event="${id}-week"`));
    assert.match(image.summaries[id === 'codex' ? 0 : 1].event, /예정 전 초기화 관측/);
  });
  test(`${id}: a reset in one window never resets the other window or weekly credits`, () => {
    const reset = now + week;
    const rows = [sample(id, 0, 50, reset), sample(id, 1, 55, reset), sample(id, 2, 60, reset)];
    rows.forEach((r, i) => {r.windows.five = {used: [95, 100, 2][i], reset: now + (i < 2 ? 1 : 4) * 3600000};});
    const p = project(rows)[id];
    assert.equal(p.windows.five[2].event.kind, 'early-reset');
    assert.equal(p.windows.five[2].nativeCumulative, 7);
    assert.equal(p.windows.week[2].nativeCumulative, 10);
    assert.ok(Math.abs(p.ledger[2].credit.usage - (id === 'codex' ? 20 : .2)) < 1e-9);
  });
}
test('scheduled resets include first nonzero reading, even when it exceeds the previous cycle final reading', () => {
  const rows = [sample('codex', 0, 1, now - 9 * minute), sample('codex', 2, 4, now + week)];
  const p = series(rows, 'codex', 'week');
  assert.equal(p[1].event.kind, 'scheduled-reset'); assert.equal(p[1].delta, 4);
  assert.equal(p[1].nativeCumulative, 4); assert.equal(p[1].estimatedDelta, true);
});
test('schedule-only changes do not wipe credits or fabricate a reset assumption', () => {
  const rows = [sample('codex', 0, 90, now + week), sample('codex', 1, 95, now + week), sample('codex', 2, 96, now + week + 3600000)];
  const p = project(rows).codex;
  assert.equal(p.windows.week[2].event.kind, 'schedule-change'); assert.equal(p.windows.week[2].delta, null);
  assert.equal(p.ledger[2].credit.usage, 20); assert.equal(p.ledger[2].credit.delta, 10);
  assert.equal(p.windows.week[2].estimatedDelta, undefined);
});
test('missing windows and long gaps retain observable reset evidence without interpolating missing consumption', () => {
  const rows = [sample('codex', 0, 100, now + week), sample('codex', 1, 100, now + week, {windows: {five: null, week: null}}), sample('codex', 2, 2, now + week + 3600000)];
  const p = project(rows).codex;
  assert.equal(p.windows.week[2].delta, 2); assert.equal(p.windows.week[2].event.fromTime, rows[0].time);
  assert.equal(p.windows.week[2].totalContinuous, false); assert.equal(p.ledger[2].credit.usage, 0);
  const gap = [{...rows[0], time: now - 3 * 3600000}, rows[2]];
  assert.equal(series(gap, 'codex', 'week')[1].delta, 2);
  assert.equal(series(gap, 'codex', 'week')[1].totalContinuous, false);
  assert.equal(series([rows[2]], 'codex', 'week')[0].delta, null, 'first-ever sample does not imply a reset');
});
test('account and plan changes never impersonate provider resets', () => {
  const a = sample('codex', 0, 100, now + week), b = sample('codex', 1, 1, now + 2 * week);
  assert.equal(series([a, {...b, plan: 'other'}], 'codex', 'week')[1].event, undefined);
  assert.equal(series([a, {...b, account: hash('other')}], 'codex', 'week')[0].delta, null);
  const absent = {...sample('codex', 1, 0, now + week), plan: 'other', windows: {five: null, week: null}};
  assert.equal(series([a, absent, {...b, time: b.time + 60000}], 'codex', 'week')[2].event, undefined, 'missing quota on another plan cannot bridge the prior plan into a false reset');
});
for (const id of ['codex', 'claude']) test(`${id}: counter recovery up to the previous peak never becomes duplicate consumption`, () => {
  const rows = [10, 80, 20, 50, 85, 70, 86].map((used, i) => sample(id, i, used, now + week));
  const p = series(rows, id, 'week');
  assert.deepEqual(p.map(p => p.delta), [null, 70, null, 0, 5, null, 1]);
  assert.equal(p.at(-1).nativeCumulative, 76);
  assert.equal(p[3].recoveryExcluded, 30); assert.equal(p[4].recoveryExcluded, 30);
  assert.equal(p[2].event.kind, 'decrease'); assert.equal(p[2].estimatedDelta, undefined);
  assert.ok(Math.abs(project(rows)[id].ledger.at(-1).credit.usage - (id === 'codex' ? 60 : .6)) < 1e-9, 'uncertain quota decline never erases actual credit consumption');
  const changed = [...rows, sample(id, 7, 2, now + 2 * week), sample(id, 8, 4, now + 2 * week)];
  assert.equal(series(changed, id, 'week').at(-1).nativeCumulative, 80, 'confirmed reset clears the old peak and counts assumed first 2 plus next 2');
});
test('counter peak survives missing readings without making up cross-gap consumption', () => {
  const rows = [80, 20, 20, 50, 85].map((used, i) => sample('codex', i, used, now + week));
  rows[2].windows.week = null;
  const p = series(rows, 'codex', 'week');
  assert.equal(p[3].delta, null); assert.equal(p[4].delta, 5); assert.equal(p[4].nativeCumulative, 5);
});
