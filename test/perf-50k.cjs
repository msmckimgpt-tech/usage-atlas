'use strict';
// 50,000건 기록에서 초기 렌더·hover·확대·이동 반응 시간을 측정한다. 사용: node test/perf-50k.cjs [건수]
const fs = require('node:fs');
const path = require('node:path');
const {chromium, browserOptions} = require('./browser.cjs');
const {project, hash} = require('../src/core.cjs');
const dir = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(dir, 'media', file), 'utf8');
const total = Number(process.argv[2]) || 50000, per = Math.floor(total / 2), now = Date.now(), step = 300000;
function fixture() {
  const records = [], capacities = [];
  for (const id of ['codex', 'claude']) {
    capacities.push({provider: id, account: hash(id), plan: 'test', window: 'five', time: now - per * step, mult: id === 'claude' ? 5 : 1});
    for (let n = 0; n < per; n++) {
      const t = now - (per - 1 - n) * step, cycle = Math.floor(n / 150), w = Math.floor(n / 5040);
      records.push({v: 1, provider: id, account: hash(id), plan: 'test', time: t, ...(id === 'codex' ? {creditBalance: 65000 - n * 4} : {spentUsd: n / 1000, spendPeriod: '2026-10'}), windows: {five: {used: (n % 150) * 0.66, reset: now + (cycle - Math.floor(per / 150) + 1) * 18000000}, week: {used: Math.min(100, (n % 5040) / 50.4), reset: now + (w - Math.floor(per / 5040) + 1) * 604800000}}});
    }
  }
  return {type: 'data', now, theme: 1, colorMode: 'system', tooltipTransparency: 14, count: records.length, data: Object.fromEntries(Object.entries(project(records, capacities)).map(([id, p]) => [id, {...p, status: {message: '정상'}}]))};
}
const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${read('style.css')}</style></head><body>${read('body.html')}<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:s=>{window.saved=s;},postMessage:m=>{window.sent=m;}});</script>` + ['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-visibility.js', 'app.js'].map(f => `<script>${read(f)}</script>`).join('') + '</body></html>';
const stats = a => {const s = [...a].sort((x, y) => x - y); return {n: s.length, min: +s[0].toFixed(2), p50: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * .95)].toFixed(2), max: +s.at(-1).toFixed(2)};};
(async () => {
  const model = fixture();
  const browser = await chromium.launch(browserOptions), errors = [];
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}}); page.on('pageerror', e => errors.push(e.message));
    await page.setContent(doc.replace('<script>window.acquireVsCodeApi', '<script>{const raf = window.requestAnimationFrame.bind(window); window.rawRaf = raf; window.cbTimes = []; window.requestAnimationFrame = f => raf(t => {const a = performance.now(); f(t); window.cbTimes.push(performance.now() - a);});}</script><script>window.acquireVsCodeApi'));
    const cdp = process.env.PROFILE ? await page.context().newCDPSession(page) : null;
    if (cdp) {await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', {interval: 200}); await cdp.send('Profiler.start');}
    const first = await page.evaluate(async data => {
      const t = performance.now(); window.dispatchEvent(new MessageEvent('message', {data}));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {renderMs: performance.now() - t, series: document.querySelectorAll('[data-series]').length, nodes: document.querySelectorAll('#ua-chart *').length, pathBytes: [...document.querySelectorAll('path[data-series]')].reduce((n, p) => n + p.getAttribute('d').length, 0)};
    }, model);
    if (process.env.SKIP_HOVER) await page.evaluate(() => {window.skipHover = true;});
    const result = await page.evaluate(async () => {
      const chart = document.getElementById('ua-chart'), box = chart.getBoundingClientRect();
      const raw = window.rawRaf;
      // main = 이벤트 처리 + 그리기 콜백 + 강제 스타일·레이아웃. 래스터(GPU)는 헤드리스에서 소프트웨어로 돌아 제외하고 toFrame에만 포함한다.
      const frame = () => new Promise(r => raw(r));
      const out = {};
      async function measure(name, count, act) {
        const sync = [], total = [], main = [], drawA = [], layoutA = [];
        for (let i = 0; i < count; i++) {
          window.cbTimes.length = 0;
          const t0 = performance.now(); act(i); const t1 = performance.now();
          let layout = 0;
          await new Promise(r => raw(() => {const t = performance.now(); chart.getBoundingClientRect(); document.body.offsetHeight; layout = performance.now() - t; r();}));
          const draw = window.cbTimes.reduce((a, b) => a + b, 0); (window.calls ||= {})[name] = Math.max((window.calls[name] || 0), window.cbTimes.length);
          drawA.push(draw); layoutA.push(layout); total.push(performance.now() - t0); sync.push(t1 - t0); main.push(t1 - t0 + draw + layout);
          await new Promise(r => setTimeout(r, 0));
        }
        out[name] = {sync, total, main, draw: drawA, layout: layoutA};
      }
      const hit = () => chart.querySelector('[data-chart-hit]');
      const mv = x => hit().dispatchEvent(new PointerEvent('pointermove', {clientX: box.left + x, clientY: box.top + 150, pointerId: 1, bubbles: true}));
      if (!window.skipHover) await measure('hover', 120, i => mv(120 + (i * 7) % 900));
      const wheel = (dy, ctrl = true, x = 600) => chart.dispatchEvent(new WheelEvent('wheel', {deltaY: dy, ctrlKey: ctrl, clientX: box.left + x, clientY: box.top + 150, bubbles: true, cancelable: true}));
      await measure('zoom-out (wheel)', 40, i => wheel(120));
      out.__nodesWidest = {nodes: document.querySelectorAll('#ua-chart *').length, byTag: Object.fromEntries([...document.querySelectorAll('#ua-chart *')].reduce((m, n) => m.set(n.tagName + (n.dataset.event != null ? '[event]' : n.dataset.cycleEnd != null ? '[cycleEnd]' : n.dataset.series != null ? '[series]' : ''), (m.get(n.tagName + (n.dataset.event != null ? '[event]' : n.dataset.cycleEnd != null ? '[cycleEnd]' : n.dataset.series != null ? '[series]' : '')) || 0) + 1), new Map()))};
      await measure('zoom-in (wheel)', 20, i => wheel(-120));
      await measure('pan (shift wheel)', 40, i => wheel(i % 2 ? 80 : -80, false));
      out.__calls = window.calls; return out;
    });
    if (cdp) {
      const prof = (await cdp.send('Profiler.stop')).profile, self = new Map(), byId = new Map(prof.nodes.map(n => [n.id, n]));
      prof.samples.forEach((id, i) => {const f = byId.get(id).callFrame, k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + prof.timeDeltas[i] / 1000);});
      console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => v.toFixed(0) + 'ms ' + k).join('\n'));
    }
    const summary = Object.fromEntries(Object.entries(result).filter(([k]) => !k.startsWith("__")).map(([k, v]) => [k, {main: stats(v.main), draw: stats(v.draw), layout: stats(v.layout), sync: stats(v.sync), toFrame: stats(v.total)}]));
    console.log(JSON.stringify({records: total, first, errors, maxDrawCallsPerEvent: result.__calls, widest: result.__nodesWidest, summary}, null, 1));
  } finally {await browser.close();}
})().catch(e => {console.error(e); process.exitCode = 1;});
