'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project, hash} = require('../src/core.cjs');
const {buildConversion, converter} = require('../src/credit-conversion.cjs');
const {analyze} = require('../src/analytics.cjs');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, 'media', file), 'utf8');
const now = Date.now(), base = now - 600000, account = hash('codex');
const records = [0, 1, 2].map(i => ({v: 1, provider: 'codex', account, plan: 'pro', time: base + i * 60000, creditBalance: i < 2 ? 1000 : 900, windows: {five: {used: [0, 10, 25][i], reset: now + 18000000}, week: {used: [0, 2, 5][i], reset: now + 604800000}}}));
const calls = [1, 2].map(i => ({id: 'call-' + i, provider: 'codex', account, homeKey: 'fixture', sessionId: 'session-' + i, time: base + i * 60000 - 1000, startedAt: null, completedAt: null, completionState: 'unknown', model: 'gpt-6.1-sol', mode: i === 1 ? 'unknown' : 'Fast', input: 1000000, cached: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0}));
const capacities = ['five', 'week'].map(window => ({provider: 'codex', account, plan: 'pro', window, mult: 5, time: base}));
const options = {records, calls, capacities, now};
const conversion = buildConversion(options);
const data = {type: 'data', now, count: records.length, data: project(records, capacities, undefined, converter(conversion)), analysisEnabled: true, detailsEnabled: true};
const report = analyze({...options, provider: 'codex', account, window: 'five', start: base, end: now, cursorTime: now, conversionModel: conversion});
const doc = '<!doctype html><html><head><meta charset="utf-8"><style>' + read('style.css') + '</style></head><body>' + read('body.html') + '<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:m=>{if(m.type==="details")queueMicrotask(()=>window.dispatchEvent(new MessageEvent("message",{data:{type:"details",requestId:m.requestId,data:window.fixtureReport}})));}});</script>' + ['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'details.js', 'provider-focus.js', 'app.js'].map(file => '<script>' + read(file) + '</script>').join('') + '</body></html>';
(async () => {
  const browser = await chromium.launch(browserOptions), errors = [];
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}}); page.on('pageerror', error => errors.push(error.message));
    await page.setContent(doc); await page.evaluate(({data, report}) => {window.fixtureReport = report; window.dispatchEvent(new MessageEvent('message', {data}));}, {data, report});
    await page.locator('#ua-credit').check(); await page.locator('#ua-credit-mode').selectOption('estimate');
    const expected = {usage: {five: 50, week: 10}, delta: {five: 40, week: 8}, total: {five: 50, week: 10}};
    for (const mode of ['usage', 'delta', 'total']) {
      await page.locator('#ua-mode').selectOption(mode);
      await page.waitForFunction(({mode, expected}) => ['five', 'week'].every(window => [...document.querySelectorAll('path[data-series="codex-' + window + '"]')].some(n => Math.abs(n.__data__.at(-1)?.y - expected[mode][window]) < 1e-9)), {mode, expected});
    }
    await page.locator('#ua-mode').selectOption('usage'); await page.locator('#ua-basis').selectOption('base');
    await page.waitForFunction(() => [...document.querySelectorAll('path[data-series="codex-five"]')].some(n => n.__data__.at(-1)?.y === 250));
    await page.locator('#ua-credit-mode').selectOption('money'); await page.waitForSelector('[data-series="codex-credit"]');
    assert.equal(await page.locator('[data-series="codex-credit"]').last().evaluate(n => n.__data__.at(-1).amount), 100);
    for (const basis of ['current', 'base']) {
      await page.locator('#ua-basis').selectOption(basis);
      await page.waitForFunction(() => !!document.querySelector('[data-credit-window="five"]'));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const [quotaKey, creditKey] of [['codex-five', 'codex-credit-five'], ['codex-week', 'codex-credit']]) {
        const positions = await page.evaluate(({quotaKey, creditKey}) => {
          const last = key => [...document.querySelectorAll('[data-series="' + key + '"]')].filter(n => n.tagName === 'path' && Number.isFinite(n.__data__?.at(-1)?.y)).at(-1);
          const q = last(quotaKey), c = last(creditKey), frame = document.querySelector('[data-chart-frame]'), svg = document.querySelector('#ua-chart');
          return {quota: q.getPointAtLength(q.getTotalLength()).y, credit: c.getPointAtLength(c.getTotalLength()).y, value: c.__data__.at(-1).y, bottom: Number(frame.getAttribute('y')) + Number(frame.getAttribute('height')), height: Number(frame.getAttribute('height')), maximum: Number(svg.dataset.yMax)};
        }, {quotaKey, creditKey});
        assert.ok(Math.abs(positions.quota - positions.credit) < .01, 'equal quota and credit percentages have equal physical y');
        assert.ok(Math.abs(positions.credit - (positions.bottom - positions.value / positions.maximum * positions.height)) < .01, 'native credits use the shared percent scale');
      }
    }
    await page.locator('#ua-basis').selectOption('current');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        const svg = document.querySelector('#ua-chart');
        const line = [...svg.querySelectorAll('[data-series="codex-five"]')].filter(n => n.tagName === 'path' && Number.isFinite(n.__data__?.at(-1)?.y)).at(-1);
        const position = line.getPointAtLength(line.getTotalLength()), anchor = new DOMPoint(position.x, position.y).matrixTransform(svg.getScreenCTM());
        svg.dispatchEvent(new WheelEvent('wheel', {ctrlKey: true, deltaY: -500, clientX: anchor.x, clientY: anchor.y, bubbles: true, cancelable: true}));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    });
    await page.screenshot({path: path.join(root, 'screenshots/credit-axis-aligned.png')});

    await page.locator('[data-details-line="codex-five"]').first().focus(); await page.keyboard.press('Enter');
    const table = page.locator('table[aria-label="호출"]'); await table.waitFor();
    const values = await table.evaluate(node => {const labels = [...node.querySelectorAll('th')].map(n => n.textContent); return [...node.querySelectorAll('tbody tr')].map(row => Object.fromEntries(labels.map((label, i) => [label, row.cells[i].textContent])));});
    const fast = values.find(row => row['모드'] === '빠름'), assumed = values.find(row => row['모드'] === '-');
    assert.equal(fast['크레딧 차감 추정'], '100'); assert.equal(fast['구독 환산 단위'], '125'); assert.equal(fast['구독 환산 사용률 (%)'], '25'); assert.equal(fast['구독 환산 상태'], '추정 · 관측 시각');
    assert.match(assumed['차감 상태'], /Standard 가정/); assert.equal(assumed['구독 환산 사용률 (%)'], '10');
    await page.locator('#ua-tab-performance').click(); assert.match(await page.locator('#ua-panel-performance').textContent(), /Standard 가정/); assert.equal(await page.locator('#ua-standard-scenario').count(), 0);
    await page.screenshot({path: path.join(root, 'screenshots/automatic-credit-conversion.png')});
    assert.deepEqual(errors, []);
    const result = {status: 'PASS', cases: ['real backend calibration -> chart all modes', 'current/base multiplier', 'native credits preserved', 'page native credit and quota percentages share physical y in both bases', 'Fast purchased/subscription multiplier alignment', 'per-call percent equals chart increment', 'unknown mode Standard assumption visible', 'missing starts use observed event estimates visibly', 'one shared estimate without duplicate scenario'], errors};
    fs.writeFileSync(path.join(root, 'test-credit-conversion-ui.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
