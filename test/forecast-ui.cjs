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
    assert.equal(await page.locator('#ua-chart').getAttribute('data-highlight-series'), 'codex-five');
    await page.waitForTimeout(260);
    assert.equal(await page.locator('[data-forecast-trend="codex-five"]').evaluate(node => getComputedStyle(node).strokeWidth), '1.8px');
    assert.match(await page.locator('#ua-tooltip').textContent(), /Codex.*5시간.*100% 소진 예상/);
    assert.ok(await page.locator('#ua-tooltip div').count() <= 5);
    await page.screenshot({path: path.join(root, 'screenshots/forecast-trend-page.png')});
    await marker.focus(); assert.equal(await page.locator('#ua-tooltip').getAttribute('hidden'), null); await page.keyboard.press('Escape'); assert.notEqual(await page.locator('#ua-tooltip').getAttribute('hidden'), null);
    report.cases.push('four actual native quota deadlines, compact hover, keyboard focus and escape');
    const trend = page.locator('[data-forecast-trend="codex-five"]');
    const middle = await trend.evaluate(n => {const p = n.getPointAtLength(n.getTotalLength() / 2), q = new DOMPoint(p.x, p.y).matrixTransform(n.ownerSVGElement.getScreenCTM()); return {x: q.x, y: q.y};});
    await page.mouse.move(middle.x, middle.y); await page.waitForSelector('#ua-tooltip[data-detail="forecast-trend"]:not([hidden])');
    assert.match(await page.locator('#ua-tooltip').textContent(), /Codex.*5시간 구독 예측.*≈75%/);
    assert.equal(await page.locator('#ua-chart').getAttribute('data-highlight-series'), 'codex-five');
    await trend.focus(); await page.keyboard.press('Escape'); assert.notEqual(await page.locator('#ua-tooltip').getAttribute('hidden'), null);
    assert.equal(await page.locator('.ua-highlight-trace').count(), 0);
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
    assert.equal(preview(resetRecords, {now, projection: resetData}).summaries[0].forecasts.five.text, '≈50.5%');
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
    const fallbackNow = patternNow, hour = 3600000;
    const fallbackRecords = ['codex', 'claude', 'antigravity-5d72436256ada538'].flatMap(id => {
      const source = require('./pattern-fixture.cjs').records(fallbackNow, id);
      source[source.length - 3].time = fallbackNow - 4 * hour;
      return source;
    }).sort((a, b) => a.time - b.time);
    const fallbackData = project(fallbackRecords, [], undefined, undefined, (_id, _mine, windows) => forecast.provider(windows, {learning: {five: {method: 'recent'}, week: {method: 'recent'}}}));
    await update({now: fallbackNow, data: fallbackData});
    assert.equal(await page.locator('[data-forecast-trend]').count(), 6);
    for (const id of Object.keys(fallbackData)) for (const window of ['five', 'week']) {
      const line = page.locator('[data-forecast-trend="' + id + '-' + window + '"]');
      assert.equal(+await line.getAttribute('data-start-value'), fallbackData[id].windows[window].at(-1).value);
      assert.equal(+await line.getAttribute('data-end-time'), fallbackData[id].forecast[window].eta ?? fallbackData[id].forecast[window].reset);
    }
    await page.screenshot({path: path.join(root, 'screenshots/forecast-sparse-history.png')});
    const correctedRecords = fallbackRecords.concat(Object.keys(fallbackData).map(id => {
      const row = fallbackRecords.findLast(row => row.provider === id);
      return {...row, time: fallbackNow + minute, windows: {five: {...row.windows.five, used: 49}, week: {...row.windows.week, used: 49}}};
    })).sort((a, b) => a.time - b.time);
    const correctedData = calculate(correctedRecords);
    await update({now: fallbackNow + minute, data: correctedData});
    assert.equal(await page.locator('[data-forecast-trend]').count(), 6);
    const starts = await page.locator('[data-forecast-trend]').evaluateAll(nodes => nodes.map(node => +node.dataset.startValue));
    assert.deepEqual(starts, Array(6).fill(49));
    await page.screenshot({path: path.join(root, 'screenshots/forecast-corrected-history.png')});
    report.cases.push('Codex/Claude/AGY five/week render six future curves from qualified history despite sparse recent coverage or a usage correction; selected recent policies also fall back');
    // 예측 기록 토글: 주기마다 고정한 기준 예측 하나를 지나간 구간(진하게)과 남은 구간(흐리게)으로 겹치고 다른 UI 배치는 바꾸지 않는다.
    await page.locator('#ua-credit').uncheck(); await page.selectOption('#ua-mode', 'usage'); await page.selectOption('#ua-basis', 'current');
    const recordNow = now, hourMs = 60 * minute, dayMs = 24 * hourMs, five = recordNow + 4 * hourMs + 20 * minute, week = recordNow + 6 * dayMs + 17 * hourMs, snapshots = {
        // 5시간 창 주기 시작 = 지금-40분. 시작 직후(-40분)는 기준이 아니고, 30분이 지난 -10분 예측이 기준이다.
        codex: {five: [{at: recordNow - 40 * minute, reset: five, mult: 5, points: [[recordNow - 40 * minute, 20], [five, 95]]}, {at: recordNow - 10 * minute, reset: five, mult: 5, points: [[recordNow - 10 * minute, 30], [recordNow + 2 * hourMs, 60], [five, 90]]}]
          // 주간 창 주기 시작 = 지금-7시간. 6시간이 지난 -55분 예측이 기준이다.
          , week: [{at: recordNow - 55 * minute, reset: week, mult: 5, points: [[recordNow - 55 * minute, 30], [recordNow + dayMs, 60]]}]}
      , claude: {five: [{at: recordNow - 35 * minute, reset: five, mult: null, points: [[recordNow - 35 * minute, 10], [five, 70]]}, {at: recordNow - 8 * minute, reset: five, mult: null, points: [[recordNow - 8 * minute, 20], [recordNow + 3 * hourMs, 80]]}, {at: recordNow + minute, reset: five, mult: null, points: [[recordNow + minute, 50], [recordNow + 2 * hourMs, 60]]}]}
    };
    await update({now: recordNow, data, forecastRecord: snapshots});
    const toggle = page.locator('#ua-pace-record');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false'); assert.equal(await page.locator('[data-forecast-record]').count(), 0);
    const layout = () => page.evaluate(() => Object.fromEntries(['chart', 'navigator', 'range', 'environment', 'codex', 'claude', 'mode', 'settings'].map(id => {const r = document.getElementById('ua-' + id).getBoundingClientRect(); return [id, [r.x, r.y, r.width, r.height].map(v => Math.round(v * 10) / 10)];})));
    const before = await layout();
    await toggle.click(); await paint();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await layout(), before, 'toggling the record never moves other controls');
    // 기본 보기는 예측 시각: 최신 스냅샷의 주간 예측 한 줄만 그리고, 5시간 창은 체크했을 때만 더한다.
    assert.equal(await page.locator('#ua-record-panel').isVisible(), true); assert.equal(await page.locator('#ua-record-asof').getAttribute('aria-pressed'), 'true');
    assert.deepEqual((await page.locator('[data-forecast-record]').evaluateAll(nodes => nodes.map(n => n.dataset.forecastRecord + ':' + n.dataset.recordPart))).sort(), ['codex-week:future', 'codex-week:past'], 'default as-of view draws one line per model and window');
    await page.locator('#ua-record-base').click(); await paint();
    const records3 = await page.locator('[data-forecast-record]').evaluateAll(nodes => nodes.map(n => {const xs = [...n.getAttribute('d').matchAll(/[ML](-?[\d.e+]+),/g)].map(m => +m[1]); return {key: n.dataset.forecastRecord, part: n.dataset.recordPart, count: +n.dataset.recordCount, events: getComputedStyle(n).pointerEvents, opacity: +n.getAttribute('opacity'), minX: Math.min(...xs), maxX: Math.max(...xs)};}));
    assert.deepEqual(records3.map(r => r.key + ':' + r.part + ':' + r.count).sort(), ['claude-five:future:1', 'claude-five:past:1', 'codex-five:future:1', 'codex-five:past:1', 'codex-week:future:1', 'codex-week:past:1'], 'one baseline per cycle; snapshots from now or before the lead time are not baselines');
    const nowX = +await page.locator('[data-now]').getAttribute('x1');
    for (const r of records3) {
      assert.equal(r.events, 'none');
      if (r.part === 'past') {assert.ok(r.maxX <= nowX + .01, 'past part stops at the current time'); assert.equal(r.opacity, .8);}
      else {assert.ok(r.minX >= nowX - .01, 'future part starts at the current time'); assert.ok(r.opacity < .5, 'future part is fainter');}
    }
    const anchors = await page.locator('[data-record-anchor]').evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.dataset.recordAnchor, +n.dataset.recordAt])));
    assert.deepEqual(anchors, {'codex-five': recordNow - 10 * minute, 'codex-week': recordNow - 55 * minute, 'claude-five': recordNow - 8 * minute}, 'the anchor marks when the baseline forecast was made');
    const corner = await page.evaluate(() => {const b = document.getElementById('ua-pace-record').getBoundingClientRect(), g = document.querySelector('.ua-graph').getBoundingClientRect(); return {right: g.right - b.right, bottom: g.bottom - b.bottom};});
    assert.ok(Math.abs(corner.right) < 1 && Math.abs(corner.bottom) < 1, 'toggle sits at the bottom-right corner of the graph');
    await page.screenshot({path: path.join(root, 'screenshots/forecast-record-on.png')});
    assert.equal(await toggle.getAttribute('aria-disabled'), 'false'); assert.match(await toggle.getAttribute('title'), /기준 예측.*표시 중 3개/, 'counts one baseline per cycle');
    await page.selectOption('#ua-mode', 'delta'); await paint(); assert.equal(await page.locator('[data-forecast-record]').count(), 0); assert.equal(await page.locator('[data-record-anchor]').count(), 0);
    assert.equal(await toggle.getAttribute('aria-disabled'), 'true', 'unsupported views mark the toggle unavailable'); assert.match(await toggle.getAttribute('title'), /사용률 보기에서 표시/);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'the choice is remembered');
    await page.selectOption('#ua-mode', 'usage'); await page.selectOption('#ua-basis', 'base'); await paint();
    assert.deepEqual(await page.locator('[data-forecast-record]').evaluateAll(nodes => nodes.map(n => n.dataset.recordGroup).sort()), ['claude-five-raw-future', 'claude-five-raw-past', 'codex-five-scaled-future', 'codex-five-scaled-past', 'codex-week-scaled-future', 'codex-week-scaled-past'], 'base capacity puts unknown-multiplier snapshots on the raw axis');
    await page.selectOption('#ua-basis', 'current');
    await page.setViewportSize({width: 360, height: 900}); await page.waitForTimeout(80);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.equal(await page.locator('[data-forecast-record]').count(), 6);
    await page.setViewportSize({width: 1440, height: 900});
    // 예측 시각 보기: 슬라이더로 고른 시각에 기록돼 있던 예측을 그리고, 스냅샷 사이는 보정하며, 비교 고정은 한 줄만 더한다.
    await page.locator('#ua-record-asof').click(); await paint();
    const paths = () => page.locator('[data-forecast-record]').evaluateAll(nodes => nodes.map(n => n.dataset.forecastRecord + ':' + n.dataset.recordPart + (n.dataset.recordPin ? ':pin' : '') + (n.dataset.recordBlended ? ':blended' : '')).sort());
    const setSlider = async offset => {await page.evaluate(offset => {const s = document.getElementById('ua-record-time'); s.value = String(+s.min + offset); s.dispatchEvent(new Event('input', {bubbles: true}));}, offset); await paint();};
    await page.locator('#ua-record-five').check(); await paint();
    assert.deepEqual(await paths(), ['claude-five:future', 'claude-five:past', 'codex-five:future', 'codex-five:past', 'codex-week:future', 'codex-week:past'], 'the five-hour window is added only when checked');
    const sliderMin = +await page.locator('#ua-record-time').getAttribute('min'); assert.equal(sliderMin, recordNow - 55 * minute, 'range starts at the oldest stored snapshot');
    await setSlider(10 * minute);
    assert.deepEqual(await paths(), ['codex-week:future', 'codex-week:past'], 'models without a snapshot yet at the chosen time draw nothing');
    assert.deepEqual(await page.locator('[data-record-anchor]').evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.dataset.recordAnchor, +n.dataset.recordAt]))), {'codex-week': sliderMin + 10 * minute}, 'the anchor marks the chosen forecast time');
    assert.match(await page.locator('#ua-record-label').textContent(), /예측 시각 .*시간 전/);
    await setSlider(30 * minute);
    assert.ok((await paths()).includes('codex-five:past:blended'), 'a time between two snapshots is a blended value');
    assert.match(await page.locator('#ua-record-label').textContent(), /보정/);
    await page.locator('#ua-record-pin').click(); await paint();
    assert.equal(await page.locator('#ua-record-pin').getAttribute('aria-pressed'), 'true');
    await setSlider(10 * minute);
    assert.ok((await paths()).some(p => p.endsWith(':pin')), 'the pinned forecast time stays drawn for comparison');
    assert.match(await page.locator('#ua-record-label').textContent(), /고정/);
    await page.locator('#ua-record-pin').click(); await paint(); assert.equal((await paths()).filter(p => p.endsWith(':pin')).length, 0);
    await page.locator('#ua-record-latest').click(); await paint();
    assert.equal(+await page.locator('[data-record-anchor="claude-five"]').getAttribute('data-record-at'), recordNow - 8 * minute, 'latest returns to the newest stored forecast');
    await page.selectOption('#ua-record-ease', 'linear'); await paint(); assert.equal(await page.locator('#ua-record-ease').inputValue(), 'linear');
    assert.deepEqual(await layout(), before, 'the record panel never moves other controls');
    await page.locator('#ua-record-five').uncheck(); await page.locator('#ua-record-base').click(); await paint();
    await update({now: recordNow, data, forecastRecord: {}}); assert.match(await toggle.getAttribute('title'), /기준 예측이 아직 없습니다/);
    await toggle.click(); await paint(); assert.equal(await page.locator('[data-forecast-record]').count(), 0);
    await update({now: recordNow, data, forecastRecord: snapshots, forecastEnabled: false}); assert.equal(await toggle.isHidden(), true);
    report.cases.push('forecast record toggle overlays one fixed baseline forecast per cycle (past solid, future faint) at the bottom-right without moving other UI');
    report.cases.push('forecast record as-of view draws the forecast stored at the chosen time (one line per model and window), blends between snapshots, pins one comparison time and keeps the record panel from moving other UI');
    assert.deepEqual(report.errors, []); report.status = 'PASS';
  } finally {await browser.close(); fs.writeFileSync(path.join(root, 'test-forecast-ui.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));}
})().catch(error => {console.error(error); process.exitCode = 1;});
