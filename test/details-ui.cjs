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
const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${read('style.css')}</style></head><body>${read('body.html')}<script>window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:value=>window.messages.push(value)});</script>${['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'details.js', 'provider-focus.js', 'app.js'].map(file => `<script>${read(file)}</script>`).join('')}</body></html>`;
(async () => {
  const browser = await chromium.launch(browserOptions);
  const errors = [], passed = [];
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}, timezoneId: 'Asia/Seoul'});
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(doc);
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), data);
    const update = async extra => {await send({...model, ...extra}); await frame();};
    const messages = () => page.evaluate(() => window.messages.filter(value => value.type !== 'ready'));
    const last = async () => (await messages()).at(-1);
    const reply = async (value = report, requestId) => {await send({type: 'details', requestId: requestId || (await last()).requestId, data: value});};
    const point = () => page.locator('path[data-series="codex-five"]').first().evaluate(line => {
      const p = line.getPointAtLength(line.getTotalLength() * .63), m = line.getScreenCTM();
      return {x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f};
    });
    const dialog = page.locator('#ua-details'), close = page.locator('#ua-details-close');
    const open = async key => {await page.locator('[data-details-line="codex-five"]').focus(); await page.keyboard.press(key || 'Enter'); assert.equal(await dialog.isVisible(), true);};
    await update({});
    const baseline = await page.locator('#ua-chart').boundingBox(), toolbar = await page.locator('.ua-toolbar').boundingBox();
    const p = await point();
    await page.mouse.move(p.x, p.y); await frame();
    assert.match(await page.locator('#ua-tooltip').textContent(), /Codex \/ 5시간/);
    await page.mouse.click(p.x, p.y);
    assert.equal(await dialog.isVisible(), true, 'real line click opens through hit layer');
    assert.equal((await last()).type, 'details'); assert.equal((await last()).provider, 'codex'); assert.equal((await last()).window, 'five'); assert.deepEqual((await last()).filters, {});
    assert.deepEqual(await page.locator('#ua-chart').boundingBox(), baseline); assert.deepEqual(await page.locator('.ua-toolbar').boundingBox(), toolbar);
    await reply();
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await dialog.getAttribute('aria-labelledby'), 'ua-details-title');
    assert.equal(await page.getByText('PRIVATE_SENTINEL').count(), 0);
    assert.equal(await page.getByText('미제공', {exact: true}).count(), 0);
    assert.match(await page.locator('#ua-details-provenance').textContent(), /example\.test.*test-1.*2026/);
    assert.equal(await page.locator('#ua-details-provenance a').getAttribute('title'), '공식 가격표');
    assert.equal(await page.locator('#ua-details-price-date').textContent(), '기준 2026-10-22', 'date-only provenance cannot acquire an invented KST hour');
    await page.locator('#ua-details-filter-reset').click();
    await reply({...report, provenance: {...report.provenance, priceVerifiedAt: '2026-10-22T03:04:05Z'}});
    assert.match(await page.locator('#ua-details-provenance').textContent(), /(?:12:04:05|12시\s*4분\s*5초)$/, 'timestamp provenance retains the actual time in KST');
    await page.locator('#ua-details-filter-reset').click();
    await reply({...report, provenance: {...report.provenance, priceVerifiedAt: '2026-02-31'}});
    assert.equal(await page.locator('#ua-details-price-date').textContent(), '기준 -', 'invalid calendar dates cannot silently roll into a different date');
    await page.locator('#ua-details-filter-reset').click(); await reply();
    await page.locator('#ua-details-filter-reset').click();
    await reply({...report, estimate: {...report.estimate, valueUsdPer100Pct: null, assumedCallCount: 1, sensitivity: [{id: 'include-provisional', assumption: '시작 시각 미확인 호출도 포함', valueUsdPer100Pct: 123.456}, {assumption: '관측 사용률 증가분 1.2배', valueUsdPer100Pct: 98.7, sampleCount: 2}]}});
    await page.locator('#ua-tab-performance').click();
    const standard = page.locator('#ua-panel-performance'), sensitivityRows = standard.locator('table[aria-label="조건별 민감도"] tbody tr');
    assert.equal(await standard.locator('dt').filter({hasText: /^사용률 100%당 환산액 \(USD\)$/}).evaluate(value => value.nextElementSibling.textContent), '-');
    assert.equal(await sensitivityRows.first().locator('td').nth(1).textContent(), '123.456');
    assert.equal(await sensitivityRows.first().locator('td').nth(2).textContent(), '-');
    assert.equal(await sensitivityRows.last().locator('td').nth(2).textContent(), '2');
    assert.equal(await standard.getByText('123.456', {exact: true}).isVisible(), true);
    assert.match(await standard.textContent(), /통계적 신뢰구간이 아닌/);
    assert.equal(await page.locator('table[aria-label="조건별 민감도"]').count(), 1, 'approved Standard assumption uses one shared estimate');
    assert.equal(await page.locator('#ua-standard-scenario').count(), 0, 'duplicate mode scenario removed');
    assert.match(await page.locator('#ua-panel-performance').textContent(), /API 호출 지연 미확인/);
    assert.match(await page.locator('#ua-panel-performance').textContent(), /호출별 타임스탬프 출처를 확인하지 못해/);
    await page.locator('#ua-tab-report').click(); await page.locator('#ua-details-filter-reset').click(); await reply();
    const coverageText = await page.locator('#ua-panel-coverage').textContent();
    for (const message of ['이 로컬 경로의 계정은 첫 색인 시 로그인 계정으로 가정합니다.', '기존 파일의 계정 연결은 전환 후에도 보존합니다.', '계정을 확인하지 못한 파일은 미확인으로 유지합니다.', '일부 기록만 색인된 상태입니다.']) assert.ok(coverageText.includes(message));
    assert.doesNotMatch(coverageText, /account-assumed|account-switch|unknown-account|RAW_SOURCE_CODE_SENTINEL/);
    assert.equal(await page.locator('#ua-panel-coverage dt').filter({hasText: /^부분 수집$/}).evaluate(value => value.nextElementSibling.textContent), '예');
    assert.equal(await page.locator('select[name="mode"] option[value="Standard"]').textContent(), '표준');
    assert.equal(await page.locator('select[name="mode"] option[value="unknown"]').textContent(), '-');
    assert.equal(await page.locator('select[name="effort"] option[value="high"]').textContent(), '높음');
    const callRows = page.locator('#ua-panel-report table[aria-label="호출"] tbody tr');
    const callCell = (row, label) => row.locator('td').nth(['모델', '대화', '세션', '요청', '시각', '추론 수준', '모드'].indexOf(label));
    assert.equal(await callCell(callRows.last(), '모드').textContent(), '표준');
    assert.equal(await callCell(callRows.first(), '추론 수준').textContent(), '-'); assert.equal(await callCell(callRows.first(), '모드').textContent(), '-');
    assert.doesNotMatch(await page.locator('.ua-toolbar').textContent(), /부분 수집|첫 색인|진단/);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.detailsLine), 'codex-five');
    passed.push('line click, compact hover, no displacement, privacy, dialog semantics, Escape and restored focus');
    const before = (await messages()).length;
    const hit = await page.locator('[data-chart-hit]').boundingBox();
    await page.mouse.click(hit.x + hit.width * .2, hit.y + 12);
    assert.equal((await messages()).length, before, 'empty plot click cannot open modal');
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 7, p.y); await page.mouse.move(p.x, p.y); await page.mouse.up();
    assert.equal((await messages()).length, before, '7px motion and returning to line is still a drag');
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 40, p.y, {steps: 5}); await page.mouse.up(); await frame();
    assert.equal((await messages()).length, before, 'range drag never opens details');
    await send({type: 'resetView'}); await frame();
    await page.mouse.move(p.x, p.y); await page.mouse.down({button: 'middle'}); await page.mouse.move(p.x + 20, p.y, {steps: 3}); await page.mouse.up({button: 'middle'}); await frame();
    assert.equal((await messages()).length, before, 'middle pan never opens details');
    await send({type: 'resetView'}); await frame();
    await page.mouse.move(p.x, p.y); await page.mouse.down({button: 'right'}); await page.mouse.move(p.x + 30, p.y + 15, {steps: 3}); await page.mouse.up({button: 'right'}); await frame();
    assert.equal((await messages()).length, before, 'right pinch never opens details');
    await send({type: 'resetView'}); await frame();
    const domain = () => page.locator('#ua-chart').evaluate(chart => [Number(chart.dataset.domainStart), Number(chart.dataset.domainEnd)]);
    const original = await domain();
    await page.mouse.move(p.x, p.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control'); await frame();
    const zoomed = await domain(); assert.ok(zoomed[1] - zoomed[0] < original[1] - original[0]);
    await page.keyboard.down('Shift'); await page.mouse.wheel(0, 120); await page.keyboard.up('Shift'); await frame(); assert.notDeepEqual(await domain(), zoomed);
    await send({type: 'resetView'}); await frame();
    const nav = await page.locator('#ua-nav-pan').boundingBox();
    await page.mouse.move(nav.x + nav.width / 2, nav.y + nav.height / 2); await page.mouse.down(); await page.mouse.move(nav.x + nav.width / 2 + 15, nav.y + nav.height / 2); await page.mouse.up(); await frame();
    assert.equal((await messages()).length, before);
    await send({type: 'resetView'}); await frame(); passed.push('empty click, drag excursion, range zoom, middle pan, right pinch, Ctrl/Shift wheel and navigator drag');
    await open('Space'); const staleRequest = (await last()).requestId;
    await close.click(); await open(); const freshRequest = (await last()).requestId;
    await reply({...report, summary: {...report.summary, callCount: 999}}, staleRequest);
    assert.match(await page.locator('#ua-details-status').textContent(), /불러오고/);
    await send({type: 'detailsError', requestId: staleRequest, error: 'STALE_ERROR'});
    assert.match(await page.locator('#ua-details-status').textContent(), /불러오고/);
    await reply(report, freshRequest);
    await page.locator('select[name="mode"]').selectOption('unknown'); assert.deepEqual((await last()).filters, {mode: 'unknown'}); await reply();
    await page.locator('#ua-details-filter-reset').click(); await reply();
    await page.locator('select[name="model"]').selectOption('model-a');
    const filterRequest = await last(); assert.deepEqual(filterRequest.filters, {model: 'model-a'});
    await reply();
    await page.locator('select[name="session"]').selectOption('s1'); assert.deepEqual((await last()).filters, {sessionId: 's1', model: 'model-a'}); await reply();
    for (const [key, value] of [['project', 'project-a'], ['effort', 'high'], ['mode', 'Standard'], ['inputBand', '0-10k'], ['cacheBand', '50-90%']]) {await page.locator(`select[name="${key}"]`).selectOption(value); assert.equal((await last()).filters[key], value); await reply();}
    await page.locator('#ua-details-filter-reset').click(); assert.deepEqual((await last()).filters, {}); await reply();
    await page.locator('#ua-panel-report table[aria-label="요청"]').getByRole('button', {name: 'r1', exact: true}).click(); assert.deepEqual((await last()).filters, {turnId: 'r1'}); await reply();
    await page.locator('#ua-details-filter-reset').click(); await reply();
    await page.locator('#ua-panel-report table').first().getByRole('button', {name: '호출 정렬', exact: true}).click();
    assert.equal(await page.locator('#ua-panel-report th[aria-sort="ascending"]').count(), 1);
    assert.equal(await page.locator('#ua-details-diagnostics').isVisible(), true);
    await page.locator('#ua-details-close').focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.textContent), '라이선스 전문');
    await page.keyboard.press('Tab'); assert.equal(await close.evaluate(value => value === document.activeElement), true);
    await page.locator('#ua-tab-report').focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#ua-tab-conversation').getAttribute('aria-selected'), 'true'); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#ua-tab-coverage').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End'); assert.equal(await page.locator('#ua-tab-history').getAttribute('aria-selected'), 'true');
    await page.locator('#ua-exclude-reason').fill('시험 제외');
    const focused = await page.evaluate(() => document.activeElement.id);
    await update({}); assert.equal(await page.evaluate(() => document.activeElement.id), focused, 'normal chart refresh preserves modal focus');
    await update({diagnosticsEnabled: false}); assert.equal(await page.locator('#ua-details-diagnostics').isVisible(), false);
    assert.equal(await dialog.isVisible(), true); assert.equal(await page.evaluate(() => document.activeElement.id), focused);
    await reply({...report, diagnostics: {enabled: false}});
    await update({diagnosticsEnabled: true}); await reply(); assert.equal(await page.locator('#ua-details-diagnostics').isVisible(), true);
    await update({diagnosticsEnabled: false}); await reply({...report, diagnostics: {enabled: false}});
    passed.push('keyboard activation, stale result/error guard, all filters, sorting, tabs, focus trap, refresh focus, diagnostics isolation');
    assert.equal(await page.locator('#ua-exclude-commit').isDisabled(), true);
    await page.locator('#ua-exclude-reason').fill('시험 제외');
    await page.locator('#ua-exclude-check').click();
    const previewRequest = await last(); assert.equal(previewRequest.type, 'analysisPreviewExclude'); assert.equal(previewRequest.reason, '시험 제외'); assert.equal(previewRequest.excludeStart, start); assert.equal(previewRequest.excludeEnd, end); assert.ok(previewRequest.start < start); assert.ok(previewRequest.end > end);
    assert.equal(await page.locator('#ua-exclude-commit').isDisabled(), true);
    await reply({...report, exclusionPreview: {start, end, reason: '시험 제외', before: {callCount: 3, knownCostUsd: 1.25}, after: {callCount: 2, knownCostUsd: 1}}});
    assert.equal(await page.locator('#ua-exclude-commit').isEnabled(), true);
    assert.match(await page.locator('#ua-exclude-preview').textContent(), /호출 3 → 2/);
    await page.locator('#ua-exclude-commit').click(); assert.equal((await last()).type, 'analysisExclude'); assert.equal((await last()).reason, '시험 제외'); await reply();
    await page.locator('#ua-panel-history table[aria-label="제외 이력"]').getByRole('button', {name: 'ex-1', exact: true}).click(); await page.getByRole('button', {name: '제외 복원', exact: true}).click(); assert.equal((await last()).type, 'analysisRestore'); assert.equal((await last()).exclusionId, 'ex-1'); await reply();
    await page.locator('#ua-exclude-reason').fill('오류 확인'); await page.locator('#ua-exclude-check').click(); const failureId = (await last()).requestId;
    await send({type: 'detailsError', requestId: failureId, error: 'host validation failed'}); assert.equal(await page.locator('#ua-exclude-commit').isDisabled(), true); assert.equal(await page.locator('#ua-details-retry').isVisible(), true);
    await page.locator('#ua-details-retry').click(); assert.equal((await last()).type, 'details'); await reply();
    passed.push('host-validated exclusion preview before commit, restore and error recovery');
    await close.click();
    const ignoredId = (await last()).requestId;
    await reply({...report, summary: {...report.summary, callCount: 999}}, ignoredId); assert.equal(await dialog.isVisible(), false);
    await page.setViewportSize({width: 360, height: 640}); await frame(); await open(); await reply({...report, analysisEnabled: false, diagnostics: {enabled: false}});
    const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 360); assert.ok(box.y >= 0 && box.y + box.height <= 640);
    const scroll = await page.locator('#ua-details-scroll').evaluate(value => ({width: value.clientWidth, scrollWidth: value.scrollWidth, height: value.clientHeight, scrollHeight: value.scrollHeight}));
    assert.ok(scroll.scrollHeight > scroll.height); assert.ok(scroll.scrollWidth <= scroll.width + 1, 'wide tables scroll locally at 360px');
    assert.equal(await page.locator('#ua-details-diagnostics').isVisible(), false);
    assert.match(await page.locator('#ua-panel-report').textContent(), /설정에서 꺼져/);
    await close.click(); await open('Space'); await reply(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.detailsLine), 'codex-five');
    await open(); const canceledId = (await last()).requestId; await close.click(); assert.equal((await last()).type, 'detailsClosed'); assert.equal((await last()).requestId, canceledId);
    await send({type: 'detailsError', requestId: canceledId, error: 'late'}); assert.equal(await dialog.isVisible(), false);
    const projectA = '12345678' + 'a'.repeat(56), projectB = '12345678' + 'b'.repeat(56), unnamedProject = 'c'.repeat(64), metadataProject = 'd'.repeat(64), unsafeProject = 'e'.repeat(64);
    const projectRows = [
      {...report.sessions.items[0], project: projectA, projectName: '공통 프로젝트'}
    , {...report.sessions.items[1], project: projectB, projectName: '공통 프로젝트'}
    , {id: 's3', sessionId: 's3', project: unnamedProject, projectName: null}
    , {id: 's4', sessionId: 's4', project: unsafeProject, projectName: 'C:\\PRIVATE\\project'}
    ];
    const projectReport = {
      ...report
    , sessions: bounded(projectRows)
    , requests: bounded([{...report.requests.items[0], project: projectB}])
    , calls: bounded([{...report.calls.items[0], project: projectA, projectName: '공통 프로젝트'}])
    , agents: bounded([{...report.agents.items[0], project: projectA, projectName: '공통 프로젝트'}])
    , projectLabels: {[projectA]: '공통 프로젝트', [projectB]: '공통 프로젝트', [metadataProject]: '추가 프로젝트', [unsafeProject]: 'C:\\PRIVATE\\project'}
    , filterOptions: {project: [projectA, projectB, unnamedProject, metadataProject, unsafeProject]}
    , filterOptionCounts: {project: 5}
    };
    await open(); await reply(projectReport);
    const projectSelect = page.locator('select[name="project"]');
    const labelA = await projectSelect.locator(`option[value="${projectA}"]`).textContent(), labelB = await projectSelect.locator(`option[value="${projectB}"]`).textContent();
    assert.match(labelA, /^공통 프로젝트 · 12345678…aaaaaa$/); assert.match(labelB, /^공통 프로젝트 · 12345678…bbbbbb$/); assert.notEqual(labelA, labelB);
    assert.equal(await projectSelect.locator(`option[value="${metadataProject}"]`).textContent(), '추가 프로젝트', 'metadata labels work without a visible session row');
    assert.equal(await projectSelect.locator(`option[value="${unnamedProject}"]`).textContent(), 'cccccccc…cccccc');
    assert.equal(await projectSelect.locator(`option[value="${unsafeProject}"]`).textContent(), 'eeeeeeee…eeeeee', 'raw paths cannot become display names');
    const sessionProjects = await page.locator('#ua-panel-report table[aria-label="세션 → 요청 → 호출"] tbody tr').evaluateAll(rows => rows.map(row => row.cells[2].textContent));
    assert.deepEqual(sessionProjects, [labelA, labelB, 'cccccccc…cccccc', 'eeeeeeee…eeeeee']);
    for (const id of [projectA, projectB, unnamedProject, metadataProject, unsafeProject]) assert.ok(!(await dialog.textContent()).includes(id), 'full project hashes cannot appear in visible labels');
    assert.ok(!(await dialog.textContent()).includes('C:\\PRIVATE\\project'));
    await projectSelect.selectOption(projectB); assert.deepEqual((await last()).filters, {project: projectB}, 'project filter requests retain the original hash');
    await reply({...projectReport, sessions: bounded([projectRows[1]]), requests: bounded([]), calls: bounded([]), agents: bounded([]), projectLabels: {[projectB]: '공통 프로젝트'}, filterOptions: {project: [projectB]}});
    assert.equal(await projectSelect.locator(`option[value="${projectA}"]`).textContent(), labelA, 'drilldown cannot erase previously observed project labels');
    await close.click(); await open(); await reply(); assert.equal(await projectSelect.locator(`option[value="${projectA}"]`).count(), 0, 'project labels are scoped to one modal opening'); await close.click();
    const catalogSources = require('../src/price-catalog.json').sources;
    const auditReport = {...report, provenance: {...report.provenance, sources: [
      ...catalogSources
    , catalogSources[0]
    , {url: 'javascript:alert(1)', title: 'unsafe-script'}
    , {url: 'data:text/html,unsafe', title: 'unsafe-data'}
    , {url: 'http://example.test/pricing', title: 'unsafe-http'}
    , {url: 'file:///C:/private/pricing', title: 'unsafe-file'}
    , {url: '//example.test/pricing', title: 'unsafe-relative'}
    , {url: 'https://user:secret@example.test/pricing', title: 'unsafe-credentials'}
    , {url: 'not a URL', title: 'unsafe-malformed'}
    ]}};
    await page.setViewportSize({width: 736, height: 900}); await frame(); await open(); await reply(auditReport);
    const sourceLinks = await page.locator('#ua-details-provenance a').evaluateAll(links => links.map(link => ({href: link.href, target: link.target, rel: link.rel, title: link.title, label: link.textContent, accessible: link.getAttribute('aria-label')})));
    assert.equal(sourceLinks.length, catalogSources.length, 'only unique absolute HTTPS sources without credentials become audit links');
    for (const [index, link] of sourceLinks.entries()) {assert.equal(link.href, catalogSources[index].url); assert.equal(link.target, '_blank'); assert.match(link.rel, /\bnoopener\b/); assert.match(link.rel, /\bnoreferrer\b/); assert.equal(link.title, catalogSources[index].title); assert.ok(link.label.length <= 24); assert.ok(link.accessible.includes(link.title));}
    assert.doesNotMatch(await page.locator('#ua-details-provenance').textContent(), /unsafe-/);
    const compact = await page.locator('#ua-details-provenance').evaluate(value => ({height: value.getBoundingClientRect().height, line: parseFloat(getComputedStyle(value).lineHeight)}));
    assert.ok(compact.height <= compact.line * 2.5, 'all catalog source links plus catalog/date stay within two rows at 736px');
    await page.setViewportSize({width: 360, height: 640}); await frame();
    const footerLayout = await page.locator('.ua-details-footer').evaluate(value => {
      const footer = value.getBoundingClientRect(), license = value.querySelector('a[href$="/LICENSE"]').getBoundingClientRect();
      return {clientWidth: value.clientWidth, scrollWidth: value.scrollWidth, top: footer.top, bottom: footer.bottom, licenseTop: license.top, licenseBottom: license.bottom};
    });
    assert.ok(footerLayout.scrollWidth <= footerLayout.clientWidth + 1, 'compact sources cannot create horizontal footer overflow at 360px');
    assert.ok(footerLayout.licenseTop >= footerLayout.top && footerLayout.licenseBottom <= footerLayout.bottom + 1, 'license remains visible alongside compact provenance at 360px');
    assert.equal(await page.locator('#ua-details-price-date').textContent(), '기준 2026-10-22'); await close.click();
    const mixedNote = '요금제·배율이 다른 사용률 구간이 섞여 있어 전체 환산값과 통합 민감도를 계산하지 않습니다.';
    await open(); await reply({...report, estimate: {...report.estimate, status: 'mixed-capacity', valueUsdPer100Pct: null, sensitivity: [], notes: [mixedNote]}});
    await page.locator('#ua-tab-performance').click();
    const mixedValues = await page.locator('#ua-panel-performance dt').filter({hasText: /^사용률 100%당 환산액 \(USD\)$/}).evaluateAll(values => values.map(value => value.nextElementSibling.textContent));
    assert.deepEqual(mixedValues, ['-'], 'mixed plan/capacity estimates remain unknown under the shared assumption');
    assert.equal(await page.locator('#ua-panel-performance table[aria-label="조건별 민감도"]').count(), 0); assert.equal(await page.locator('#ua-standard-scenario table[aria-label="Standard 가정별 민감도"]').count(), 0);
    assert.ok((await page.locator('#ua-panel-performance').textContent()).includes(mixedNote)); await close.click();
    const pricingCases = [
      [{costUsd: 0, priceIssue: null}, '확인']
    , [{costUsd: .2, priceAssumed: true}, '가정']
    , [{costUsd: null, priceIssue: 'unknown-mode'}, '모드 미확인']
    , [{costUsd: null, priceIssue: 'unsupported-model'}, '모델 미지원']
    , [{costUsd: null, priceIssue: 'unclassified-cache-write'}, '캐시 쓰기 분류·TTL 미확인']
    , [{costUsd: null, priceIssue: 'unknown-token-category-or-cache-ttl'}, '토큰 유형 또는 캐시 쓰기 TTL 미확인']
    , [{costUsd: null, priceIssue: 'unsupported-cache-write-ttl'}, '캐시 쓰기 TTL 미지원']
    , [{costUsd: null, priceIssue: 'unknown-or-invalid-cacheWrite5m'}, '5분 캐시 쓰기 미확인·오류']
    , [{costUsd: null, priceIssues: ['conflicting-observation'], priceIssue: 'conflicting-observation; invalid-reasoning-subset'}, '관측값 충돌 · 추론 토큰 범위 오류']
    , [{costUsd: null, priceAssumed: true, priceIssue: 'unsupported-model'}, '가정 · 모델 미지원']
    , [{costUsd: null, priceAssumed: true}, '가정 · 환산액 미확인']
    , [{costUsd: null, priceIssue: 'PRIVATE_UNKNOWN_ISSUE_SENTINEL'}, '환산 사유 미확인']
    , [{costUsd: null}, '-']
    ];
    await open(); await reply({...report, calls: bounded(pricingCases.map(([value], index) => ({id: 'price-' + index, model: 'model-a', sessionId: 's1', pricePolicyRef: 'PRIVATE_POLICY_SENTINEL', ...value})))});
    const pricingTable = page.locator('#ua-panel-report table[aria-label="호출"]');
    assert.ok((await pricingTable.locator('th').allTextContents()).includes('환산 상태'));
    const statusIndex = (await pricingTable.locator('th').allTextContents()).indexOf('환산 상태');
    const pricingCells = await pricingTable.locator('tbody tr').evaluateAll((rows, index) => rows.map(row => row.cells[index].textContent), statusIndex);
    assert.deepEqual(pricingCells, pricingCases.map(([, expected]) => expected));
    assert.doesNotMatch(await pricingTable.textContent(), /unknown-mode|unsupported-model|cacheWrite5m|PRIVATE_UNKNOWN_ISSUE_SENTINEL|PRIVATE_POLICY_SENTINEL/);
    assert.equal(await pricingTable.locator('tbody tr').first().locator('td').nth(10).textContent(), '0', 'a confirmed zero cost cannot be mistaken for a missing value'); await close.click();
    await page.setViewportSize({width: 1440, height: 900}); await frame();
    const conversationHome = 'a'.repeat(64);
    const newestReport = {...report
    , sessions: bounded([{...report.sessions.items[0], homeKey: conversationHome, lastObservedAt: start}, {...report.sessions.items[1], homeKey: conversationHome, lastObservedAt: end}])
    , requests: bounded([{...report.requests.items[0], homeKey: conversationHome, lastObservedAt: end}])
    , calls: bounded(report.calls.items.map(row => ({...row, homeKey: conversationHome})))
    };
    await update({analysisEnabled: true}); const doublePoint = await point(); await page.mouse.dblclick(doublePoint.x, doublePoint.y); assert.equal(await dialog.isVisible(), true); await reply(newestReport);
    const sessionTable = page.locator('table[aria-label="세션 → 요청 → 호출"]');
    assert.equal(await sessionTable.locator('tbody tr').first().locator('td').first().textContent(), 's2');
    await sessionTable.getByRole('button', {name: '최근 정렬', exact: true}).click();
    await sessionTable.getByRole('button', {name: '최근 정렬', exact: true}).click();
    assert.equal(await sessionTable.locator('th[aria-sort="descending"]').textContent(), '최근');
    await sessionTable.getByRole('button', {name: '대화 보기', exact: true}).first().click();
    const conversationRequest = await last(); assert.equal(conversationRequest.type, 'conversation'); assert.equal(conversationRequest.conversationSessionId, 's2'); assert.equal(conversationRequest.conversationHomeKey, conversationHome);
    await send({type: 'conversation', requestId: 'stale-conversation', data: {items: [{role: 'user', time: end, text: 'STALE_TRANSCRIPT'}]}});
    assert.equal(await dialog.getByText('STALE_TRANSCRIPT').count(), 0);
    const transcript = {items: [{role: 'user', time: start, text: '<img src=x onerror="window.XSS=1"> 질문', context: true}, {role: 'assistant', time: end, text: '작업 결과', clipped: true}], next: 'older-page-token'};
    await send({type: 'conversation', requestId: conversationRequest.requestId, data: transcript});
    assert.equal(await page.locator('#ua-tab-conversation').getAttribute('aria-selected'), 'true');
    const articles = page.locator('.ua-conversation-message'); assert.equal(await articles.count(), 2);
    assert.equal(await articles.first().locator('pre').textContent(), '작업 결과'); assert.match(await articles.last().textContent(), /선택 구간 이전/);
    assert.equal(await page.locator('#ua-panel-conversation img').count(), 0); assert.equal(await page.evaluate(() => window.XSS), undefined);
    for (const [width, height] of [[1440, 900], [2400, 1400], [360, 640], [800, 400]]) {
      await page.setViewportSize({width, height}); await update({pageWidth: 400, pageHeight: 300});
      const full = await dialog.boundingBox(); assert.ok(Math.abs(full.x) < 1 && Math.abs(full.y) < 1 && Math.abs(full.width - width) < 1 && Math.abs(full.height - height) < 1);
      const fit = await page.locator('#ua-details-scroll').evaluate(node => node.scrollWidth <= node.clientWidth + 1); assert.equal(fit, true);
    }
    await page.setViewportSize({width: 1440, height: 900}); await frame();
    await page.screenshot({path: path.join(dir, 'screenshots/details-conversation-fullscreen.png')});
    await page.getByRole('button', {name: '이전 대화', exact: true}).click(); assert.equal((await last()).cursor, 'older-page-token');
    await send({type: 'conversation', requestId: (await last()).requestId, data: {items: [{role: 'user', time: start - 1000, text: '이전 질문', context: true}], next: null}});
    assert.equal(await articles.count(), 1); assert.equal(await page.getByRole('button', {name: '이전 대화', exact: true}).isDisabled(), true);
    await page.getByRole('button', {name: '최신 대화', exact: true}).click(); assert.equal((await last()).cursor, null);
    const lateConversation = (await last()).requestId; await close.click();
    await send({type: 'conversation', requestId: lateConversation, data: transcript}); assert.equal(await page.getByText('작업 결과', {exact: true}).count(), 0);
    passed.push('latest-first sessions/calls, descending time-header clicks, on-demand conversation, plain-text injection isolation, paging, stale/close cancellation and fullscreen resize independent of page settings');
    assert.deepEqual(errors, []); passed.push('closed response cancellation, 360px bounds/local table scrolling, analysis-off availability');
    passed.push('Korean account-binding notes, modal-only partial coverage, enum labels with unchanged filter values');
    passed.push('date-only provenance has no invented time; real timestamps retain KST time; invalid dates remain unknown');
    passed.push('shared Standard-assumed sensitivity stays visible with null estimate; duplicate mode scenario removed; API latency provenance reason is visible');
    passed.push('friendly project names, duplicate-name short IDs, metadata-only labels, short hash fallback, unchanged filter hashes and per-open label cache');
    passed.push('compact clickable HTTPS audit sources, source-title tooltips, opener isolation, invalid URL rejection and visible license at 360px');
    passed.push('mixed-capacity shared estimate remains unknown, all combined sensitivities absent, host explanation visible');
    passed.push('call pricing status explains missing mode/model/cache TTL, distinguishes confirmed/assumed/zero cost, hides raw issues and policy IDs');
    console.log(JSON.stringify({status: 'PASS', cases: passed}, null, 2));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
