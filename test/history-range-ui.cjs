'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project, hash} = require('../src/core.cjs');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, 'media', file), 'utf8');
const now = Date.now(), day = 86400000, week = 7 * day;
const records = ['codex', 'claude'].flatMap(provider => Array.from({length: 121}, (_, i) => {
  const time = now - (120 - i) * day;
  return {v: 1, provider, account: hash(provider), plan: 'fixture', time, windows: {five: {used: i % 100, reset: time + 18000000}, week: {used: i % 100, reset: time + week}}};
}));
const data = project(records), initial = {type: 'data', data, now, firstObserved: now - 120 * day, colorMode: 'dark', count: records.length, chartHistoryDays: 30};
const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + read('style.css') + '</style></head><body>' + read('body.html') + '<script>window.savedState=null;window.acquireVsCodeApi=()=>({getState:()=>null,setState:v=>window.savedState=structuredClone(v),postMessage:()=>{}});</script><script type="application/json" id="ua-initial-data">' + JSON.stringify(initial).replace(/</g, '\\u003c') + '</script>' + ['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-focus.js', 'app.js'].map(name => '<script>' + read(name) + '</script>').join('') + '</body></html>';
(async () => {
  const browser = await chromium.launch(browserOptions);
  const result = {status: 'RUNNING', cases: [], errors: []};
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}}); page.on('pageerror', error => result.errors.push(error.message));
    await page.setContent(html); let model = initial;
    const painted = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const update = async value => {model = {...model, ...value}; await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', {data: value})), model); await painted();};
    const range = () => page.locator('#ua-chart').evaluate(node => [Number(node.dataset.domainStart), Number(node.dataset.domainEnd), Number(node.dataset.extentStart), Number(node.dataset.extentEnd)]);
    const expectRange = async days => {const r = await range(); assert.ok(Math.abs(r[0] - Math.max(model.firstObserved, model.now - Math.max(days, 0) * day)) < 2); assert.ok(Math.abs(r[1] - model.now - week) < 2);};
    await painted(); await expectRange(30); result.cases.push('first HTML honors 30-day setting with unchanged future week');
    for (const days of [7, 1, 90, 365]) {await update({chartHistoryDays: days}); await expectRange(days); assert.equal((await range())[2], model.firstObserved);}
    result.cases.push('1/7/90/365-day settings apply immediately and clamp to retained history');
    await update({chartHistoryDays: 30}); await page.locator('#ua-nav-pan').focus(); await page.keyboard.press('+'); await painted();
    const zoomed = (await range()).slice(0, 2); await update({now: now + 60000}); assert.deepEqual((await range()).slice(0, 2), zoomed);
    await page.locator('#ua-navigator').dblclick(); await painted(); await expectRange(30);
    await page.keyboard.press('+'); await painted(); await page.keyboard.press('Home'); await painted(); await expectRange(30);
    result.cases.push('ordinary data updates preserve user zoom; double click and Home restore configured period');
    await update({chartHistoryDays: 7}); const box = await page.locator('[data-chart-hit]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down({button: 'middle'}); await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2);
    await update({chartHistoryDays: 30}); await page.mouse.up({button: 'middle'}); await painted(); await expectRange(30);
    assert.equal(await page.locator('#ua-chart').getAttribute('data-pan'), null);
    result.cases.push('changing period cancels an active pan without restoring the old range');
    for (const width of [320, 1920]) {await page.setViewportSize({width, height: 900}); await painted(); await expectRange(30); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));}
    for (const invalid of [0, -1, 366, 1.5, '30', null]) {await update({chartHistoryDays: invalid}); await expectRange(7);}
    result.cases.push('responsive layout preserves period and invalid values fall back to original ±7-day view');
    await update({chartHistoryDays: 30}); await page.setViewportSize({width: 1440, height: 900}); await painted(); await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({path: path.join(root, 'screenshots/history-range-30-days.png')});
    assert.deepEqual(result.errors, []); result.status = 'PASS';
  } finally {await browser.close(); fs.writeFileSync(path.join(root, 'test-history-range-ui.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));}
})().catch(error => {console.error(error); process.exitCode = 1;});
