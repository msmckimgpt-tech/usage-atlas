const test = require('node:test');
const assert = require('node:assert/strict');
const {bridges,at,visible} = require('../media/gaps.js');
const {project,hash} = require('../src/core.cjs');
const now=Date.now(),minute=60000;
const row=(i,extra={})=>({v:1,provider:'codex',account:hash('gap'),plan:'one',time:now-(10-i)*minute,creditBalance:1000-i*10,windows:{five:{used:10+i,reset:now+3600000},week:{used:20+i,reset:now+7*86400000}},...extra});
const points=rows=>project(rows).codex.windows.five.map(p=>({...p,y:p.value,gapContext:p.segment}));
test('chart bridges only missing interiors, uses linear values, and never modifies observations',()=>{
  const p=points([row(0),row(1,{windows:{five:null,week:null}}),row(2),row(3)]),before=JSON.stringify(p);
  const lines=bridges(p,'y');assert.equal(lines.length,1);assert.equal(at(lines[0],'y',row(1).time),11);
  assert.deepEqual(visible(lines,'y',[row(.5).time,row(1.5).time]),[10.5,11.5]);assert.equal(JSON.stringify(p),before);
  assert.equal(bridges([p[1],p[2]],'y').length,0);assert.equal(bridges([p[0],p[1]],'y').length,0);
});
test('chart gaps cannot cross reset, quota correction, plan round-trip, account or capacity changes',()=>{
  const missing=row(1,{windows:{five:null,week:null}});
  for(const rows of [
    [row(0),missing,row(2,{windows:{five:{used:1,reset:now+7200000},week:null}})]
    , [row(0),missing,row(2,{windows:{five:{used:1,reset:now+3600000},week:null}})]
    , [row(0),{...missing,plan:'other'},row(2)]
    , [row(0),missing,row(2,{account:hash('other')})]
  ])assert.equal(bridges(points(rows),'y').length,0);
  const caps=[{provider:'codex',account:hash('gap'),plan:'one',window:'five',time:row(0).time,mult:1},{provider:'codex',account:hash('gap'),plan:'one',window:'five',time:row(1).time,mult:5}];
  const calibrated=project([row(0),missing,row(2)],caps).codex.windows.five.map(p=>({...p,y:p.value*p.mult,gapContext:p.segment}));
  assert.equal(bridges(calibrated,'y').length,0);
});
test('long missing collections bridge only inside one known cycle and keep actual totals unchanged',()=>{
  const rows=[row(0),row(1),row(100),row(101)],p=project(rows).codex;
  assert.equal(p.windows.week[2].delta,null);
  const view=p.windows.week.map(p=>({...p,y:p.value,gapContext:p.segment}));
  assert.equal(bridges(view,'y').length,1);
  const previousTotal=p.windows.week.at(-1).nativeCumulative;
  bridges(view,'y');assert.equal(p.windows.week.at(-1).nativeCumulative,previousTotal);
  const expired=view.map(p=>({...p,reset:now-5*minute}));assert.equal(bridges(expired,'y').length,0);
});
test('a schedule-only adjustment can fill a visual gap without claiming an actual reset',()=>{
  const rows=[row(0),row(1,{windows:{five:null,week:null}}),row(2,{windows:{five:{used:12,reset:now+7200000},week:{used:22,reset:now+8*86400000}}})];
  const p=project(rows).codex;
  assert.ok(p.events.every(e=>e.kind==='schedule-change'));
  assert.equal(bridges(points(rows),'y').length,1);
  assert.equal(p.windows.five.at(-1).delta,null,'visual fill does not impute consumption');
});
test('credit gaps preserve plan and currency-period barriers, topups and weekly resets',()=>{
  const creditView=rows=>project(rows)[rows.at(-1).provider].ledger.map(p=>({...p,amount:p.credit.usage,reset:p.credit.reset,gapContext:p.credit.segment,continuous:p.credit.usageContinuous}));
  assert.equal(bridges(creditView([row(0),row(1,{creditBalance:null}),row(2)]),'amount').length,1);
  for(const rows of [
    [row(0),row(1,{creditBalance:null,plan:'other'}),row(2)]
    , [row(0),row(1,{creditBalance:null}),row(2,{creditBalance:1200}),row(3)]
    , [row(0),row(1,{creditBalance:null}),row(2,{windows:{five:null,week:{used:1,reset:now+8*86400000}}})]
  ])assert.equal(bridges(creditView(rows),'amount').length,0);
  const usd=[row(0),row(1),row(2)].map((r,i)=>({...r,provider:'claude',spentUsd:i===1?null:10+i,spendPeriod:i<2?'2026-09':'2026-10'}));
  assert.equal(bridges(creditView(usd),'amount').length,0);
});
test('event downsampling always retains the latest schedule change for both windows',()=>{
  const rows=Array.from({length:3000},(_,i)=>row(i/1000,{windows:{five:{used:20,reset:now+3600000+i*120000},week:{used:30,reset:now+7*86400000+i*120000}}}));
  const p=project(rows).codex;
  for(const w of ['five','week'])assert.equal(p.events.filter(e=>e.window===w && e.kind==='schedule-change').at(-1).time,rows.at(-1).time);
  assert.equal(p.eventCount,5998);assert.ok(p.events.length<=2004);
});
