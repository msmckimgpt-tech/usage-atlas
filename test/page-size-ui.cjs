const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project, hash} = require('../src/core.cjs');
const dir = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(dir, 'media', file), 'utf8');
const now = +new Date(2026, 9, 21, 12);
const records = ['codex', 'claude'].flatMap(provider => [0, 1, 2].map(i => ({
    v: 1, provider, account: hash(provider), plan: 'test', time: now - (2 - i) * 300000
  , windows: {five: {used: 20 + i * 5, reset: now + 3600000}, week: {used: 40 + i * 3, reset: now + 7 * 86400000}}
  , ...(provider === 'codex' ? {creditBalance: 1000 - i * 10} : {spentUsd: i, spendPeriod: '2026-10'})
}))).sort((a, b) => a.time - b.time);
const model = {type: 'data', now, data: project(records), colorMode: 'dark'};
const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${read('style.css')}</style></head><body>${read('body.html')}<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}});</script>${['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-focus.js', 'app.js'].map(file => `<script>${read(file)}</script>`).join('')}</body></html>`;
(async () => {
  const browser = await chromium.launch(browserOptions);
  const report = {status: 'RUNNING', cases: [], errors: []};
  try {
    const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
    page.on('pageerror', error => report.errors.push(error.message));
    await page.setContent(doc);
    const update = async size => {
      await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), {...model, ...size});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const bounds = () => page.evaluate(() => {
      const root = document.getElementById('usage-atlas'), chart = document.getElementById('ua-chart');
      const rect = node => {const r = node.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height};};
      return {
          root: rect(root), chart: rect(chart), view: [chart.viewBox.baseVal.width, chart.viewBox.baseVal.height]
        , scroll: [root.clientHeight, root.scrollHeight], viewport: [innerWidth, innerHeight]
        , document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight]
        , range: [chart.dataset.domainStart, chart.dataset.domainEnd]
      };
    });
    const check = async name => {
      const b = await bounds();
      assert.ok(b.root.x >= 7 && b.root.y >= 7, name + ' top/left inside');
      assert.ok(b.root.x + b.root.width <= b.viewport[0] - 7 && b.root.y + b.root.height <= b.viewport[1] - 7, name + ' right/bottom inside');
      assert.ok(Math.abs(b.root.x + b.root.width / 2 - b.viewport[0] / 2) < 1, name + ' horizontal center');
      assert.ok(Math.abs(b.root.y + b.root.height / 2 - b.viewport[1] / 2) < 1, name + ' vertical center');
      assert.ok(b.document[0] <= b.viewport[0] && b.document[1] <= b.viewport[1], name + ' no window overflow');
      assert.ok(Math.abs(b.chart.height - b.view[1]) < 1, name + ' chart height matches viewBox');
      assert.equal(await page.locator('path[d*="NaN"]').count(), 0);
      report.cases.push({name, ...b}); return b;
    };
    await update({pageWidth: 1000, pageHeight: 800});
    const configured = await check('configured'); assert.equal(configured.root.width, 1000); assert.equal(configured.root.height, 800);
    const idleChanges = await page.evaluate(() => new Promise(resolve => {
      let changes = 0;
      const observer = new MutationObserver(() => changes++); observer.observe(document.getElementById('ua-chart'), {childList: true});
      setTimeout(() => {observer.disconnect(); resolve(changes);}, 200);
    }));
    assert.equal(idleChanges, 0, 'size observer does not create an idle redraw loop');
    await page.screenshot({path: path.join(dir, 'screenshots', 'page-size-configured.png')});
    await update({pageWidth: 480, pageHeight: 850});
    const compact = await check('compact-in-wide-window'); assert.equal(compact.root.width, 480);
    assert.ok(await page.locator('[data-legend-cell="claude-five"]').evaluate(node => node.getBoundingClientRect().width > node.parentElement.getBoundingClientRect().width * .9), 'provider layout responds to page width');
    await update({pageWidth: 4000, pageHeight: 4000});
    const large = await check('oversized'); assert.equal(large.root.width, 1904); assert.equal(large.root.height, 1064);
    for (const size of [
        {width: 1280, height: 720}
      , {width: 640, height: 480}
      , {width: 320, height: 280}
      , {width: 1920, height: 1080}
    ]) {
      await page.setViewportSize(size); await page.waitForTimeout(70); await check('resize-' + size.width + 'x' + size.height);
    }
    await update({pageWidth: 1000, pageHeight: 850});
    const beforeHeight = await check('before-height-only-resize');
    await page.setViewportSize({width: 1920, height: 640}); await page.waitForTimeout(70);
    const afterHeight = await check('height-only-resize');
    assert.ok(afterHeight.chart.height < beforeHeight.chart.height); assert.equal(afterHeight.chart.width, beforeHeight.chart.width);
    await page.locator('#ua-nav-pan').focus(); await page.keyboard.press('+'); await page.waitForTimeout(40);
    const zoomed = (await bounds()).range;
    await update({pageWidth: 900, pageHeight: 600});
    const changed = await check('live-settings'); assert.equal(changed.root.width, 900); assert.equal(changed.root.height, 600); assert.deepEqual(changed.range, zoomed);
    await page.locator('#ua-credit').check(); await page.waitForTimeout(40);
    assert.deepEqual((await bounds()).root, changed.root, 'credit toggle never changes configured page size');
    await update({pageWidth: 16384, pageHeight: 16384});
    await page.setViewportSize({width: 320, height: 280}); await page.waitForTimeout(70);
    const small = await check('short-window'); assert.ok(small.scroll[1] > small.scroll[0], 'very short page has internal scroll');
    await page.locator('#ua-nav-pan').focus(); await page.waitForTimeout(30);
    assert.ok(await page.locator('#usage-atlas').evaluate(node => node.scrollTop > 0), 'bottom controls reachable through internal scroll');
    await page.screenshot({path: path.join(dir, 'screenshots', 'page-size-short.png')});
    await page.setViewportSize({width: 1920, height: 1080}); await update({pageWidth: 0, pageHeight: 0});
    const automatic = await check('automatic'); assert.equal(automatic.root.width, 1904); assert.equal(automatic.root.height, 1064);
    await page.screenshot({path: path.join(dir, 'screenshots', 'page-size-auto-fill.png')});
    await page.setViewportSize({width: 1920, height: 760}); await page.waitForTimeout(70);
    const autoResized = await check('automatic-height-only-resize'); assert.equal(autoResized.root.height, 744); assert.ok(autoResized.chart.height < automatic.chart.height); assert.equal(autoResized.chart.width, automatic.chart.width);
    await page.setViewportSize({width: 320, height: 280}); await page.waitForTimeout(70);
    const autoSmall = await check('automatic-short-window'); assert.equal(autoSmall.root.height, 264); assert.ok(autoSmall.scroll[1] > autoSmall.scroll[0]);
    await page.setViewportSize({width: 1920, height: 1080}); await page.waitForTimeout(70);
    await update({}); const defaults = await check('defaults'); assert.equal(defaults.root.width, 1440); assert.equal(defaults.root.height, 1064);
    await update({pageWidth: '100px; color:red', pageHeight: -1}); const invalid = await check('invalid-fallback'); assert.equal(invalid.root.width, 1440); assert.equal(invalid.root.height, defaults.root.height);
    assert.deepEqual(report.errors, []); report.status = 'PASS';
  } catch (error) {report.status = 'FAIL'; report.error = error.message; throw error;}
  finally {await browser.close(); fs.writeFileSync(path.join(dir, 'test-page-size-ui.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));}
})().catch(error => {console.error(error); process.exitCode = 1;});
