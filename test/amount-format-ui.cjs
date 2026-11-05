const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project, hash} = require('../src/core.cjs');
const dir = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(dir, 'media', file), 'utf8');
const now = +new Date(2026, 9, 21, 12);
const records = ['codex', 'claude'].flatMap(provider => [0, 1, 2].map(i => ({
    v: 1, provider, account: hash(provider), plan: 'test', time: now - (2 - i) * 1200000
  , windows: {five: {used: 30 + i * 5, reset: now + 3600000}, week: {used: 20 + i * 5, reset: now + 7 * 86400000}}
  , ...(provider === 'codex' ? {creditBalance: [1000.987654321, 990.123456789, 980.061728394][i]} : {spentUsd: [.123456789, .234567891, .345678912][i], spendPeriod: '2026-10'})
}))).sort((a, b) => a.time - b.time);
const data = project(records);
for (const provider of Object.values(data)) for (const points of Object.values(provider.windows)) for (const p of points) p.creditEstimate = {nativeUsage: p.credit.usage, nativeUsageContinuous: p.credit.usageContinuous};
const model = {type: 'data', now, data, colorMode: 'dark'};
const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${read('style.css')}</style></head><body>${read('body.html')}<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}});</script>${['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-focus.js', 'app.js'].map(file => `<script>${read(file)}</script>`).join('')}</body></html>`;
(async () => {
  const browser = await chromium.launch(browserOptions);
  const report = {status: 'RUNNING', cases: [], errors: []};
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    page.on('pageerror', error => report.errors.push(error.message));
    await page.setContent(doc);
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const update = async values => {await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), {...model, ...values}); await frame();};
    await update({}); await page.locator('#ua-credit').check(); await frame();
    await page.locator('#ua-nav-pan').focus();
    for (let i = 0; i < 6; i++) {await page.keyboard.press('+'); await frame();}
    const traces = () => page.locator('[data-series]').evaluateAll(nodes => nodes.map(node => [node.dataset.series, node.getAttribute('d')]));
    const before = await traces();
    assert.match(await page.locator('#ua-codex-credit').textContent(), /20\.9259 크레딧 · 잔액 980\.0617/);
    assert.equal(await page.locator('#ua-claude-credit').textContent(), '관측 지출 $0.2222');
    await update({codexCreditDecimals: 2, claudeUsdDecimals: 6});
    assert.match(await page.locator('#ua-codex-credit').textContent(), /20\.93 크레딧 · 잔액 980\.06/);
    assert.equal(await page.locator('#ua-claude-credit').textContent(), '관측 지출 $0.222222');
    assert.deepEqual(await traces(), before, 'precision cannot change rendered curve geometry');
    for (const [unit, expected] of [['credits', '20.93'], ['USD', '0.222222']]) {
      const values = await page.locator(`[data-credit-minmax="${unit}"]`).allTextContents();
      assert.ok(values.includes(expected));
    }
    const hover = async (provider, expected) => {
      const point = await page.locator(`[data-series="${provider}-credit"]`).evaluate(node => {
        const p = node.getPointAtLength(node.getTotalLength() * .95), m = node.getScreenCTM();
        return {x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f};
      });
      await page.mouse.move(point.x, point.y); await frame();
      assert.match(await page.locator('#ua-tooltip').textContent(), expected);
    };
    await page.locator('#ua-codex').click(); await frame(); await hover('codex', /Codex \/ 주간 환산 \/ ≈[\d,.]+% · 20\.93 크레딧/);
    await page.locator('#ua-codex').click(); await page.locator('#ua-claude').click(); await frame(); await hover('claude', /Claude Code \/ 주간 환산 \/ ≈[\d,.]+% · 0\.222222 USD/);
    await page.locator('#ua-claude').click(); await page.mouse.move(0, 0); await frame();
    await update({codexCreditDecimals: 0, claudeUsdDecimals: 0});
    assert.match(await page.locator('#ua-codex-credit').textContent(), /21 크레딧 · 잔액 980/);
    assert.equal(await page.locator('#ua-claude-credit').textContent(), '관측 지출 $0');
    for (const width of [320, 360, 700, 1440]) {
      await page.setViewportSize({width, height: 900}); await update({codexCreditDecimals: 8, claudeUsdDecimals: 8});
      for (const basis of ['current', 'base']) {
        await page.locator('#ua-basis').selectOption(basis); await frame();
        const boxes = await page.locator('[data-credit-minmax]').evaluateAll(nodes => nodes.map(node => {
          const r = node.getBoundingClientRect(), svg = node.closest('svg').getBoundingClientRect();
          return {text: node.textContent, unit: node.dataset.creditMinmax, y: r.y, left: r.left, right: r.right, svgLeft: svg.left, svgRight: svg.right};
        }));
        for (const box of boxes) assert.ok(box.left >= box.svgLeft - 1 && box.right <= box.svgRight + 1, 'full precision axis remains inside chart');
        for (const a of boxes) for (const b of boxes) if (a.unit !== b.unit && Math.abs(a.y - b.y) < 1) assert.ok(a.right + 7 <= b.left || b.right + 7 <= a.left, 'credit and USD range labels cannot overlap');
        report.cases.push({width, basis});
      }
      assert.match(await page.locator('#ua-codex-credit').textContent(), /20\.92592593/);
      assert.equal(await page.locator('#ua-claude-credit').textContent(), '관측 지출 $0.22222212');
      if (width === 320) await page.screenshot({path: path.join(dir, 'screenshots', 'amount-precision-narrow.png')});
    }
    await page.screenshot({path: path.join(dir, 'screenshots', 'amount-precision.png')});
    await update({codexCreditDecimals: 12, claudeUsdDecimals: '6'});
    assert.match(await page.locator('#ua-codex-credit').textContent(), /20\.9259/); assert.equal(await page.locator('#ua-claude-credit').textContent(), '관측 지출 $0.2222');
    assert.deepEqual(report.errors, []); report.status = 'PASS';
  } catch (error) {report.status = 'FAIL'; report.error = error.message; throw error;}
  finally {await browser.close(); fs.writeFileSync(path.join(dir, 'test-amount-format-ui.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));}
})().catch(error => {console.error(error); process.exitCode = 1;});
