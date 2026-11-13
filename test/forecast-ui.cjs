'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project, hash} = require('../src/core.cjs');
const {converter} = require('../src/credit-conversion.cjs');
const {preview} = require('../src/hover.cjs');
const forecast = require('../media/forecast.js');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, 'media', file), 'utf8');
const now = Date.now(), minute = 60000;
const records = ['codex', 'claude'].flatMap(provider => Array.from({length: 61}, (_, i) => ({v: 1, provider, account: hash(provider), plan: 'fixture', time: now - (60 - i) * minute, windows: {five: {used: provider === 'codex' ? 20 + i / 2 : 10 + i * .75, reset: now + 5 * 3600000}, week: {used: (provider === 'codex' ? 30 : 40) + i / 4, reset: now + 5 * 86400000}}, ...(provider === 'codex' ? {creditBalance: 1000} : {spentUsd: 0, spendPeriod: 'fixture'})}))).sort((a, b) => a.time - b.time);
const capacities = ['five', 'week'].map(window => ({provider: 'codex', account: hash('codex'), plan: 'fixture', window, time: records[0].time, mult: 5}));
const calculate = source => project(source, capacities, undefined, converter(null), (_id, _mine, windows) => forecast.provider(windows));
const data = calculate(records), model = {type: 'data', data, now, count: records.length, colorMode: 'dark', forecastEnabled: true};
const doc = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + read('style.css') + '</style></head><body>' + read('body.html') + '<script>window.openedDetails=[];window.usageAtlasDetails=()=>({open:value=>window.openedDetails.push(value),isOpen:()=>false});window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}});</script>' + ['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-visibility.js', 'app.js'].map(file => '<script>' + read(file) + '</script>').join('') + '</body></html>';
(async () => {
  const browser = await chromium.launch(browserOptions);
  const report = {status: 'RUNNING', cases: [], errors: []};
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}}); page.on('pageerror', e => report.errors.push(e.message));
    await page.setContent(doc);
    const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const update = async value => {await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), {...model, ...value}); await paint();};
    await update({}); assert.equal(await page.locator('[data-forecast]').count(), 4);
    await page.locator('#ua-nav-pan').focus(); for (let i = 0; i < 5; i++) {await page.keyboard.press('+'); await paint();}
    const positions = async () => page.locator('[data-forecast]').evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.dataset.forecast, {x: n.getAttribute('x1'), eta: +n.dataset.time}])));
    const original = await positions();
    assert.equal(await page.locator('[data-forecast-trend]').count(), 4);
    const joins = await page.evaluate(() => [...document.querySelectorAll('[data-forecast-trend]')].map(node => {
      const key = node.dataset.forecastTrend, observed = [...document.querySelectorAll('[data-series="' + key + '"]')].filter(n => n.tagName === 'path' && Number.isFinite(n.__data__?.at(-1)?.y)).at(-1);
      const a = node.getPointAtLength(0), b = node.getPointAtLength(node.getTotalLength()), last = observed.getPointAtLength(observed.getTotalLength());
      const endpoint = document.querySelector('[data-forecast-marker="' + key + '"]').getCTM();
      return {startDistance: Math.hypot(a.x - last.x, a.y - last.y), endDistance: Math.hypot(b.x - endpoint.e, b.y - endpoint.f)};
    }));
    for (const join of joins) {assert.ok(join.startDistance < .01); assert.ok(join.endDistance < .01);}
    report.cases.push('all four projected curves physically join the last observation and the exhaustion marker');
    for (const id of ['codex', 'claude']) for (const window of ['five', 'week']) assert.equal(original[id + '-' + window].eta, data[id].forecast[window].eta);
    const marker = page.locator('[data-forecast-marker="codex-five"]');
    const box = await marker.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#ua-tooltip[data-detail="forecast"]:not([hidden])');
    assert.match(await page.locator('#ua-tooltip').textContent(), /Codex.*5시간.*100% 소진 예상/);
    assert.ok(await page.locator('#ua-tooltip div').count() <= 5);
    await page.screenshot({path: path.join(root, 'screenshots/forecast-trend-page.png')});
    await marker.focus(); assert.equal(await page.locator('#ua-tooltip').getAttribute('hidden'), null); await page.keyboard.press('Escape'); assert.notEqual(await page.locator('#ua-tooltip').getAttribute('hidden'), null);
    report.cases.push('four actual native quota deadlines, compact hover, keyboard focus and escape');
    const trend = page.locator('[data-forecast-trend="codex-five"]');
    const middle = await trend.evaluate(n => {const p = n.getPointAtLength(n.getTotalLength() / 2), q = new DOMPoint(p.x, p.y).matrixTransform(n.ownerSVGElement.getScreenCTM()); return {x: q.x, y: q.y};});
    await page.mouse.move(middle.x, middle.y); await page.waitForSelector('#ua-tooltip[data-detail="forecast-trend"]:not([hidden])');
    assert.match(await page.locator('#ua-tooltip').textContent(), /Codex.*5시간 구독 예측.*≈75%/);
    await trend.focus(); await page.keyboard.press('Escape'); assert.notEqual(await page.locator('#ua-tooltip').getAttribute('hidden'), null);
    report.cases.push('projected line hover reports the estimated value and supports keyboard focus/Escape');
    const adjacent = await trend.evaluate(n => {const p = n.getPointAtLength(n.getTotalLength() * .02), q = new DOMPoint(p.x, p.y).matrixTransform(n.ownerSVGElement.getScreenCTM()); return {x: q.x, y: q.y};});
    await page.mouse.click(adjacent.x, adjacent.y); assert.equal(await page.evaluate(() => window.openedDetails.length), 0, 'future line near the last real point must not open a historical call report');
    const observed = await page.locator('[data-series="codex-five"]').first().evaluate(n => {const p = n.getPointAtLength(n.getTotalLength() / 2), q = new DOMPoint(p.x, p.y).matrixTransform(n.ownerSVGElement.getScreenCTM()); return {x: q.x, y: q.y};});
    await page.mouse.click(observed.x, observed.y); assert.equal(await page.evaluate(() => window.openedDetails.length), 1, 'actual observations retain graph-click details');
    report.cases.push('forecast-only clicks never open historical reports while real graph clicks still work');
    for (const mode of ['usage', 'delta', 'total']) {
      await page.locator('#ua-mode').selectOption(mode);
      for (const basis of ['current', 'base']) {
        await page.locator('#ua-basis').selectOption(basis); await page.locator('#ua-credit').check();
        for (const creditMode of ['money', 'estimate']) {
          await page.locator('#ua-credit-mode').selectOption(creditMode); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.deepEqual(await positions(), original, 'forecast times do not depend on display mode, capacity scaling or extra credits');
          assert.equal(await page.locator('[data-forecast-trend]').count(), mode === 'delta' ? 0 : 4);
        }
      }
    }
    report.cases.push('usage/delta/total, current/base and native/additive credits preserve deadlines and positions');
    await page.locator('#ua-claude').click(); await page.waitForFunction(() => document.querySelectorAll('[data-forecast-trend]').length === 2);
    assert.equal(await page.locator('[data-forecast-trend^="claude-"]').count(), 0); assert.equal(await page.locator('#ua-codex').getAttribute('aria-pressed'), 'true');
    await page.locator('#ua-claude').click(); await page.waitForFunction(() => document.querySelectorAll('[data-forecast-trend]').length === 4);
    await page.locator('#ua-mode').selectOption('usage'); await page.locator('#ua-basis').selectOption('base');
    const expanded = project(records, capacities.map(c => ({...c, mult: 20})), undefined, converter(null), (_id, _mine, windows) => forecast.provider(windows));
    await update({data: expanded}); assert.equal(+(await page.locator('#ua-chart').getAttribute('data-y-max')), 2160);
    assert.equal(+(await page.locator('[data-forecast-trend="codex-five"]').getAttribute('data-end-value')), 2000);
    report.cases.push('independent model visibility and x20 base capacity endpoints update correctly with visible forecast axis expansion');
    const mini = preview(records, {now, projection: data, capacities});
    assert.equal(mini.start, now - 5 * 3600000); assert.equal(mini.end, now); assert.doesNotMatch(mini.svg, /data-forecast/);
    assert.equal(mini.svg, preview(records, {now, projection: data, capacities, forecastEnabled: false}).svg);
    for (const [i, id] of ['codex', 'claude'].entries()) for (const window of ['five', 'week']) assert.equal(mini.summaries[i].forecasts[window].eta, data[id].forecast[window].eta);
    report.cases.push('preview shares deadlines, keeps the fixed past-five-hour SVG and returns quantitative time/remainder summaries');
    await page.setViewportSize({width: 360, height: 900}); await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-forecast]').count(), 4); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    report.cases.push('360px compact layout stays inside the editor');
    await update({forecastEnabled: false}); assert.equal(await page.locator('[data-forecast]').count(), 0); assert.equal(await page.locator('[data-forecast-trend]').count(), 0);
    await update({now: now + 16 * minute}); assert.equal(await page.locator('[data-forecast]').count(), 0); assert.equal(await page.locator('[data-forecast-trend]').count(), 0);
    const resetRecords = records.map(r => ({...r, windows: {five: {...r.windows.five, reset: now + minute}, week: {...r.windows.week, reset: now + minute}}}));
    const resetData = calculate(resetRecords); await update({data: resetData}); assert.equal(await page.locator('[data-forecast]').count(), 0);
    assert.equal(preview(resetRecords, {now, projection: resetData}).summaries[0].forecasts.five.text, '≈49.5%');
    assert.equal(await page.locator('[data-forecast-trend][data-end-kind="reset"]').count(), 4); assert.equal(await page.locator('[data-forecast-boundary]').count(), 4);
    report.cases.push('disabled/stale hide curves; reset-first trends stop at the reset boundary without an exhaustion marker');
    const patternNow = Math.floor(now / 3600000) * 3600000;
    const patternRecords = ['codex', 'claude'].flatMap(id => require('./pattern-fixture.cjs').records(patternNow, id).map(r => {
      const shift = r.time < patternNow - 10 * 86400000 ? 10 * 86400000 : r.time < patternNow - 2 * 86400000 ? 4 * 86400000 : 0;
      return {...r, time: r.time + shift, windows: Object.fromEntries(['five', 'week'].map(w => [w, {...r.windows[w], reset: r.windows[w].reset + shift}]))};
    }));
    const patternData = calculate(patternRecords);
    await page.setViewportSize({width: 1440, height: 900});
    await page.selectOption('#ua-mode', 'usage'); await page.selectOption('#ua-basis', 'current');
    await update({now: patternNow, data: patternData});
    assert.ok(patternData.codex.forecast.five.pattern);
    assert.ok(patternData.codex.forecast.five.pattern.tierMatchedMs.dayType + patternData.codex.forecast.five.pattern.tierMatchedMs.hour > 0);
    const shaped = page.locator('[data-forecast-trend="codex-five"]');
    assert.ok(await shaped.evaluate(n => n.__data__.points.length > 2));
    const shapeEnd = await shaped.evaluate(n => {const b = n.getPointAtLength(n.getTotalLength()), m = document.querySelector('[data-forecast-marker="codex-five"]').getCTM(); return Math.hypot(b.x - m.e, b.y - m.f);});
    assert.ok(shapeEnd < .01);
    const shapePoint = await shaped.evaluate(n => {const p = n.getPointAtLength(n.getTotalLength() * .65), t = n.ownerSVGElement.createSVGPoint(); t.x = p.x; t.y = p.y; const q = t.matrixTransform(n.getScreenCTM()); return {x: q.x, y: q.y};});
    await page.mouse.move(shapePoint.x, shapePoint.y); await page.waitForSelector('#ua-tooltip[data-detail="forecast-trend"]:not([hidden])');
    assert.match(await page.locator('#ua-tooltip').textContent(), /구독 예측.*≈/);
    await shaped.focus(); await page.waitForSelector('#ua-tooltip[data-detail="forecast-trend"]:not([hidden])'); await page.keyboard.press('Escape');
    await shaped.evaluate(n => n.blur());
    await page.screenshot({path: path.join(root, 'screenshots/forecast-pattern-page.png')});
    report.cases.push('short-history tiered correction renders piecewise curves with accurate endpoint, segment hover and keyboard focus');
    const ranged = calculate(records);
    for (const id of ['codex', 'claude']) for (const window of ['five', 'week']) ranged[id].forecast[window].calibration = {errors: [{hours: .25, samples: 12, dates: 4, low: -65, high: 35}, {hours: .75, samples: 12, dates: 4, low: -85, high: 2}]};
    for (const width of [1440, 360]) for (const mode of ['usage', 'total']) for (const basis of ['current', 'base']) {
      await page.setViewportSize({width, height: 900});
      await page.locator('#ua-mode').selectOption(mode); await page.locator('#ua-basis').selectOption(basis);
      await update({data: ranged});
      const bands = await page.locator('[data-forecast-range]').evaluateAll(nodes => nodes.map(node => ({
          key: node.dataset.forecastRange
        , range: node.__data__
        , points: [...node.getAttribute('d').matchAll(/[ML](-?[\d.e+]+),(-?[\d.e+]+)/g)].map(match => ({x: +match[1], y: +match[2]}))
        , center: document.querySelector('[data-forecast-trend="' + node.dataset.forecastRange + '"]').__data__.points
      })));
      assert.equal(bands.length, 4);
      for (const band of bands) {
        const n = band.range.length, floor = band.center[0].y, top = band.points.slice(0, n), bottom = band.points.slice(n).reverse();
        assert.equal(band.points.length, 2 * n); assert.equal(band.range[0].low, floor); assert.equal(band.range[0].high, floor);
        for (let i = 1; i < n; i++) {
          assert.ok(band.range[i].low >= band.range[i - 1].low && band.range[i].high >= band.range[i - 1].high);
          assert.ok(top[i].x > top[i - 1].x && top[i].y <= top[i - 1].y, 'actual upper SVG edge cannot slope down');
          assert.ok(bottom[i].x > bottom[i - 1].x && bottom[i].y <= bottom[i - 1].y, 'actual lower SVG edge cannot slope down');
          assert.ok(band.range[i].low >= floor && band.range[i].low <= band.range[i].high);
        }
      }
      assert.equal(await page.locator('#ua-chart').evaluate(node => /NaN|Infinity/.test(node.innerHTML)), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.screenshot({path: path.join(root, 'screenshots/forecast-monotone-range-narrow.png')});
    await page.setViewportSize({width: 1440, height: 900}); await page.locator('#ua-mode').selectOption('usage'); await page.locator('#ua-basis').selectOption('current'); await update({data: ranged});
    await page.screenshot({path: path.join(root, 'screenshots/forecast-monotone-range-wide.png')});
    report.cases.push('both providers and windows: error-band data and actual SVG boundaries stay nondecreasing in usage/total, current/base, 1440/360px');
    assert.deepEqual(report.errors, []); report.status = 'PASS';
  } finally {await browser.close(); fs.writeFileSync(path.join(root, 'test-forecast-ui.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));}
})().catch(error => {console.error(error); process.exitCode = 1;});
