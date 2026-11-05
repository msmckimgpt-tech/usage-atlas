const test = require('node:test');
const assert = require('node:assert/strict');
const {creditModes, project, series, hash, thin} = require('../src/core.cjs');
const now = Date.now(), week = 7 * 86400000, start = now - week - 3600000;
const row = (minutes, balance, reset, extra = {}) => ({v: 1, provider: 'codex', account: hash('modes'), plan: 'one', time: start + minutes * 60000, creditBalance: balance, windows: {five: {used: minutes % 100, reset: now + 3600000}, week: reset ? {used: minutes % 100, reset} : null}, ...extra});
test('weekly usage resets independently from lifetime credits and exact interval deltas', () => {
  const reset = start + 30 * 60000;
  const records = [row(0, 1000, reset), row(10, 900, reset), row(20, 850, reset), row(30, 830, reset + week), row(40, 800, reset + week)];
  const points = creditModes(records, 'codex');
  assert.deepEqual(points.map(p => p.credit.usage), [0, 100, 150, 0, 30]);
  assert.deepEqual(points.map(p => p.credit.delta), [null, 100, 50, null, 30]);
  assert.deepEqual(points.map(p => p.credit.total), [0, 100, 150, 170, 200]);
  assert.equal(points[3].credit.usageContinuous, false);
  const projected = project(records);
  for (const w of ['five', 'week']) assert.deepEqual(projected.codex.windows[w].map(p => p.credit), projected.codex.ledger.map(p => p.credit), 'same raw observation feeds quota conversion and native credits');
});
test('last weekly subscription anchor continues when quota is absent, without inventing prior cycles', () => {
  const reset = start + 30 * 60000;
  const p = creditModes([row(0, 1000, reset), row(10, 900), row(30, 880), row(40, 850), row(30 + week / 60000, 800)], 'codex');
  assert.deepEqual(p.map(p => p.credit.usage), [0, 100, 0, 30, 0]);
  assert.equal(p.at(-1).credit.reset, reset + 2 * week);
  assert.equal(creditModes([row(0, 10), row(1, 9)], 'codex')[1].credit.usage, null);
});
test('topups, missing data, collection gaps and monthly USD boundaries keep unit-safe modes', () => {
  const reset = now + week;
  const p = creditModes([row(0, 1000, reset), row(10, 900, reset), row(20, 1200, reset), row(30, null, reset), row(40, 1100, reset), row(100, 1000, reset)], 'codex');
  assert.deepEqual(p.map(p => p.credit.usage), [0, 100, 100, null, 100, 200]);
  assert.equal(p.at(-1).credit.delta, null); assert.equal(p.at(-1).credit.usageContinuous, false);
  const usd = [10, 12, 1, 2].map((spentUsd,i) => row(i * 10, 1000, reset, {provider:'claude',spentUsd,spendPeriod:i<2?'2026-09':'2026-10'}));
  assert.deepEqual(creditModes(usd,'claude').map(p=>p.credit.usage),[0,2,2,3]);
});
test('capacity retroactivity never crosses account, provider, plan or window; later changes retain timing', () => {
  const records = [row(0,1000,now+week), row(10,900,now+week), row(20,800,now+week), row(30,700,now+week,{plan:'other'})];
  const cap = {provider:'codex',account:hash('modes'),plan:'one',window:'week',time:records[1].time,mult:5};
  const capacities=[cap,{...cap,time:records[2].time,mult:20},{...cap,account:hash('other'),mult:100}];
  assert.deepEqual(series(records,'codex','week',capacities).map(p=>p.mult),[5,5,20,null]);
  assert.ok(series(records,'codex','five',capacities).every(p=>p.mult===null));
  assert.equal(series(records.map(r=>({...r,provider:'claude'})),'claude','week',capacities)[0].mult,null);
  assert.deepEqual(records.map(r=>r.windows.week.used),[0,10,20,30], 'raw usage is never rewritten');
});
test('downsampling preserves credit delta spikes and weekly reset lows without summing intervals', () => {
  const points=Array.from({length:10000},(_,i)=>({time:i,amount:i,continuous:true,credit:{usage:i%5000,delta:i===3211?10000:1,total:i,usageContinuous:i!==5000,deltaContinuous:i!==5000,totalContinuous:true}}));
  const reduced=thin(points,1500);
  assert.ok(reduced.length<=1502); assert.ok(reduced.some(p=>p.credit.delta===10000));
  assert.ok(reduced.some(p=>p.time===5000 && p.credit.usage===0));
  for(const p of reduced) assert.equal(p.credit.delta,points[p.time].credit.delta);
  const crossing=reduced.find((p,i)=>i>0 && reduced[i-1].time<5000 && p.time>=5000);
  assert.equal(crossing.credit.usageContinuous,false);
});
