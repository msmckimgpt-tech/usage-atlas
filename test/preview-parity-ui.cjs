'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project, hash} = require('../src/core.cjs');
const {preview} = require('../src/hover.cjs');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, 'media', file), 'utf8');
const now = +new Date(2026, 9, 22, 16), minute = 60000, start = now - 5 * 3600000;
const records = ['codex', 'claude'].flatMap(provider => Array.from({length: 5001}, (_, i) => {
  const time = now - (5000 - i) * minute, missing = i % 97 === 40;
  return {v: 1, provider, account: hash(provider), plan: 'fixture', time
    , windows: {five: missing ? null : {used: i % 300 / 3, reset: now - (5000 - (Math.floor(i / 300) + 1) * 300) * minute}, week: missing ? null : {used: i / 100, reset: now + 2 * 86400000}}
    , ...(provider === 'codex' ? {creditBalance: missing ? null : 100000 - i} : {spentUsd: missing ? null : i / 100, spendPeriod: 'fixture'})};
})).sort((a, b) => a.time - b.time);
const capacities = ['five', 'week'].map(window => ({provider: 'codex', account: hash('codex'), plan: 'fixture', window, time: records[0].time, mult: 5}));
const projection = project(records, capacities, undefined, (provider, mine, windows) => {
  for (const [window, points] of Object.entries(windows)) for (const p of points) {
    const factor = (provider === 'codex' ? 1 : 100) * (window === 'five' ? .05 : .025);
    p.creditEstimate = {nativeUsage: Number.isFinite(p.credit.usage) ? p.credit.usage * factor : null, nativeUsageContinuous: p.credit.usageContinuous};
  }
});
const doc = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + read('style.css') + '</style></head><body>' + read('body.html') + '<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}});</script>' + ['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-focus.js', 'app.js'].map(file => '<script>' + read(file) + '</script>').join('') + '</body></html>';
(async () => {
  const browser = await chromium.launch(browserOptions);
  const report = {status: 'RUNNING', cases: [], errors: []};
  try {
    for (const {width, dark, large} of [{width: 1440, dark: true}, {width: 1440, dark: false}, {width: 360, dark: true}, {width: 360, dark: false}, {width: 1440, dark: true, large: true}, {width: 360, dark: true, large: true}]) {
      const displayProjection = structuredClone(projection);
      if (large) for (const provider of Object.values(displayProjection)) for (const points of Object.values(provider.windows)) for (const p of points) if (Number.isFinite(p.creditEstimate?.nativeUsage)) p.creditEstimate.nativeUsage *= 10;
      const page = await browser.newPage({viewport: {width, height: 900}});
      page.on('pageerror', error => report.errors.push(error.message));
      await page.setContent(doc);
      await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), {type: 'data', now, firstObserved: records[0].time, count: records.length, data: displayProjection, colorMode: dark ? 'dark' : 'light'});
      await page.locator('#ua-credit').check();
      await page.evaluate(async ({start, now}) => {
        const svg = document.querySelector('#ua-chart');
        const redraw = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await redraw();
        for (let i = 0; i < 8; i++) {
          const span = +svg.dataset.domainEnd - +svg.dataset.domainStart, delta = Math.log((now - start) / span) / .002;
          if (Math.abs(delta) < .00001) break;
          const frame = svg.querySelector('[data-chart-frame]'), box = svg.getBoundingClientRect();
          svg.dispatchEvent(new WheelEvent('wheel', {ctrlKey: true, deltaY: Math.max(-500, Math.min(500, delta)), clientX: box.left + +frame.getAttribute('x') + +frame.getAttribute('width') / 2, bubbles: true, cancelable: true}));
          await redraw();
        }
        const span = +svg.dataset.domainEnd - +svg.dataset.domainStart, frame = svg.querySelector('[data-chart-frame]');
        svg.dispatchEvent(new WheelEvent('wheel', {shiftKey: true, deltaX: (start - +svg.dataset.domainStart) / span * +frame.getAttribute('width'), bubbles: true, cancelable: true}));
        await redraw();
      }, {start, now});
      const mini = preview(records, {now, projection: displayProjection, capacities, dark}), miniMax = +mini.svg.match(/data-y-max="([^"]+)"/)[1];
      const labelsFit = await page.evaluate(svg => {
        const box = document.createElement('div'); box.innerHTML = svg; document.body.append(box);
        const bounds = [...box.querySelectorAll('[data-y-label]')].map(node => node.getBBox()); box.remove();
        return bounds.length === 3 && bounds.every(b => b.x >= 0 && b.x + b.width <= 360);
      }, mini.svg);
      assert.ok(labelsFit, 'all digits of large percent labels fit inside the mini chart');
      const pageData = await page.evaluate(() => {
        const svg = document.querySelector('#ua-chart'), frame = svg.querySelector('[data-chart-frame]'), top = +frame.getAttribute('y'), height = +frame.getAttribute('height');
        const lines = Object.fromEntries(['codex', 'claude'].flatMap(id => ['five', 'week', 'credit-five', 'credit'].map(w => {
          const key = id + '-' + w, node = [...svg.querySelectorAll('[data-series="' + key + '"]')].filter(n => n.tagName === 'path' && Number.isFinite(n.__data__?.at(-1)?.y)).at(-1);
          const position = node.getPointAtLength(node.getTotalLength()), matrix = node.getCTM();
          const y = node.hasAttribute('transform') ? matrix.f : position.y; return [key, {fraction: (y - top) / height, value: node.__data__.at(-1).y}];
        })));
        return {start: +svg.dataset.domainStart, end: +svg.dataset.domainEnd, maximum: +svg.dataset.yMax, lines};
      });
      assert.ok(Math.abs(pageData.start - start) < 2 && Math.abs(pageData.end - now) < 2, 'actual wheel gestures reach the identical five-hour range');
      assert.ok(Math.abs(pageData.maximum - miniMax) < 1e-8, 'same visible domain has the same percent scale');
      const clip = mini.svg.match(/<clipPath id="plot"><rect[^>]*y="([^"]+)"[^>]*height="([^"]+)"/), miniTop = +clip[1], miniHeight = +clip[2];
      for (const [key, data] of Object.entries(pageData.lines)) {
        const d = mini.svg.match(new RegExp('data-series="' + key + '"[^>]*><path d="([^"]*)"'))[1];
        const y = +[...d.matchAll(/[ML][\d.-]+,([\d.-]+)/g)].at(-1)[1];
        assert.ok(Math.abs(data.fraction - (y - miniTop) / miniHeight) < .0005, key + ' has the same relative plot height');
      }
      for (const id of ['codex', 'claude']) {
        assert.match(mini.svg, new RegExp('data-interpolated="' + id + '-five"'));
        assert.ok((await page.locator('#ua-chart [data-interpolated="' + id + '-five"]').count()) > 0);
        assert.match(mini.svg, new RegExp('data-reset-history="' + id + '-five"'));
      }
      if (width === 1440 && dark && !large) {
        await page.evaluate(svg => {const box = document.createElement('div'); box.style.cssText = 'position:fixed;right:40px;bottom:110px;background:#1a1d23;border:1px solid #3a414c;padding:8px'; box.innerHTML = svg; document.body.append(box);}, mini.svg);
        await page.screenshot({path: path.join(root, 'screenshots/preview-page-parity.png')});
      }
      report.cases.push({width, dark, large: !!large, percentMaximum: miniMax, series: Object.keys(pageData.lines).length, rawRecords: records.length, projectedPoints: projection.codex.windows.five.length});
      await page.close();
    }
    assert.deepEqual(report.errors, []); report.status = 'PASS';
  } finally {await browser.close(); fs.writeFileSync(path.join(root, 'test-preview-page-parity.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));}
})().catch(error => {console.error(error); process.exitCode = 1;});
