const test = require('node:test');
const assert = require('node:assert/strict');
const {hash, thin} = require('../src/core.cjs');
const {preview, resetRemaining} = require('../src/hover.cjs');
const now = Date.now(), hour = 3600000;
const sample = (ago, value, reset = now + hour, account = 'one') => ({v: 1, provider: 'codex', account: hash(account), time: now - ago * hour, plan: 'test', windows: {five: {used: value, reset}, week: null}});
test('hover covers exactly the last five hours without inventing missing usage', () => {
  const p = preview([sample(9, 99), sample(4.9, 20), sample(4.8, 30), sample(0.1, 50)], {now});
  assert.equal(p.start, now - 5 * hour); assert.equal(p.end, now);
  assert.equal(p.summaries[0].five, '50%'); assert.equal(p.summaries[0].week, '-');
  assert.equal(p.summaries[1].five, '-'); assert.match(p.svg, /clip-path="url\(#plot\)"/);
  const path = p.svg.match(/data-series="codex-five"><path d="([^"]*)"/)[1];
  assert.equal((path.match(/L/g) || []).length, 1, 'long collection gap is not connected');
  assert.equal((path.match(/M/g) || []).length, 2);
});
test('hover respects reset and current account; stale history stays empty', () => {
  const p = preview([sample(.4, 90), sample(.3, 95), sample(.2, 5, now + 6 * hour), sample(.1, 10, now + 6 * hour)], {now});
  const path = p.svg.match(/data-series="codex-five"><path d="([^"]*)"/)[1];
  assert.equal((path.match(/M/g) || []).length, 2, 'reset starts a new trace');
  const changed = preview([sample(.4, 95), sample(.1, 10, now + hour, 'two')], {now});
  assert.equal((changed.svg.match(/data-series="codex-five">(.*?)<\/g>/)[1].match(/<circle/g) || []).length, 1);
  const stale = preview([sample(9, 99)], {now});
  assert.doesNotMatch(stale.svg, /관측 없음|미제공/); assert.match(stale.summaries[0].status, /기록 지연/);
  assert.match(preview([], {now}).svg, />-<\/text>/);
});
test('hover reset countdown uses d h at 24h and h m below 24h, rounds remaining partial minutes up, and never invents a new reset', () => {
  assert.equal(resetRemaining(now + (2 * 24 * 60 + 3 * 60 + 4) * 60000, now), '2d 3h');
  assert.equal(resetRemaining(now + 1, now), '0h 1m');
  assert.equal(resetRemaining(now + 86400000, now), '1d 0h');
  assert.equal(resetRemaining(now + 86400000 - 1, now), '23h 59m');
  for (const reset of [null, undefined, NaN, now, now - 1]) assert.equal(resetRemaining(reset, now), '-');
  const p = preview([sample(.1, 20, now + hour)], {now});
  assert.equal(p.summaries[0].resets.five, '1h 0m'); assert.equal(p.summaries[0].resets.week, '-');
});
test('mini chart stays bounded for dense imports while keeping extrema and gaps', () => {
  const points = Array.from({length: 5000}, (_, i) => ({time: i, value: i === 3011 ? 100 : i === 3012 ? 0 : 50, continuous: i !== 2500}));
  const reduced = thin(points, 240);
  assert.ok(reduced.length <= 242); assert.ok(reduced.some(p => p.value === 100)); assert.ok(reduced.some(p => p.value === 0));
  assert.equal(reduced.find(p => p.time >= 2500).continuous, false);
  const records = Array.from({length: 5000}, (_, i) => sample((5000 - i) / 1000, i % 100));
  const p = preview(records, {now, dark: true});
  assert.ok(p.svg.length < 60000); assert.match(p.svg, /#62d0d8/); assert.doesNotMatch(p.svg, /NaN|<script|https?:\/\/(?!www.w3.org)/);
});

test('mini chart always includes both providers credit usage without mixing it into quota percentages', () => {
  const rows = ['codex', 'claude'].flatMap(provider => [0, 1].map(i => ({
    ...sample(.2 - i * .1, 30 + i * 5)
    , provider
    , account: hash(provider)
    , windows: {five:{used:30 + i * 5, reset:now + hour}, week:{used:40 + i * 5, reset:now + 24 * hour}}
    , ...(provider === 'codex' ? {creditBalance:1000 - i * 20} : {spentUsd:1 + i * .5, spendPeriod:'2026-10'})
  })));
  const p = preview(rows, {now});
  for (const provider of ['codex', 'claude']) assert.match(p.svg, new RegExp(`data-series="${provider}-credit"`));
  assert.doesNotMatch(p.svg, />(?:크레딧|USD) /);
  assert.equal(p.summaries[0].credit, '20 크레딧'); assert.equal(p.summaries[1].credit, '0.5 USD');
  for (const summary of p.summaries) {assert.equal(summary.five, '35%'); assert.equal(summary.week, '45%');}
});

test('mini chart draws only confirmed five-hour reset lines in provider colors at known scheduled deadlines or early observations', () => {
  const scheduled = now - 1.7 * hour, early = now - 1.4 * hour;
  const rows = ['codex','claude'].flatMap(provider => [0,1,2,3].map(i => ({
    ...sample([2,1.8,1.6,1.4][i], [80,90,1,0][i], i < 2 ? scheduled : i === 2 ? now + 3.3 * hour : now + 3.6 * hour)
    , provider, account:hash(provider)
    , windows:{five:{used:[80,90,1,0][i],reset:i < 2 ? scheduled : i === 2 ? now + 3.3 * hour : now + 3.6 * hour},week:{used:20+i,reset:now+24*hour}}
  })));
  const p = preview(rows, {now});
  for (const provider of ['codex','claude']) {
    const lines = [...p.svg.matchAll(new RegExp(`<line[^>]*data-reset-history="${provider}-five"[^>]*/>`, 'g'))].map(m => m[0]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], new RegExp(`data-time="${scheduled}"`)); assert.match(lines[1], new RegExp(`data-time="${early}"`));
    for (const line of lines) {assert.match(line, new RegExp(`stroke="${provider === 'codex' ? '#087a86' : '#b05428'}"`)); assert.doesNotMatch(line, /<text|<path/);}
  }
  const corrections = [sample(.4,80),sample(.3,20),sample(.2,30,now+2*hour)];
  assert.doesNotMatch(preview(corrections,{now}).svg,/data-reset-history/);
  assert.doesNotMatch(preview([sample(.1,10,now-hour)],{now}).svg,/data-reset-history/,'a deadline alone cannot prove a completed cycle');
});

test('mini chart uses hairline paths without per-observation dots, retaining isolated samples', () => {
  const p = preview(Array.from({length:100},(_,i) => sample((100-i)/100, i/2)), {now});
  const five = p.svg.match(/data-series="codex-five">(.*?)<\/g>/)[1];
  assert.match(five,/stroke-width="0.85"/); assert.doesNotMatch(five,/<circle/);
  assert.match(preview([sample(.1,10)],{now}).svg,/<circle[^>]*r="1.65"/);
});
