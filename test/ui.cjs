const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {series, project, hash} = require('../src/core.cjs');
const dir = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(dir, 'media', file), 'utf8');
const now = Date.now();
function estimatedFixture(data, factors = {codex: .01, claude: 10}) {
  for (const [id, provider] of Object.entries(data)) for (const points of Object.values(provider.windows || {})) for (const point of points) {
    point.creditEstimate = Object.assign({nativeTotalKind: 'same-cohort'}, Object.fromEntries(['usage', 'delta', 'total'].flatMap(mode => {const raw = point.credit?.[mode], base = raw == null ? null : raw * factors[id], native = base == null ? null : base / (point.mult || 1), field = 'native' + mode[0].toUpperCase() + mode.slice(1); return [[mode, base], [field, native], [mode + 'Continuous', point.credit?.[mode + 'Continuous'] || false], [field + 'Continuous', point.credit?.[mode + 'Continuous'] || false]];})));
  }
  return data;
}
function fixture() {
  const records = [], capacities = [];
  for (const id of ['codex', 'claude']) {
    capacities.push({provider: id, account: hash(id), plan: 'test', window: 'five', time: now - 86400000, mult: id === 'claude' ? 5 : 1});
    for (let n = 0; n <= 96; n++) {
      const t = now - (96 - n) * 900000;
      records.push({v: 1, provider: id, account: hash(id), plan: 'test', time: t, ...(id === 'codex' ? {creditBalance: 65000 - n * 40} : {spentUsd: n / 100, spendPeriod: '2026-10'}), windows: {five: {used: (n % 20) * 4, reset: now + (id === 'codex' ? 2 : 3) * 3600000 + Math.floor((n - 96) / 20) * 18000000}, week: {used: 20 + n / 2, reset: now + (id === 'codex' ? 21 : 45) * 3600000}}});
    }
  }
  return {type: 'data', now, theme: 1, colorMode: 'system', tooltipTransparency: 14, data: Object.fromEntries(Object.entries(estimatedFixture(project(records, capacities))).map(([id, p]) => [id, {...p, status: {message: '정상'}}]))};
}
const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${read('style.css')}</style></head><body>${read('body.html')}<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:s=>{window.saved=s;window.saves=(window.saves||0)+1;},postMessage:m=>{window.sent=m;}});</script><script>${read('d3.min.js')}</script><script>${read('gaps.js')}</script><script>${read('time-axis.js')}</script><script>${read('amount-format.js')}</script><script>${read('credit-series.js')}</script><script>${read('chart-series.js')}</script><script>${read('forecast.js')}</script><script>${read('provider-focus.js')}</script><script>${read('app.js')}</script></body></html>`;
(async () => {
  const browser = await chromium.launch(browserOptions);
  const report = {widths: [], errors: [], status: 'RUNNING'};
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}}); page.on('pageerror', e => report.errors.push(e.message));
    await page.setContent(doc);
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), fixture());
    await page.waitForSelector('[data-series]');
    const referenceFixture = fixture();
    for (const p of referenceFixture.data.codex.windows.week) p.mult = 1;
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), referenceFixture);
    await page.locator('#ua-basis').selectOption('base');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-series="claude-five"]')].some(n => n.__data__.some(p => p.value > 0 && p.y === p.value * 5)));
    const quotaTraces = () => page.locator('path[data-series]').evaluateAll(nodes => {
      const longest = new Map();
      for (const node of nodes) if (!longest.has(node.dataset.series) || node.__data__.length > longest.get(node.dataset.series).__data__.length) longest.set(node.dataset.series, node);
      return Object.fromEntries([...longest].map(([key,node]) => [key, {d:node.getAttribute('d'), values:node.__data__.map(p => p.y)}]));
    });
    const beforeRefs = await quotaTraces();
    await page.locator('#ua-refs').check(); await page.waitForTimeout(40);
    const afterRefs = await quotaTraces();
    for (const key of ['codex-five', 'codex-week', 'claude-five', 'claude-week']) {
      assert.notEqual(afterRefs[key].d, beforeRefs[key].d, `${key} responds to reference viewport expansion, including uncalibrated windows`);
      assert.deepEqual(afterRefs[key].values, beforeRefs[key].values, `${key} reference toggle preserves observed/calibrated values`);
    }
    await page.locator('#ua-refs').uncheck(); await page.waitForTimeout(40);
    assert.deepEqual(await quotaTraces(), beforeRefs, 'reference toggle restores all quota traces');
    for (const points of Object.values(referenceFixture.data.claude.windows)) for (const p of points) {p.mult=null; p.cumulative=0; p.cumulativeKnown=false;}
    for (const mode of ['usage', 'total']) {
      await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), referenceFixture);
      await page.locator('#ua-mode').selectOption(mode); await page.waitForTimeout(60);
      const before = await quotaTraces();
      await page.locator('#ua-refs').check(); await page.waitForTimeout(60);
      const after = await quotaTraces();
      for (const key of ['claude-five', 'claude-week']) {
        assert.notEqual(after[key].d, before[key].d, `both Claude windows without calibration respond in ${mode}`);
        assert.deepEqual(after[key].values, before[key].values, `${mode} never fabricates calibration`);
      }
      await page.screenshot({path:path.join(dir, 'screenshots', `references-${mode}-on.png`)});
      await page.locator('#ua-refs').uncheck(); await page.waitForTimeout(60);
      assert.deepEqual(await quotaTraces(), before, `both uncalibrated Claude windows restore in ${mode}`);
      if (mode === 'usage') await page.screenshot({path:path.join(dir, 'screenshots', 'references-usage-off.png')});
    }
    await page.locator('#ua-mode').selectOption('usage');
    report.references = 'PASS: both providers and windows, calibrated/unconverted axes change together without changing quota values';
    await page.locator('#ua-basis').selectOption('current'); await page.waitForTimeout(40);
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), fixture()); await page.waitForTimeout(40);
    const setPreference = async (key,value) => {await page.evaluate(({key,value})=>{window.uiModel={...window.uiModel,[key]:value};window.dispatchEvent(new MessageEvent('message',{data:window.uiModel}));},{key,value});await page.waitForTimeout(30);};
    const compactTooltip = async () => {
      const rows = await page.locator('#ua-tooltip > div').allTextContents();
      assert.match(rows[0], /^\d{2}\.\s*\d{2}\.\s*\([월화수목금토일]\)\s*\d{2}:\d{2}$/);
      for (const row of rows.slice(1)) assert.match(row, /^(Codex|Claude Code) \/ (5시간|주간|변화량|누적|5시간 환산|주간 환산) \/ (≈?-?[\d,]+(?:\.\d+)?(%|pp| 크레딧| USD)(?: · [\d,]+(?:\.\d+)? (?:크레딧|USD))?|-)$/);
      const series = rows.slice(1).map(row => row.split(' / ').slice(0, 2).join(' / ') + (row.endsWith(' 크레딧') || row.endsWith(' USD') ? ' credit' : ''));
      assert.equal(new Set(series).size, series.length, 'one row per touched graph');
      assert.doesNotMatch(rows.join('\n'), /배율|초기화|관측|발생 구간|회복|집계|보간|시작 가정/);
      return rows;
    };
    const hoverTrace = async (key, ratio = .5) => {
      const candidates = await page.locator(`path[data-series="${key}"]`).filter({hasNot: page.locator('title')}).evaluateAll((nodes, ratio) => nodes.filter(n=>n.__data__?.length > 2).flatMap(node=>[ratio,.15,.3,.45,.6,.75,.9].map(r=>{
        const p = node.getPointAtLength(node.getTotalLength() * r), matrix = node.getScreenCTM();
        return {x: p.x * matrix.a + p.y * matrix.c + matrix.e, y: p.x * matrix.b + p.y * matrix.d + matrix.f};
      })), ratio);
      for (const point of candidates) {
        await page.mouse.move(point.x, point.y); await page.waitForTimeout(20);
        const nativeMatch = key.includes('-credit') && (await page.locator('#ua-tooltip').textContent()).includes((key.startsWith('codex') ? 'Codex' : 'Claude Code') + ' / ' + (key.endsWith('-five') ? '5시간 환산' : '주간 환산') + ' / ');
        if ((nativeMatch || await page.locator('#ua-tooltip').getAttribute('data-series')===key) && !await page.locator('#ua-tooltip').getAttribute('data-detail')) break;
      }
      if (key.includes('-credit')) assert.ok((await page.locator('#ua-tooltip').textContent()).includes((key.startsWith('codex') ? 'Codex' : 'Claude Code') + ' / ' + (key.endsWith('-five') ? '5시간 환산' : '주간 환산') + ' / '));
      else assert.equal(await page.locator('#ua-tooltip').getAttribute('data-series'), key);
      assert.ok(await page.locator('#ua-tooltip .ua-tip-active').count() > 0);
      assert.doesNotMatch(await page.locator('#ua-tooltip').textContent(), /미제공|관측 없음/);
      assert.equal(await page.locator('#ua-tooltip').getAttribute('data-detail'), null);
      await compactTooltip();
    };
    await hoverTrace('codex-week'); await hoverTrace('claude-five', .7);
    assert.match(await page.locator('#ua-tooltip').evaluate(n => getComputedStyle(n).backgroundColor), /0\.86/);
    await page.locator('#ua-credit').check(); await page.locator('#ua-credit-mode').selectOption('money'); await page.waitForTimeout(40);
    await hoverTrace('codex-credit', .2);
    assert.match(await page.locator('#ua-tooltip').textContent(), /크레딧/);
    await page.screenshot({path: path.join(dir, 'screenshots', 'line-hover.png')});
    const resetLine = await page.locator('[data-reset="codex-five"]').boundingBox();
    await page.mouse.move(resetLine.x, resetLine.y + resetLine.height * .6);await page.waitForTimeout(20);
    assert.equal(await page.locator('#ua-tooltip').getAttribute('data-detail'), 'reset');
    assert.match(await page.locator('#ua-tooltip').textContent(), /Codex \/ 5시간 \/ 초기화 /);
    await page.screenshot({path: path.join(dir, 'screenshots', 'reset-line-tooltip.png')});
    const emptyPoint=await page.locator('[data-chart-frame]').boundingBox();
    await page.mouse.move(emptyPoint.x+emptyPoint.width*.1,emptyPoint.y+emptyPoint.height*.5);await page.waitForTimeout(30);
    assert.equal(await page.locator('#ua-tooltip > div').count(),1,'empty chart hover shows only the timestamp even with credits enabled');
    assert.doesNotMatch(await page.locator('#ua-tooltip').textContent(),/Codex|Claude|사용|크레딧|초기화/);
    assert.equal(await page.locator('#ua-tooltip').getAttribute('data-series'),null);
    await page.screenshot({path:path.join(dir,'screenshots','time-only-tooltip.png')});
    await hoverTrace('claude-five',.7);
    assert.match(await page.locator('#ua-tooltip').textContent(),/Claude Code \/ 5시간 \/ /);
    await page.locator('#ua-credit').uncheck(); await page.mouse.move(0, 0);
    report.tooltip = 'PASS: cursor timestamp once, model/window/usage only per touched quota/credit graph, no duplicate or explanatory rows, translucent background';
    const range = () => page.locator('#ua-chart').evaluate(n => ['domainStart', 'domainEnd', 'extentStart', 'extentEnd'].map(k => Number(n.dataset[k])));
    const week = 7 * 86400000;
    const checkDefault = async () => {const [a, b] = await range(); assert.equal(a, now - week); assert.equal(b, now + week);};
    const checkThumb = async () => {
      const [a, b, lo, hi] = await range();
      const box = await page.locator('#ua-navigator').boundingBox(), thumb = await page.locator('#ua-nav-thumb').boundingBox();
      assert.ok(Math.abs(thumb.width - box.width * (b - a) / (hi - lo)) <= 2.1, 'thumb width matches chart range within its border');
      assert.ok(Math.abs(thumb.x - box.x - box.width * (a - lo) / (hi - lo)) < 1, 'thumb position matches chart range');
    };
    await checkDefault(); await checkThumb();
    assert.equal(await page.locator('#ua-reset, #ua-plan, #ua-capacity, #ua-status, [data-goal]').count(), 0);
    for (const id of ['codex', 'claude']) assert.equal(await page.locator(`#ua-${id} [data-legend-cell]`).count(), 2);
    const geom = () => page.evaluate(() => ['usage-atlas', 'ua-chart', 'ua-credit-mode'].map(id => {const r = document.getElementById(id).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];}).concat([...[document.querySelector('[data-chart-frame]')].map(n => {const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];})]));
    for (const width of [320, 360, 700, 736, 1024, 1440, 1920]) {
      await page.setViewportSize({width, height: 900}); await page.waitForTimeout(60);
      const dateTicks = await page.locator('[data-date-tick]').evaluateAll(nodes => nodes.map(n => {const b = n.getBoundingClientRect(); return {text: n.textContent, left: b.left, right: b.right, top: b.top, bottom: b.bottom};}));
      assert.ok(dateTicks.length >= 2);
      for (const [i, tick] of dateTicks.entries()) {
        assert.match(tick.text, /[월화수목금토일]/, `weekday ${width}`);
        for (const previous of dateTicks.slice(0, i)) if (tick.top < previous.bottom && previous.top < tick.bottom) assert.ok(tick.left >= previous.right + 4 || previous.left >= tick.right + 4, `date tick overlap ${width}`);
      }
      const providerBoxes = await page.locator('.ua-provider').evaluateAll(nodes => nodes.map(n => {const r = n.getBoundingClientRect(); return {y: r.y, h: r.height, overflow: n.scrollWidth > n.clientWidth};}));
      assert.equal(providerBoxes[0].y, providerBoxes[1].y, `provider row ${width}`);
      assert.equal(providerBoxes[0].h, providerBoxes[1].h, `provider height ${width}`);
      assert.ok(providerBoxes.every(p => !p.overflow), `provider overflow ${width}`);
      await checkThumb();
      assert.ok(await page.locator('#ua-chart').evaluate(n => {const r = n.getBoundingClientRect(), frame = n.querySelector('[data-chart-frame]').getBoundingClientRect(); return r.right - frame.right <= 13;}), `right space reclaimed ${width}`);
      for (const basis of ['current', 'base']) {
        await page.locator('#ua-basis').selectOption(basis); await page.locator('#ua-credit').uncheck(); await page.waitForTimeout(30); const before = await geom();
        await page.locator('#ua-credit').check(); await page.locator('#ua-credit-mode').selectOption('money'); await page.waitForTimeout(30); assert.deepEqual(await geom(), before, `money shift ${width}`);
        assert.ok(await page.locator('[data-credit-unit="credits"]').count() > 0, `Codex native credits ${width}`);
        assert.ok(await page.locator('[data-credit-unit="USD"]').count() > 0, `separate USD ${width}`);
        assert.match(await page.locator('#ua-codex-credit').textContent(), /3,840/);
        assert.ok(await page.locator('#ua-chart').evaluate(n => {const box = n.getBoundingClientRect(); return [...n.querySelectorAll('[data-inside-axis]')].every(t => {const r = t.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right;});}), `inside axes fit ${width}`);
        await page.locator('#ua-credit-mode').selectOption('estimate'); await page.waitForTimeout(30); assert.deepEqual(await geom(), before, `estimate shift ${width}`);
        assert.equal(await page.locator('[data-credit-unit]').count(), 0, 'estimate mode never falls back to the native credit graph');
        assert.match(await page.locator('#ua-codex-credit').textContent(), /추정 합산/);
        assert.match(await page.locator('#ua-chart .ua-axis').textContent(), /추정/);
        assert.equal(await page.locator('#ua-theme, #ua-credit-setup, #ua-refresh').count(), 0);
        await page.locator('#ua-credit').uncheck(); await page.waitForTimeout(30); assert.deepEqual(await geom(), before, `off shift ${width}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${width}`);
        for (const mode of ['usage', 'delta', 'total']) {await page.locator('#ua-mode').selectOption(mode); await page.waitForTimeout(30); assert.equal(await page.locator('path[d*="NaN"]').count(), 0);}
        await page.locator('#ua-mode').selectOption('usage');
      }
      report.widths.push(width);
    }
    await page.setViewportSize({width: 1440, height: 900}); await page.locator('#ua-basis').selectOption('current'); await page.waitForTimeout(60);
    const calibrated = fixture(); estimatedFixture(calibrated.data);
    for (const points of Object.values(calibrated.data.codex.windows)) for (const p of points) p.mult = 1;
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), calibrated);
    await page.locator('#ua-credit').check(); await page.locator('#ua-credit-mode').selectOption('estimate'); await page.waitForTimeout(40);
    assert.ok(Math.abs(await page.locator('[data-series="codex-week"]').evaluate(n => n.__data__.at(-1).y) - 106.4) < .001, 'credits use per-credit conversion rather than USD conversion');
    assert.equal(await page.locator('[data-credit-unit="credits"]').count(), 0);
    assert.match(await page.locator('#ua-codex-credit').textContent(), /추정 합산/);
    fs.mkdirSync(path.join(dir, 'screenshots'), {recursive: true});
    await page.screenshot({path: path.join(dir, 'screenshots', 'credits-estimate.png')});
    await page.locator('#ua-settings').click(); assert.equal(await page.evaluate(() => window.sent.command), 'settings'); assert.equal(await page.locator('#ua-settings-dialog').count(),0);
    await page.locator('#ua-credit-mode').selectOption('money'); await page.waitForTimeout(40);
    assert.ok(await page.locator('[data-credit-unit="credits"]').count() > 0);
    assert.equal(await page.locator('[data-series="codex-week"]').evaluate(n => n.__data__.at(-1).y), 68, 'native mode preserves raw subscription usage');
    await page.screenshot({path: path.join(dir, 'screenshots', 'credits-native.png')});
    await page.locator('#ua-credit-mode').selectOption('estimate'); await page.waitForTimeout(40);
    assert.ok(Math.abs(await page.locator('[data-series="codex-week"]').evaluate(n => n.__data__.at(-1).y) - 106.4) < .001, 'switching back restores additive percent');
    await page.locator('#ua-credit').uncheck(); const pendingFixture = fixture(); for (const provider of Object.values(pendingFixture.data)) for (const points of Object.values(provider.windows)) for (const p of points) delete p.creditEstimate; await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), pendingFixture); await page.waitForTimeout(40);
    await page.locator('#ua-credit').check(); await page.waitForTimeout(40); await page.screenshot({path: path.join(dir, 'screenshots', 'credits-pending.png')});
    await page.locator('#ua-credit').uncheck(); await page.waitForTimeout(30);
    report.credits = 'PASS: distinct native/estimate modes, no fallback when unset, explicit pending state, backend-normalized automatic additive percent, settings action, no toggle shift';
    const modeRows = [1000,990,970,950].map((creditBalance,i) => ({v:1,provider:'codex',account:hash('codex'),plan:'modes',time:now-(3-i)*60000,creditBalance,windows:{five:{used:40+i*5,reset:now+3600000},week:{used:[90,95,0,2][i],reset:i<2?now-90000:now+week}}}));
    const modeCaps=['five','week'].map(window=>({provider:'codex',account:hash('codex'),plan:'modes',window,time:now,mult:5}));
    const modes={...fixture(),data:project(modeRows,modeCaps)};estimatedFixture(modes.data);
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),modes);
    await page.locator('#ua-codex').click(); await page.locator('#ua-credit').check();
    for(const mode of ['usage','delta','total']) {
      await page.locator('#ua-mode').selectOption(mode); await page.locator('#ua-credit-mode').selectOption('money'); await page.waitForTimeout(30);
      const native=await page.locator('[data-series="codex-credit"]').last().evaluate(n=>n.__data__?.at(-1)?.amount);
      assert.equal(native,mode==='total'?50:20);
      const without=await page.locator('[data-series="codex-week"]').last().evaluate(n=>n.__data__?.at(-1)?.y);
      await page.locator('#ua-credit-mode').selectOption('estimate'); await page.waitForTimeout(30);
      const combined=await page.locator('[data-series="codex-week"]').last().evaluate(n=>n.__data__?.at(-1)?.y);
      assert.ok(Math.abs(combined-without-native*.01/5)<1e-9,mode+' uses exactly the same native credit value');
    }
    await page.locator('#ua-credit-mode').selectOption('money');await page.waitForTimeout(30);
    await page.locator('[data-chart-hit]').focus(); for(let i=0;i<20;i++) await page.keyboard.press('+');
    await page.waitForTimeout(40);
    const extrema=await page.locator('[data-credit-minmax="credits"]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.value)));
    assert.ok(Math.abs(extrema[0]-40)<.001 && Math.abs(extrema[1]-50)<.001,'credit axis uses visible interpolation boundaries, not lifetime zero: '+JSON.stringify(extrema));
    await setPreference('tooltipTransparency',60);assert.match(await page.locator('#ua-tooltip').evaluate(n=>getComputedStyle(n).backgroundColor),/0\.4/);
    await setPreference('tooltipTransparency',14);
    await page.locator('#ua-navigator').dblclick(); await page.locator('#ua-codex').click();await page.locator('#ua-credit').uncheck();
    await page.locator('#ua-mode').selectOption('usage');
    report.creditModes='PASS: weekly reset, exact delta, lifetime total, shared native/conversion values, visible min/max with boundary interpolation, tooltip transparency settings';
    const gapRows=[];
    for(const provider of ['codex','claude'])for(let i=0;i<6;i++)gapRows.push({v:1,provider,account:hash(provider),plan:'gaps',time:now-(5-i)*60000,windows:{five:[2,3].includes(i)?null:{used:10+i*10-(provider==='claude'?5:0),reset:now+3600000},week:[2,3].includes(i)?null:{used:40+i*2,reset:now+week}},...(provider==='codex'?{creditBalance:[2,3].includes(i)?null:1000-i*10}:{spentUsd:[2,3].includes(i)?null:i/10,spendPeriod:'2026-10'})});
    const gapCaps=['codex','claude'].flatMap(provider=>['five','week'].map(window=>({provider,account:hash(provider),plan:'gaps',window,time:now,mult:1})));
    const gapData={...fixture(),data:project(gapRows,gapCaps)};
    estimatedFixture(gapData.data);
    const originalGaps=JSON.stringify(gapData.data);
    await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),gapData);await page.waitForTimeout(40);
    await page.locator('#ua-credit').check();await page.locator('#ua-credit-mode').selectOption('money');
    await page.locator('[data-chart-hit]').focus();for(let i=0;i<10;i++)await page.keyboard.press('+');await page.waitForTimeout(40);
    for(const mode of ['usage','delta','total']) {
      await page.locator('#ua-mode').selectOption(mode);await page.waitForTimeout(40);
      assert.equal(await page.locator('[data-interpolated]').count(),8,`${mode}: both providers quota windows and credits fill missing interiors`);
      const values=await page.locator('[data-series="codex-five"]').evaluateAll(nodes=>nodes.flatMap(n=>n.__data__));
      assert.equal(values.find(p=>p.time===now).nativeCumulative,gapData.data.codex.windows.five.at(-1).nativeCumulative);
    }
    await page.locator('#ua-mode').selectOption('usage');await page.waitForTimeout(40);
    const creditOnlyRows=gapRows.map((r,i)=>({...r,windows:{five:{used:10+(i%6)*10,reset:now+3600000},week:{used:40+(i%6)*2,reset:now+week}}}));
    const creditOnlyData={...gapData,data:project(creditOnlyRows,gapCaps)};estimatedFixture(creditOnlyData.data);
    await page.locator('#ua-credit-mode').selectOption('estimate');await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),creditOnlyData);await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-interpolated]').count(),4,'missing credit components are interpolated instead of switching to raw quota values');
    await page.locator('#ua-credit-mode').selectOption('money');await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),gapData);await page.waitForTimeout(40);
    const bridgePoint=await page.locator('[data-interpolated="codex-five"]').evaluate(n=>{const p=n.getPointAtLength(n.getTotalLength()/2),m=n.getScreenCTM();return{x:p.x*m.a+p.y*m.c+m.e,y:p.x*m.b+p.y*m.d+m.f};});
    await page.mouse.move(bridgePoint.x,bridgePoint.y);await page.waitForTimeout(30);
    assert.ok((await compactTooltip()).includes('Codex / 5시간 / ≈35%'));
    assert.equal(await page.evaluate(()=>JSON.stringify(window.uiModel.data)),originalGaps,'visual interpolation does not write inferred observations');
    await page.screenshot({path:path.join(dir,'screenshots','interpolated-tooltip.png')});
    const gapBounds=await page.locator('[data-chart-hit]').boundingBox(),gapDomain=await page.locator('#ua-chart').evaluate(n=>[Number(n.dataset.domainStart),Number(n.dataset.domainEnd)]);
    const gapX=time=>gapBounds.x+(time-gapDomain[0])/(gapDomain[1]-gapDomain[0])*gapBounds.width;
    await page.mouse.move(gapX(now-3.5*60000),gapBounds.y+gapBounds.height/2);await page.mouse.down();await page.mouse.move(gapX(now-1.5*60000),gapBounds.y+gapBounds.height/2,{steps:5});await page.mouse.up();await page.waitForTimeout(40);
    const gapCreditLimits=await page.locator('[data-credit-minmax="credits"]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.value)));
    assert.ok(gapCreditLimits[0]<=10 && gapCreditLimits[1]>=10,'zoomed empty gap uses interpolated credit bounds instead of an unrelated 0..1 axis');
    await page.locator('#ua-credit').uncheck();await page.locator('#ua-navigator').dblclick();
    report.interpolation='PASS: missing quota/credit interiors in all modes, compact approximate usage row, observed values and raw model preserved';
    const changingRows=[];
    for(const provider of ['codex','claude'])for(let i=0;i<7;i++)changingRows.push({v:1,provider,account:hash(provider),plan:'changing',time:now-(6-i)*300000,windows:{five:{used:10+i,reset:now+5*3600000+i*120000},week:{used:20+i,reset:now+week+i*120000}}});
    const changingData={...fixture(),data:project(changingRows)};
    await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),changingData);await page.waitForTimeout(40);
    await page.locator('[data-chart-hit]').focus();for(let i=0;i<10;i++)await page.keyboard.press('+');await page.waitForTimeout(40);
    const changeMarks=()=>page.locator('[data-event-kind="schedule-change"]');
    assert.equal(await changeMarks().count(),4,'only the latest schedule change for each provider/window survives');
    assert.ok((await changeMarks().evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.time)))).every(t=>t===now));
    for(const provider of ['codex','claude'])assert.equal(changingData.data[provider].events.length,12,'original change history stays intact');
    await page.screenshot({path:path.join(dir,'screenshots','latest-schedule-changes.png')});
    await page.locator('#ua-nav-pan').focus();await page.keyboard.press('PageUp');await page.waitForTimeout(40);
    assert.equal(await changeMarks().count(),0,'older viewport cannot revive superseded changes');
    const nextChanging={...changingData,now:now+60000,data:project([...changingRows,...['codex','claude'].map(provider=>({...changingRows.findLast(r=>r.provider===provider),time:now+60000,windows:{five:{used:17,reset:now+5*3600000+20*60000},week:{used:27,reset:now+week+20*60000}}}))])};
    await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),nextChanging);await page.locator('#ua-navigator').dblclick();await page.waitForTimeout(40);
    assert.equal(await changeMarks().count(),4);assert.ok((await changeMarks().evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.time)))).every(t=>t===now+60000),'new data replaces the previous marks');
    report.scheduleChanges='PASS: latest per provider/window, replacement on data update, no revival in older viewport, raw history preserved';
    const cycleRows=[];
    for (const provider of ['codex','claude']) for (let i=0;i<6;i++) cycleRows.push({v:1,provider,account:hash(provider),plan:'cycles',time:now-(5-i)*60000,windows:{
      five:{used:(provider==='codex'?[50,80,2,8,1,5]:[35,68,3,12,2,6])[i],reset:i<2?now-3.5*60000:i<4?now+5*3600000-3*60000:now+5*3600000}
      , week:{used:(provider==='codex'?[60,62,65,3,10,1]:[45,50,55,2,7,1])[i],reset:i<3?now-2.5*60000:i<5?now+week:now+week+3600000}
    }});
    const cycleData={...fixture(),data:project(cycleRows,['codex','claude'].flatMap(provider=>['five','week'].map(window=>({provider,account:hash(provider),plan:'cycles',window,time:now,mult:5}))))};
    await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),cycleData);await page.waitForTimeout(40);
    await page.locator('[data-chart-hit]').focus();for(let i=0;i<10;i++)await page.keyboard.press('+');await page.waitForTimeout(40);
    for (const mode of ['usage','delta','total']) {
      await page.locator('#ua-mode').selectOption(mode);await page.waitForTimeout(40);
      const markers=await page.locator('[data-cycle-end]').evaluateAll(nodes=>nodes.map(n=>({series:n.dataset.cycleEnd,time:Number(n.dataset.time),value:n.__data__.y,raw:n.__data__.value,kind:n.dataset.resetKind,transform:n.getAttribute('transform')})));
      assert.equal(markers.length,8,`${mode}: both completed cycles for each provider/window`);
      for(const provider of ['codex','claude']) for(const w of ['five','week']) {
        const ends=markers.filter(m=>m.series===`${provider}-${w}`);
        assert.deepEqual(ends.map(m=>m.time),w==='five'?[now-4*60000,now-2*60000]:[now-3*60000,now-60000]);
        assert.deepEqual(ends.map(m=>m.kind),['scheduled-reset','early-reset']);
        const points=await page.locator(`[data-series="${provider}-${w}"]`).evaluateAll(nodes=>nodes.flatMap(n=>n.__data__));
        for(const end of ends) assert.equal(end.value,points.find(p=>p.time===end.time).y,'marker uses the actual pre-reset chart value');
      }
      assert.ok(await page.locator('path[data-series][stroke-width]').evaluateAll(nodes=>nodes.every(n=>Number(n.getAttribute('stroke-width'))<=1.1 && n.getAttribute('vector-effect')==='non-scaling-stroke')));
      for (const provider of ['codex','claude']) {
        const end = page.locator(`[data-cycle-end="${provider}-five"]`).first(), box = await end.boundingBox();
        const value = await end.evaluate(n=>n.__data__.y);
        await page.mouse.move(box.x+box.width/2, box.y+box.height/2);await page.waitForTimeout(20);
        assert.equal(await page.locator('#ua-tooltip').getAttribute('data-detail'), 'marker');
        assert.match(await page.locator('#ua-tooltip').textContent(), /관측|배율/);
        assert.match(await page.locator('#ua-tooltip').textContent(), /초기화/);
        assert.ok((await page.locator('#ua-tooltip > div').allTextContents()).some(row=>row.startsWith(`${provider==='codex'?'Codex':'Claude Code'} / 5시간 / ${Math.round(value*10)/10}${mode==='delta'?'pp':'%'}`)));
        assert.ok(await page.locator('#ua-tooltip > div').count()<=6, 'completed markers merge repeated usage, time and event metadata');
      }
    }
    await page.locator('#ua-mode').selectOption('usage');await page.waitForTimeout(40);
    await page.screenshot({path:path.join(dir,'screenshots','cycle-ends-light.png')});
    await setPreference('colorMode','dark');await page.screenshot({path:path.join(dir,'screenshots','cycle-ends-dark.png')});await setPreference('colorMode','system');
    await page.locator('#ua-codex').click();await page.waitForTimeout(40);assert.equal(await page.locator('[data-cycle-end^="claude-"]').count(),0);await page.locator('#ua-codex').click();
    const noCycle={...fixture(),data:project(cycleRows.filter(r=>r.time===now))};
    await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),noCycle);await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-cycle-end]').count(),0,'active latest endpoints are not completed cycles');
    const isolated = await page.locator('[data-series="codex-five"]').first().boundingBox();
    await page.mouse.move(isolated.x+isolated.width/2,isolated.y+isolated.height/2);await page.waitForTimeout(20);
    assert.equal(await page.locator('#ua-tooltip').getAttribute('data-detail'),'marker');
    assert.match(await page.locator('#ua-tooltip').textContent(),/관측|다음 초기화/);
    await page.locator('#ua-navigator').dblclick();
    report.cycleEnds='PASS: both providers/windows, scheduled and early cycle endpoints, all modes, true pre-reset observations, active-cycle exclusion, provider focus and hairline strokes';
    const resetRows=[];
    for(const provider of ['codex','claude']) for(let i=0;i<4;i++) resetRows.push({v:1,provider,account:hash(provider),plan:'reset',time:now-(3-i)*60000,windows:{five:null,week:{used:[90,100,1,3][i],reset:i<2?now+3*86400000:now+week}},...(provider==='codex'?{creditBalance:1000-i*10}:{spentUsd:i/10,spendPeriod:'2026-10'})});
    const resetData={...fixture(),data:project(resetRows,['codex','claude'].map(provider=>({provider,account:hash(provider),plan:'reset',window:'week',time:now,mult:5})))};estimatedFixture(resetData.data);
    await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),resetData);await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-event-kind="early-reset"]').count(),2);
    await page.locator('[data-chart-hit]').focus();for(let i=0;i<12;i++)await page.keyboard.press('+');await page.waitForTimeout(40);
    const tickBoxes=await page.locator('[data-date-tick]').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));for(let i=1;i<tickBoxes.length;i++)assert.ok(tickBoxes[i].left>=tickBoxes[i-1].right+7,'zoomed time labels never overlap');
    const mark=await page.locator('[data-event="codex-week"]').boundingBox();await page.mouse.move(mark.x+mark.width/2,mark.y+mark.height/2);await page.waitForTimeout(30);
    assert.equal(await page.locator('#ua-tooltip').getAttribute('data-series'),'event');
    assert.equal(await page.locator('#ua-tooltip').getAttribute('data-detail'),'event');
    assert.match(await page.locator('#ua-tooltip').textContent(),/예정 전 초기화/);
    assert.match(await page.locator('#ua-tooltip').textContent(),/100% → 1%/);
    assert.match(await page.locator('#ua-tooltip').textContent(),/관측 .+ → \d{2}:\d{2}/);
    assert.match(await page.locator('#ua-tooltip').textContent(),/예정 .+ → /);
    assert.match(await page.locator('#ua-tooltip').textContent(),/0% 가정 · 첫 1% 포함/);
    assert.match(await page.locator('#ua-tooltip').textContent(),/크레딧 재시작\(누적 유지\)/);
    assert.equal(await page.locator('#ua-tooltip > div').count(),5,'identical provider events share one compact detail block');
    assert.match(await page.locator('#ua-tooltip .ua-tip-active').textContent(),/Codex · Claude Code \/ 주간 \/ 100% → 1%/);
    await page.screenshot({path:path.join(dir,'screenshots','early-reset.png')});
    const eventLine=await page.locator('[data-event-line="codex-week"]').boundingBox();
    await page.mouse.move(eventLine.x,eventLine.y+eventLine.height*.6);await page.waitForTimeout(20);
    assert.equal(await page.locator('#ua-tooltip').getAttribute('data-detail'),'event');
    assert.match(await page.locator('#ua-tooltip').textContent(),/100% → 1%/);
    await page.locator('#ua-mode').selectOption('total');await page.waitForTimeout(30);
    assert.equal(await page.locator('[data-series="codex-week"]').last().evaluate(n=>n.__data__.at(-1).y),13);
    await hoverTrace('codex-week',.7);
    await page.mouse.move(mark.x+mark.width/2,mark.y+mark.height/2);await page.waitForTimeout(20);
    assert.match(await page.locator('#ua-tooltip').textContent(),/예정 전 초기화/);
    await page.locator('#ua-mode').selectOption('delta');await page.waitForTimeout(30);
    assert.equal(await page.locator('[data-series="codex-week"]').last().evaluate(n=>n.__data__.at(-1).y),2);
    await page.mouse.move(mark.x+mark.width/2,mark.y+mark.height/2);await page.waitForTimeout(20);
    assert.match(await page.locator('#ua-tooltip').textContent(),/100% → 1%/);
    await page.locator('#ua-credit').check();await page.locator('#ua-credit-mode').selectOption('money');await page.locator('#ua-mode').selectOption('usage');await page.waitForTimeout(30);
    assert.equal(await page.locator('[data-series="codex-credit"]').last().evaluate(n=>n.__data__.at(-1).amount),10);
    await page.locator('#ua-mode').selectOption('total');await page.waitForTimeout(30);
    assert.equal(await page.locator('[data-series="codex-credit"]').last().evaluate(n=>n.__data__.at(-1).amount),30);
    await page.locator('#ua-credit').uncheck();await page.locator('#ua-mode').selectOption('usage');await page.locator('#ua-navigator').dblclick();
    const compactRows=[99,100,0].map((used,i)=>({v:1,provider:'claude',account:hash('claude'),plan:'compact',time:now-(2-i)*60000,windows:{five:null,week:{used,reset:i<2?now-30000:now+week}}}));
    await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),{...fixture(),data:project(compactRows)});await page.waitForTimeout(30);
    await page.locator('[data-chart-hit]').focus();for(let i=0;i<12;i++)await page.keyboard.press('+');await page.waitForTimeout(30);
    const compactEnd=await page.locator('[data-cycle-end="claude-week"]').boundingBox();
    await page.mouse.move(compactEnd.x+compactEnd.width/2,compactEnd.y+compactEnd.height/2);await page.waitForTimeout(20);
    const compactRowsText=await page.locator('#ua-tooltip > div').allTextContents();
    assert.equal(compactRowsText.length,5,'weekly completion is five rows including cursor time');
    assert.equal(compactRowsText[1],'Claude Code / 주간 / 100% → 0% · 초기화');
    assert.match(compactRowsText[2],/^관측 .+ → \d{2}:\d{2}$/);
    assert.match(compactRowsText[3],/^예정 .+ → /);
    assert.equal(compactRowsText[4],'크레딧 재시작(누적 유지)');
    assert.equal(compactRowsText.join(' ').match(/100%/g).length,1,'usage is not repeated across header and event details');
    await page.screenshot({path:path.join(dir,'screenshots','compact-cycle-tooltip-light.png')});
    await setPreference('colorMode','dark');await page.mouse.move(compactEnd.x+compactEnd.width/2,compactEnd.y+compactEnd.height/2);await page.waitForTimeout(20);
    await page.screenshot({path:path.join(dir,'screenshots','compact-cycle-tooltip-dark.png')});await setPreference('colorMode','system');
    await page.locator('#ua-navigator').dblclick();
    report.resets='PASS: compact marker/vertical-line details retain transitions, observation interval, deadlines and assumptions; identical provider events share one five-row block; weekly completion shows usage once in five rows; calibrated delta/total and isolated markers preserved';
    const recoveryRows=[10,80,20,50,85].map((used,i)=>({v:1,provider:'codex',account:hash('codex'),plan:'recovery',time:now-(4-i)*60000,windows:{five:null,week:{used,reset:now+week}},creditBalance:1000-i*10}));
    const recoveryData={...fixture(),data:project(recoveryRows,[{provider:'codex',account:hash('codex'),plan:'recovery',window:'week',time:now,mult:5}])};
    await page.evaluate(data=>(window.uiModel=data,window.dispatchEvent(new MessageEvent('message',{data}))),recoveryData);await page.waitForTimeout(30);
    await page.locator('[data-chart-hit]').focus();for(let i=0;i<12;i++)await page.keyboard.press('+');await page.waitForTimeout(30);
    const recoveryMark=await page.locator('[data-event-kind="decrease"]').boundingBox();await page.mouse.move(recoveryMark.x+recoveryMark.width/2,recoveryMark.y+recoveryMark.height/2);await page.waitForTimeout(20);
    assert.match(await page.locator('#ua-tooltip').textContent(),/사용률 하락/);
    assert.match(await page.locator('#ua-tooltip').textContent(),/최고값까지 회복 제외/);
    await page.locator('#ua-mode').selectOption('delta');await page.waitForTimeout(30);assert.equal(await page.locator('[data-series="codex-week"]').last().evaluate(n=>n.__data__.at(-1).y),5);
    await page.locator('#ua-mode').selectOption('total');await page.waitForTimeout(30);assert.equal(await page.locator('[data-series="codex-week"]').last().evaluate(n=>n.__data__.at(-1).y),75);
    await page.locator('#ua-basis').selectOption('base');await page.waitForTimeout(30);assert.equal(await page.locator('[data-series="codex-week"]').last().evaluate(n=>n.__data__.at(-1).y),375);
    await page.locator('#ua-mode').selectOption('usage');await page.locator('#ua-basis').selectOption('current');await page.locator('#ua-navigator').dblclick();
    report.recovery='PASS: usage decline marker, previous peak retained, recovery excluded, only new excess counted, base capacity alignment';
    // 배율이 뒤늦게 설정된 실제 장애와 완전 환산 계열의 혼합 축을 재현한다.
    const cumulative = fixture(), first = now - 400000;
    const observed = [49, 60, 82, 82, 84].map((used, i) => ({v: 1, provider: 'codex', account: hash('codex'), plan: 'test', time: first + i * 100000, windows: {five: null, week: {used, reset: now + week}}}));
    cumulative.data.codex = {...project(observed, [{provider: 'codex', account: hash('codex'), plan: 'test', window: 'week', mult: 5, time: first + 300000}]).codex};
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), cumulative);
    await page.locator('#ua-codex').click(); await page.locator('#ua-mode').selectOption('total'); await page.waitForTimeout(40);
    assert.match(await page.locator('#ua-chart .ua-axis').textContent(), /관측 누적 %/);
    assert.deepEqual(await page.locator('[data-series="codex-week"]').evaluate(n => n.__data__.map(p => p.y)), [0, 11, 33, 33, 35], 'calibration never erases historical cumulative growth');
    await page.locator('#ua-credit').check(); await page.locator('#ua-credit-mode').selectOption('estimate'); await page.waitForTimeout(40);
    assert.match(await page.locator('#ua-codex-credit').textContent(), /자동 환산 대기/);
    assert.equal(await page.locator('[data-series="codex-week"]').evaluate(n => n.__data__.at(-1).y), 35, 'missing credit records never fabricate an additive amount');
    await page.locator('#ua-credit').uncheck(); await page.locator('#ua-basis').selectOption('base'); await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-series="codex-week"]').evaluate(n => n.__data__.at(-1).y), 175);
    assert.equal(await page.locator('[data-series="codex-week"]').evaluate(n => n.__data__.at(-1).y), 175);
    cumulative.data.claude.windows = {five: [], week: series(observed.map(r => ({...r, provider: 'claude', account: hash('claude')})), 'claude', 'week', [{provider: 'claude', account: hash('claude'), plan: 'test', window: 'week', mult: 5, time: first}])};
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), cumulative);
    await page.locator('#ua-basis').selectOption('current'); await page.locator('#ua-codex').click(); await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-series="codex-week"]').evaluate(n => n.__data__.at(-1).y), 35, 'retroactive same-plan calibration uses current capacity');
    assert.equal(await page.locator('[data-series="claude-week"]').evaluate(n => n.__data__.at(-1).y), 35, 'fully calibrated total uses current capacity');
    await page.locator('#ua-basis').selectOption('base'); await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-series="claude-week"]').evaluate(n => n.__data__.at(-1).y), 175, 'base total weights each observed increase');
    report.cumulative = 'PASS: retroactive calibration preserves cumulative growth, current/base capacity consistency, missing-credit conversion stays pending';
    await page.screenshot({path: path.join(dir, 'screenshots', 'cumulative-mixed.png')});
    await page.locator('#ua-basis').selectOption('current'); await page.locator('#ua-mode').selectOption('usage');
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), fixture()); await page.waitForTimeout(40);
    assert.equal(await page.locator('[data-reset]').count(), 4); assert.equal(await page.locator('[data-goal]').count(), 0);
    assert.equal(new Set(await page.locator('[data-series]').evaluateAll(nodes => nodes.map(n => n.dataset.series))).size, 4);
    const hit = await page.locator('[data-chart-hit]').boundingBox();
    await page.mouse.move(hit.x + hit.width * .1, hit.y + 40); await page.mouse.down(); await page.mouse.move(hit.x + hit.width * .45, hit.y + 40); await page.mouse.up(); await page.waitForTimeout(30);
    assert.ok(await page.evaluate(() => saved.range));
    await checkThumb();
    await page.locator('#ua-navigator').dblclick(); await page.waitForTimeout(30); await checkDefault(); await checkThumb();
    await page.locator('[data-chart-hit]').focus(); await page.keyboard.press('+'); assert.ok(await page.evaluate(() => saved.range)); await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => saved.range), null);
    // 긴 기록에서 이동·양 끝 조절·경계 제한·재열기를 확인한다.
    const long = fixture(); long.firstObserved = now - 30 * 86400000;
    for (const p of Object.values(long.data)) for (const points of Object.values(p.windows)) points.unshift({...points[0], time: long.firstObserved, continuous: false});
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), long); await page.waitForTimeout(30);
    await checkDefault(); assert.equal((await range())[2], long.firstObserved); assert.equal((await range())[3], now + week);
    await page.evaluate(() => document.getElementById('ua-chart').addEventListener('wheel', e => {window.lastWheel = {count: (window.lastWheel?.count || 0) + 1, prevented: e.defaultPrevented};}));
    const wheel = async (key, deltaX, deltaY, ratio = .25) => {
      const box = await page.locator('[data-chart-hit]').boundingBox();
      await page.mouse.move(box.x + box.width * ratio, box.y + box.height / 2);
      const before = await page.evaluate(() => window.lastWheel?.count || 0);
      if (key) await page.keyboard.down(key);
      try {await page.mouse.wheel(deltaX, deltaY);} finally {if (key) await page.keyboard.up(key);}
      await page.waitForFunction(count => window.lastWheel?.count > count, before);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await checkThumb();
    };
    const original = await range(), anchor = original[0] + (original[1] - original[0]) * .25;
    const viewportWidth = await page.evaluate(() => innerWidth);
    await wheel('Control', 0, -120); const zoomed = await range();
    assert.ok(zoomed[1] - zoomed[0] < original[1] - original[0], 'Ctrl wheel zooms in');
    assert.ok(Math.abs(zoomed[0] + (zoomed[1] - zoomed[0]) * .25 - anchor) < 1, 'mouse date remains anchored');
    assert.equal(await page.evaluate(() => window.lastWheel.prevented), true); assert.equal(await page.evaluate(() => innerWidth), viewportWidth, 'page itself is not zoomed');
    await wheel('Shift', 0, 120); const panned = await range();
    assert.ok(panned[0] > zoomed[0], 'Shift wheel moves toward later dates'); assert.ok(Math.abs((panned[1] - panned[0]) - (zoomed[1] - zoomed[0])) < 1);
    await wheel('Shift', 0, -120); const back = await range(); assert.ok(Math.abs(back[0] - zoomed[0]) < 1);
    await wheel('Control', 0, 120); const zoomedOut = await range(); assert.ok(Math.abs(zoomedOut[0] - original[0]) < 1); assert.ok(Math.abs(zoomedOut[1] - original[1]) < 1);
    await wheel(null, 0, 120); assert.deepEqual(await range(), zoomedOut); assert.equal(await page.evaluate(() => window.lastWheel.prevented), false, 'ordinary wheel keeps page scrolling');
    const burst = async (options, count = 20) => {
      await page.locator('[data-chart-hit]').evaluate((n, {options, count}) => {const r = n.getBoundingClientRect(); for (let i = 0; i < count; i++) n.dispatchEvent(new WheelEvent('wheel', {bubbles: true, cancelable: true, clientX: r.x + r.width * .75, clientY: r.y + 50, ...options}));}, {options, count});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await checkThumb();
    };
    await burst({ctrlKey: true, deltaY: -1000}); assert.equal((await range())[1] - (await range())[0], 60000);
    await burst({shiftKey: true, deltaX: 1000000}, 1); assert.ok((await range())[0] > zoomedOut[0]);
    await burst({ctrlKey: true, deltaY: 1000}); const maximum = await range(); assert.equal(maximum[0], long.firstObserved); assert.equal(maximum[1], now + week);
    await burst({shiftKey: true, deltaY: -1000, deltaMode: 1}); assert.deepEqual(await range(), maximum);
    await page.locator('#ua-navigator').dblclick(); await page.waitForTimeout(30);
    await burst({shiftKey: true, deltaY: -1000, deltaMode: 2}); assert.equal((await range())[0], long.firstObserved);
    await burst({shiftKey: true, deltaY: 1000, deltaMode: 2}); assert.equal((await range())[1], now + week);
    await page.setViewportSize({width: 360, height: 900}); await page.waitForTimeout(40);
    await wheel('Control', 0, -120, .75); await wheel('Shift', 120, 0, .75);
    await page.setViewportSize({width: 1440, height: 900}); await page.waitForTimeout(40);
    await page.locator('#ua-navigator').dblclick(); await page.waitForTimeout(30); await checkDefault();
    report.wheel = 'PASS: native Ctrl/Shift wheel, mouse anchor, plain wheel, zoom limits, pan bounds, delta units, horizontal input, burst, narrow view, navigator synchronization';
    const painted = () => page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.evaluate(()=>document.getElementById('ua-chart').addEventListener('pointerdown',e=>{if(e.button===1){window.middlePointer=e.pointerId;window.middlePrevented=e.defaultPrevented;}}));
    const middleStart = async () => {
      const box = await page.locator('[data-chart-hit]').boundingBox(), point={x:box.x+box.width/2,y:box.y+box.height/2,width:box.width};
      await page.mouse.move(point.x,point.y);await page.mouse.down({button:'middle'});return point;
    };
    const panBefore=await range(), panSaves=await page.evaluate(()=>window.saves), panPoint=await middleStart();
    assert.equal(await page.evaluate(()=>window.middlePrevented),true,'middle button suppresses browser auto-scroll');
    await page.mouse.move(panPoint.x+40,panPoint.y);await painted();await checkThumb();
    const panHalf=await range();assert.ok(panHalf[0]<panBefore[0]);
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:window.uiModel})));await painted();
    await page.mouse.move(panPoint.x+80,panPoint.y);await painted();
    assert.equal(await page.locator('#ua-chart').getAttribute('data-pan'),'true','drag capture survives redraw and data updates');
    assert.equal(await page.locator('#ua-tooltip').isVisible(),false);
    assert.equal(await page.evaluate(()=>window.saves),panSaves,'pointer moves do not persist state each frame');
    const panFull=await range(), panShift=80/panPoint.width*(panBefore[1]-panBefore[0]);
    assert.ok(Math.abs(panFull[0]-(panBefore[0]-panShift))<2);assert.ok(Math.abs((panFull[1]-panFull[0])-(panBefore[1]-panBefore[0]))<2);
    await page.mouse.move(panPoint.x+80,-20);await painted();assert.equal(await page.locator('#ua-chart').getAttribute('data-pan'),'true','capture continues outside the chart');
    await page.mouse.move(panPoint.x+80,panPoint.y);await page.mouse.up({button:'middle'});await painted();await checkThumb();
    assert.equal(await page.locator('#ua-chart').getAttribute('data-pan'),null);assert.equal(await page.evaluate(()=>window.saves),panSaves+1);
    assert.deepEqual(await range(),panFull);
    const verticalPoint=await middleStart();await page.mouse.move(verticalPoint.x,verticalPoint.y+45);await page.mouse.up({button:'middle'});await painted();assert.deepEqual(await range(),panFull,'vertical middle drag does not zoom or change time');
    const cancelledPoint=await middleStart();await page.mouse.move(cancelledPoint.x+50,cancelledPoint.y);await painted();
    await page.locator('#ua-chart').evaluate(n=>n.dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.middlePointer,bubbles:true})));await page.mouse.up({button:'middle'});await painted();assert.deepEqual(await range(),panFull,'cancelled pan restores its initial range');
    const lostPoint=await middleStart();await page.mouse.move(lostPoint.x+50,lostPoint.y);await painted();const lostRange=await range();
    await page.locator('#ua-chart').evaluate(n=>n.releasePointerCapture(window.middlePointer));await painted();await page.mouse.up({button:'middle'});await painted();assert.deepEqual(await range(),lostRange);assert.equal(await page.locator('#ua-chart').getAttribute('data-pan'),null);
    for(const offset of [100000,-100000]){const edge=await middleStart();await page.mouse.move(edge.x+offset,edge.y);await page.mouse.up({button:'middle'});await painted();const r=await range();assert.equal(offset>0?r[0]:r[1],offset>0?long.firstObserved:now+week);await checkThumb();}
    await page.locator('#ua-navigator').dblclick();await painted();
    await page.setViewportSize({width:360,height:900});await painted();const narrowBefore=await range(), narrowPan=await middleStart();await page.mouse.move(narrowPan.x+25,narrowPan.y);await page.mouse.up({button:'middle'});await painted();await checkThumb();assert.ok(Math.abs((await range())[0]-(narrowBefore[0]-25/narrowPan.width*(narrowBefore[1]-narrowBefore[0])))<2);
    await page.setViewportSize({width:1440,height:900});await painted();await page.locator('#ua-navigator').dblclick();await painted();await checkDefault();
    report.middleDrag='PASS: native middle-button pan, exact direction/distance, fixed span, redraw/data update/outside capture, single persistence, cancel/lost-capture cleanup, bounds, vertical isolation, narrow view and navigator synchronization';
    await page.evaluate(()=>{
      const chart=document.getElementById('ua-chart');
      chart.addEventListener('pointerdown',e=>{if(e.button===2){window.rightPointer=e.pointerId;window.rightPrevented=e.defaultPrevented;}});
      chart.addEventListener('contextmenu',e=>{window.rightContextPrevented=e.defaultPrevented;});
    });
    const pinchStart = async (fraction=.2) => {
      const b=await page.locator('[data-chart-hit]').boundingBox(), center={x:b.x+b.width/2,y:b.y+b.height/2}, radius=b.width*fraction;
      await page.mouse.move(center.x+radius,center.y);await page.mouse.down({button:'right'});return{center,radius};
    };
    const pinchBefore=await range(), pinchSaves=await page.evaluate(()=>window.saves), pinch=await pinchStart();
    assert.deepEqual(await range(),pinchBefore,'right down does not jump to a new zoom level');
    assert.equal(await page.evaluate(()=>window.rightPrevented),true);
    await page.mouse.move(pinch.center.x+pinch.radius*1.6,pinch.center.y);await painted();await checkThumb();
    const pinchedIn=await range();assert.ok(pinchedIn[1]-pinchedIn[0]<pinchBefore[1]-pinchBefore[0]);
    assert.ok(Math.abs((pinchedIn[0]+pinchedIn[1])/2-(pinchBefore[0]+pinchBefore[1])/2)<2,'zoom remains anchored to chart center');
    assert.equal(await page.locator('#ua-chart').getAttribute('data-zoom'),'in');assert.equal(await page.locator('#ua-tooltip').isVisible(),false);
    await burst({ctrlKey:true,deltaY:-100},1);assert.deepEqual(await range(),pinchedIn,'wheel zoom does not compete with an active pointer gesture');
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:window.uiModel})));await painted();
    await page.mouse.move(pinch.center.x-pinch.radius*1.6,pinch.center.y);await painted();const sameRadius=await range();
    const pointerTolerance=(pinchedIn[1]-pinchedIn[0])*1e-6;
    assert.ok(Math.abs(sameRadius[0]-pinchedIn[0])<pointerTolerance&&Math.abs(sameRadius[1]-pinchedIn[1])<pointerTolerance,'equal radius preserves zoom within native pointer coordinate precision');
    await page.mouse.move(pinch.center.x+pinch.radius*.5,pinch.center.y);await painted();assert.ok((await range())[1]-(await range())[0]>pinchBefore[1]-pinchBefore[0]);assert.equal(await page.locator('#ua-chart').getAttribute('data-zoom'),'out');
    await page.mouse.move(pinch.center.x,pinch.center.y);await painted();const pinchedOut=await range();assert.ok(Math.abs(pinchedOut[0]-long.firstObserved)<2&&Math.abs(pinchedOut[1]-(now+week))<2,'moving to center reaches the available full period');
    await page.mouse.move(pinch.center.x+pinch.radius,pinch.center.y);await painted();const pinchReturned=await range();assert.ok(Math.abs(pinchReturned[0]-pinchBefore[0])<2&&Math.abs(pinchReturned[1]-pinchBefore[1])<2,'return to start radius restores initial zoom without drift');
    await page.mouse.move(pinch.center.x+100000,pinch.center.y);await painted();assert.equal((await range())[1]-(await range())[0],60000);
    assert.equal(await page.evaluate(()=>window.saves),pinchSaves,'pinching does not persist state per pointer event');
    await page.mouse.up({button:'right'});await page.keyboard.press('Escape');await painted();assert.equal(await page.locator('#ua-chart').getAttribute('data-zoom'),null);assert.equal(await page.evaluate(()=>window.saves),pinchSaves+1);await checkThumb();
    assert.equal(await page.locator('#ua-chart').evaluate(n=>n.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}))),false);
    assert.equal(await page.evaluate(()=>window.rightContextPrevented),true,'chart right-click menu is suppressed');
    await page.locator('#ua-navigator').dblclick();await painted();
    const centerBefore=await range(), centerPinch=await pinchStart(0);assert.deepEqual(await range(),centerBefore);
    await page.mouse.move(centerPinch.center.x,centerPinch.center.y+60);await painted();assert.ok((await range())[1]-(await range())[0]<centerBefore[1]-centerBefore[0],'starting at center can zoom outward vertically without singularities');
    await page.locator('#ua-chart').evaluate(n=>n.dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.rightPointer,bubbles:true})));await page.mouse.up({button:'right'});await painted();assert.deepEqual(await range(),centerBefore);
    const lostPinch=await pinchStart();await page.mouse.move(lostPinch.center.x+lostPinch.radius*1.2,lostPinch.center.y);await painted();const lostZoom=await range();
    await page.locator('#ua-chart').evaluate(n=>n.releasePointerCapture(window.rightPointer));await painted();await page.mouse.up({button:'right'});await painted();assert.deepEqual(await range(),lostZoom);assert.equal(await page.locator('#ua-chart').getAttribute('data-zoom'),null);
    await page.locator('#ua-navigator').dblclick();await painted();await page.setViewportSize({width:360,height:900});await painted();
    const narrowZoomBefore=await range(), narrowPinch=await pinchStart();await page.mouse.move(narrowPinch.center.x+narrowPinch.radius*1.4,narrowPinch.center.y);await page.mouse.up({button:'right'});await painted();await checkThumb();const narrowZoom=await range();assert.ok(narrowZoom[1]-narrowZoom[0]<narrowZoomBefore[1]-narrowZoomBefore[0]);assert.ok(Math.abs((narrowZoom[0]+narrowZoom[1])/2-(narrowZoomBefore[0]+narrowZoomBefore[1])/2)<2);
    await page.setViewportSize({width:1440,height:900});await painted();await page.locator('#ua-navigator').dblclick();await painted();await checkDefault();
    report.rightPinch='PASS: native right drag radial pinch, no initial jump, center anchor, outward/inward/opposite/vertical movement, full and minimum extents, no drift, redraw/data update capture, single persistence, cancel/lost capture, context menu suppression and narrow viewport';
    const drag = async (selector, offset) => {
      const box = await page.locator(selector).boundingBox(); const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + offset, y, {steps: 6}); await page.mouse.up(); await page.waitForTimeout(40); await checkThumb();
    };
    const initial = await range();
    await drag('#ua-nav-pan', -180); const moved = await range();
    assert.ok(moved[0] < initial[0]); assert.ok(Math.abs((moved[1] - moved[0]) - 2 * week) < 1);
    await drag('#ua-nav-start', 50); const resizedStart = await range(); assert.ok(resizedStart[0] > moved[0]); assert.equal(resizedStart[1], moved[1]);
    await drag('#ua-nav-end', -50); const resizedEnd = await range(); assert.equal(resizedEnd[0], resizedStart[0]); assert.ok(resizedEnd[1] < resizedStart[1]);
    await page.locator('#ua-nav-pan').focus(); await page.keyboard.press('PageUp'); await page.waitForTimeout(30); assert.ok((await range())[0] >= long.firstObserved);
    await drag('#ua-nav-start', -3000); assert.equal((await range())[0], long.firstObserved);
    await drag('#ua-nav-end', 3000); assert.equal((await range())[1], now + week);
    await page.locator('#ua-nav-start').focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(30); assert.ok((await range())[0] > long.firstObserved); await checkThumb();
    await page.locator('#ua-nav-end').focus(); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(30); assert.ok((await range())[1] < now + week); await checkThumb();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'resetView'}}))); await page.waitForTimeout(30); await checkDefault();
    await page.locator('#ua-nav-pan').focus(); await page.keyboard.press('+'); await page.waitForTimeout(30); await checkThumb();
    for (let i = 0; i < 15; i++) {await page.keyboard.press('+'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
    assert.equal((await range())[1] - (await range())[0], 60000); assert.equal(await page.locator('#ua-nav-thumb').getAttribute('data-compact'), 'true');
    await page.setViewportSize({width: 360, height: 900}); await page.waitForTimeout(40);
    await drag('#ua-nav-pan', -10); await drag('#ua-nav-start', -8); await drag('#ua-nav-end', 8);
    await page.setViewportSize({width: 1440, height: 900}); await page.waitForTimeout(40);
    await page.locator('#ua-navigator').dblclick(); await page.waitForTimeout(30); await checkDefault();
    report.navigator = 'PASS: default ±7d, chart synchronization, pan, both handles, bounds, keyboard, reopen, double-click';
    await page.locator('#ua-claude').click(); await page.waitForTimeout(30); assert.equal(await page.locator('[data-series^="codex"]').count(), 0); await page.locator('#ua-claude').click();
    await setPreference('colorMode','dark'); await page.waitForTimeout(30); assert.equal(await page.locator('#usage-atlas').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(26, 29, 35)');
    fs.mkdirSync(path.join(dir, 'screenshots'), {recursive: true});
    await page.screenshot({path: path.join(dir, 'screenshots', 'wide-dark.png')});
    await page.locator('#ua-credit').check(); await page.locator('#ua-credit-mode').selectOption('money'); await page.locator('#ua-basis').selectOption('base'); await page.waitForTimeout(40); await page.screenshot({path: path.join(dir, 'screenshots', 'credits-wide.png')});
    await setPreference('colorMode','light'); await page.setViewportSize({width: 360, height: 900}); await page.waitForTimeout(40); await page.screenshot({path: path.join(dir, 'screenshots', 'credits-narrow.png')}); await page.locator('#ua-credit').uncheck(); await page.locator('#ua-basis').selectOption('current');
    await setPreference('colorMode','light'); await page.setViewportSize({width: 360, height: 900}); await page.waitForTimeout(50); await page.screenshot({path: path.join(dir, 'screenshots', 'narrow.png')});
    for (const size of [{width: 3440, height: 1440}, {width: 1920, height: 1080}, {width: 1440, height: 900}, {width: 360, height: 900}, {width: 320, height: 400}]) {
      await page.setViewportSize(size); await page.waitForTimeout(50);
      const r = await page.locator('#usage-atlas').boundingBox();
      assert.ok(r.width <= 1440, 'content width is bounded');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor === getComputedStyle(document.getElementById('usage-atlas')).backgroundColor), true, 'full viewport background matches theme');
      assert.ok(Math.abs(r.x + r.width / 2 - size.width / 2) < 1, 'horizontal center');
      if (r.height + 16 <= size.height) assert.ok(Math.abs(r.y + r.height / 2 - size.height / 2) < 1, 'vertical center');
      else assert.ok(r.y >= 0, 'short screen remains scrollable from top');
    }
    // 실제 계정과 같은 결측 창 및 첫 관측 한 건, 빈 기록도 정상 렌더링해야 한다.
    const missing = fixture(); missing.data.codex.windows.five = []; missing.data.codex.last.windows.five = null; missing.data.codex.status.message = '인증 만료';
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), missing); await page.waitForTimeout(30); assert.equal(await page.locator('[data-legend-cell="codex-five"]').textContent(), '-');
    assert.match(await page.locator('#ua-codex-status').textContent(), /인증 만료/); assert.match(await page.locator('#ua-codex').getAttribute('aria-label'), /인증 만료/);
    await page.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), {type: 'data', now, data: {}}); await page.waitForTimeout(30); assert.match(await page.locator('#ua-chart').textContent(), /수집 대기/);
    await checkDefault();
    const reopened = await browser.newPage({viewport: {width: 1024, height: 900}});
    await reopened.setContent(doc.replace('getState:()=>null', `getState:()=>({version:4,range:[${now - 86400000},${now}]})`));
    await reopened.evaluate(data => (window.uiModel=data,window.dispatchEvent(new MessageEvent('message', {data}))), fixture()); await reopened.waitForTimeout(60);
    assert.equal(await reopened.locator('#ua-chart').getAttribute('data-domain-start'), String(now - 86400000)); assert.equal(await reopened.locator('#ua-chart').getAttribute('data-domain-end'), String(now)); await reopened.close();
    assert.deepEqual(report.errors, []); report.status = 'PASS';
  } catch (e) {report.status = 'FAIL'; report.failure = e.message; throw e;}
  finally {await browser.close(); fs.writeFileSync(path.join(dir, 'test-ui.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));}
})().catch(e => {console.error(e); process.exitCode = 1;});
