'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project, hash} = require('../src/core.cjs');
const dir = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(dir, 'media', file), 'utf8');
const now = Date.now();
const records = ['codex', 'claude'].flatMap(provider => Array.from({length: 97}, (_, i) => ({
    v: 1, provider, account: hash(provider), plan: 'test', time: now - (96 - i) * 900000
  , windows: {five: {used: (provider === 'codex' ? 20 : 45) + i / 4, reset: now + 3600000}, week: {used: (provider === 'codex' ? 10 : 60) + i / 10, reset: now + 86400000}}
}))).sort((a, b) => a.time - b.time);
const model = {type: 'data', now, data: project(records), diagnosticsEnabled: true, detailsEnabled: true};
const bounded = rows => ({items: rows, totalCount: rows.length, knownCount: rows.length, limit: 50, truncated: false});
const start = now - 86400000, end = now - 900000;
const report = {
    summary: {provider: 'codex', window: 'five', start, end, sourceCallCount: 3, eligibleCallCount: 3, callCount: 3, pricedCallCount: 2, costUsd: null, knownCostUsd: 1.25, input: 1500, cached: 500, output: 200, cacheRatio: 1 / 3, sessionCount: 2, requestCount: 3}
  , coverage: {source: {files: 2, partial: true, notes: ['account-assumed-at-first-file-observation', 'account-switch-existing-file-bindings-preserved', 'unknown-account-binding-preserved', 'legacy-cumulative-deltas-completion-unknown', 'modern-records-supersede-session-token-count', 'RAW_SOURCE_CODE_SENTINEL']}, sourceCallCount: 3, eligibleCallCount: 3, pricedCallCount: 2, matchedCallCount: 2, unmatchedCallCount: 1, missingFields: [{field: 'model', callCount: 1}], notes: ['다른 기기의 작업은 포함하지 않습니다.'], observedTimes: [start, start + 900000, end]}
  , sessions: bounded([{id: 's1', sessionId: 's1', project: 'project-a', callCount: 2, knownCostUsd: 1, costUsd: 1, ownCostUsd: .8, descendantCostUsd: .2, models: ['model-a'], efforts: ['high'], modes: ['Standard']}, {id: 's2', sessionId: 's2', parentSessionId: 's1', project: 'project-b', callCount: 1, knownCostUsd: .25, costUsd: null, ownCostUsd: .25, descendantCostUsd: 0, models: ['model-b'], efforts: ['low'], modes: ['Fast']}])
  , requests: bounded([{id: 'r1', turnId: 'r1', sessionId: 's1', project: 'project-a', callCount: 2, costUsd: 1, knownCostUsd: 1}])
  , calls: bounded([{id: 'c1', sessionId: 's1', turnId: 'r1', time: start, model: 'model-a', effort: 'high', mode: 'Standard', project: 'project-a', input: 1000, cached: 500, output: 100, costUsd: 1, matchState: 'matched', inputBand: '0-10k', cacheBand: '50-90%', message: 'PRIVATE_SENTINEL'}, {id: 'c2', sessionId: 's2', time: end, model: 'model-b', effort: 'unknown', mode: 'unknown', costUsd: null}])
  , agents: bounded([{id: 's1', sessionId: 's1', callCount: 2, ownCostUsd: .8, descendantCostUsd: .2}])
  , comparisons: bounded([{model: 'model-a', effort: 'high', mode: 'Standard', sampleCount: 2, pricedSampleCount: 2, latencySampleCount: 0, latencyUnknownSampleCount: 2, latencyLabel: 'API 호출 지연 미확인', latencyNotes: ['로컬 이벤트의 시작·완료 시각은 호출별 타임스탬프 출처를 확인하지 못해 API 호출 지연으로 계산하지 않습니다.'], cacheSampleCount: 2, cost: {mean: .5, median: .5, p90: 1}, latencyMs: {mean: null, median: null, p90: null}, smallSample: true}])
  , cache: {input: 1500, cached: 500, ratio: 1 / 3, validSampleCount: 2, notes: [], suspicions: [{sessionId: 's1', model: 'model-a', start, end, beforeRatio: .8, afterRatio: .2, sampleCount: 6}]}
  , cycles: bounded([{id: 'cycle-1', provider: 'codex', account: hash('codex'), window: 'five', start, end, observedStart: start, observedEnd: end, observedTimes: [start, start + 900000, end], partial: true, quotaDelta: 10, callCount: 3, knownCostUsd: 1.25}])
  , estimate: {valueUsdPer100Pct: 12.5, quotaDelta: 10, knownCostUsd: 1.25, matchedCallCount: 2, unmatchedCallCount: 1, notes: ['통계적 신뢰구간이 아닌 관측 환산입니다.'], sensitivity: [{assumption: '관측 증가분 1.2배', valueUsdPer100Pct: 10.4}], assumedCallCount: 1}
  , exclusions: {...bounded([{id: 'ex-1', exclusionId: 'ex-1', start, end, reason: '시험 범위', active: true}]), effects: {before: {callCount: 3, pricedCallCount: 2, knownCostUsd: 1.25}, after: {callCount: 2, pricedCallCount: 1, knownCostUsd: 1}, removedCallCount: 1, removedKnownCostUsd: .25}}
  , diagnostics: {enabled: true, summary: {samples: 3, lastMs: 8, meanMs: 9, p95Ms: 10, cpuMs: 4, rssMiB: 50, heapMiB: 10}, note: 'Usage Atlas 확장 호스트 프로세스 측정입니다.', events: [{time: now, stage: 'query', elapsedMs: 8, cpuMs: 4, rssMiB: 50, outcome: 'success'}]}
  , provenance: {catalogVersion: 'test-1', priceVerifiedAt: '2026-10-22', sources: [{title: '공식 가격표', url: 'https://example.test/pricing'}], notes: ['API 환산 추정액입니다.']}
};
const doc = initialState => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${read('style.css')}</style></head><body>${read('body.html')}<script>window.messages=[];window.savedState=${JSON.stringify(initialState ?? null).replace(/</g, '\\u003c')};window.acquireVsCodeApi=()=>({getState:()=>window.savedState,setState:value=>{window.savedState=value;},postMessage:value=>window.messages.push(value)});</script>${['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'details.js', 'provider-visibility.js', 'app.js'].map(file => `<script>${read(file)}</script>`).join('')}</body></html>`;
(async () => {
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}, timezoneId: 'Asia/Seoul', colorScheme: 'dark'});
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent(doc());
    const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), data);
    await send(model); await frame();
    const p = await page.locator('path[data-series="codex-five"]').first().evaluate(line => {
      const q = line.getPointAtLength(line.getTotalLength() * .63), m = line.getScreenCTM();
      return {x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f};
    });
    const state = () => page.evaluate(() => {
      const a = document.activeElement, cs = a && getComputedStyle(a);
      const frameEl = document.querySelector('#ua-chart .ua-focus');
      return {active: a && (a.tagName + ' ' + (a.dataset.detailsLine || (a.hasAttribute('data-chart-hit') ? 'hit' : ''))), fv: a && a.matches(':focus-visible'), outline: cs && cs.outlineStyle + ' ' + cs.outlineWidth, blueFrame: !!frameEl};
    });
    await page.mouse.click(p.x, p.y); await frame();
    const last = (await page.evaluate(() => window.messages.filter(v => v.type !== 'ready').at(-1)));
    await send({type: 'details', requestId: last.requestId, data: report}); await frame();
    await page.locator('#ua-details-close').click(); await frame();
    {const s = await state(); assert.equal(s.fv, false); assert.equal(s.outline.startsWith('none'), true, 'mouse close leaves no focus ring on the line: ' + s.outline);}
    // keyboard path
    await page.locator('[data-details-line="codex-five"]').focus(); await page.keyboard.press('Enter'); await frame();
    const l2 = (await page.evaluate(() => window.messages.filter(v => v.type !== 'ready').at(-1)));
    await send({type: 'details', requestId: l2.requestId, data: report}); await frame();
    await page.keyboard.press('Escape'); await frame();
    {const s = await state(); assert.equal(s.outline.startsWith('none'), true, 'keyboard close leaves no UA focus ring: ' + s.outline);}
    // empty-space click
    const hb = await page.locator('[data-chart-hit]').boundingBox(); await page.mouse.click(hb.x + hb.width * .9, hb.y + hb.height * .5); await frame();
    {const s = await state(); assert.equal(s.blueFrame, false, 'mouse click on empty chart does not draw the keyboard focus frame');}
    assert.deepEqual(errors, []); console.log('focus-box-ui passed');
  } finally { await browser.close(); }
})();
