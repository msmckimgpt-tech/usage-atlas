'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project} = require('../src/core.cjs');
const {buildConversion, converter} = require('../src/credit-conversion.cjs');
const creditGraphs = require('../media/credit-series.js');
const chartGraphs = require('../media/chart-series.js');
const {preview} = require('../src/hover.cjs');
const {fixture} = require('./credit-gap-fixture.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const input = fixture(), model = buildConversion(input), before = JSON.stringify(input);
  const projected = project(input.records, input.capacities, undefined, converter(model));
  const media = file => fs.readFile(path.join(root, 'media', file), 'utf8');
  const scripts = ['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-visibility.js', 'app.js'];
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' + await media('style.css') + '</style></head><body>' + await media('body.html') + '<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}});</script>' + (await Promise.all(scripts.map(async file => '<script>' + await media(file) + '</script>'))).join('') + '</body></html>';
  const result = {status: 'RUNNING', cases: [], errors: [], providerRequests: 0, sourceWrites: 0};
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage(); page.on('pageerror', error => result.errors.push(error.message)); await page.setContent(html);
    const update = async (data, now = input.now) => {
      await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', {data: value})), {type: 'data', data, now, colorMode: 'dark', chartHistoryDays: 7});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await update(projected); await page.locator('#ua-credit').check();
    for (const width of [1440, 360]) {
      await page.setViewportSize({width, height: 900});
      for (const mode of ['usage', 'delta', 'total']) for (const basis of ['current', 'base']) for (const creditMode of ['money', 'estimate']) {
        await page.locator('#ua-mode').selectOption(mode); await page.locator('#ua-basis').selectOption(basis); await page.locator('#ua-credit-mode').selectOption(creditMode);
        for (const id of ['codex', 'claude']) for (const window of ['five', 'week']) {
          const key = creditMode === 'money' ? id + (window === 'five' ? '-credit-five' : '-credit') : id + '-' + window;
          const source = creditMode === 'money' ? creditGraphs.series(projected[id], id, {mode, basis}).find(series => series.creditWindow === window && Number.isFinite(series.points.at(-1)?.y)) : chartGraphs.quota(projected[id], id, window, {mode, basis, credit: true, creditMode}).find(series => Number.isFinite(series.points.at(-1)?.y));
          const expected = source.points.at(-1).y;
          await page.waitForFunction(({key, time, expected}) => [...document.querySelectorAll('[data-series="' + key + '"]')].some(node => node.__data__?.at(-1)?.time === time && Math.abs(node.__data__.at(-1).y - expected) < 1e-9), {key, time: input.now, expected});
        }
        result.cases.push({width, mode, basis, creditMode});
      }
    }
    await page.locator('#ua-mode').selectOption('usage'); await page.locator('#ua-basis').selectOption('current'); await page.locator('#ua-credit-mode').selectOption('money');
    const mini = preview(input.records, {now: input.now, projection: projected});
    for (const id of ['codex', 'claude']) for (const window of ['five', 'week']) {
      const key = creditGraphs.key(id, window), expected = creditGraphs.series(projected[id], id).find(series => series.creditWindow === window).points.at(-1).y;
      assert.match(mini.svg, new RegExp('data-credit-window="' + window + '"'));
      await page.waitForFunction(({key, expected}) => [...document.querySelectorAll('[data-series="' + key + '"]')].some(node => Math.abs((node.__data__?.at(-1)?.y ?? Infinity) - expected) < 1e-9), {key, expected});
      const y = await page.locator('[data-series="' + key + '"]').evaluateAll(nodes => nodes.filter(node => Number.isFinite(node.__data__?.at(-1)?.y)).at(-1).__data__.at(-1).y);
      assert.equal(y, expected);
    }
    const appended = [...input.records, ...input.records.filter(row => row.time === input.now).map(row => ({...row, time: input.now + 60000, ...(row.provider === 'codex' ? {creditBalance: 625} : {spentUsd: 15})}))];
    const pending = project(appended, input.capacities, undefined, converter(model)); await update(pending, input.now + 60000);
    assert.equal(pending.codex.windows.week.at(-1).creditEstimate.standardPending, true);
    await page.waitForFunction(time => [...document.querySelectorAll('[data-series="codex-credit"]')].some(node => node.__data__?.at(-1)?.time === time), input.now + 60000);
    const missingFive = input.records.map(row => row.provider === 'codex' ? {...row, windows: {...row.windows, five: null}} : row);
    const noFive = project(missingFive, input.capacities, undefined, converter(buildConversion({...input, records: missingFive}))); await update(noFive);
    assert.equal(noFive.codex.windows.five.at(-1).creditEstimate.nativeUsage, null);
    assert.ok(noFive.codex.windows.week.at(-1).creditEstimate.nativeUsage > 0);
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-series="codex-credit-five"]')].some(node => node.__data__?.some(point => point.y > 0)) && !!document.querySelector('[data-series="codex-credit"]'));
    await page.setViewportSize({width: 1440, height: 900}); await page.screenshot({path: path.join(root, 'screenshots/credit-gap-restored.png')});
    assert.equal(JSON.stringify(input), before); assert.deepEqual(result.errors, []);
    result.status = 'PASS'; result.pagePreviewShared = true; result.appendImmediate = true; result.missingFiveHasNoWeeklyFallback = true; result.sourceUnchanged = true;
  } finally {
    await browser.close(); await fs.writeFile(path.join(root, 'test-credit-gap-ui.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
