'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {project} = require('../src/core.cjs'), billing = require('../src/billing.cjs');
const {buildConversion, converter} = require('../src/credit-conversion.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const input = require('./credit-gap-fixture.cjs').fixture();
  for (const row of input.records) row.plan = row.provider === 'codex' ? 'prolite' : 'team:default_claude_max_5x';
  for (const cap of input.capacities) cap.plan = cap.provider === 'codex' ? 'prolite' : 'team:default_claude_max_5x';
  const convert = converter(buildConversion(input)), bill = billing.enricher();
  const data = project(input.records, input.capacities, undefined, (...args) => {convert(...args); bill(...args);});
  const read = file => fs.readFile(path.join(root, 'media', file), 'utf8');
  const scripts = ['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-focus.js', 'app.js'];
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' + await read('style.css') + '</style></head><body>' + await read('body.html') + '<script>window.savedState=null;window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>null,setState:s=>window.savedState=structuredClone(s),postMessage:m=>window.messages.push(m)});</script>' + (await Promise.all(scripts.map(async name => '<script>' + await read(name) + '</script>'))).join('') + '</body></html>';
  const browser = await chromium.launch(browserOptions);
  const result = {status: 'RUNNING', cases: [], errors: []};
  try {
    const page = await browser.newPage(); page.on('pageerror', error => result.errors.push(error.message)); await page.setContent(html);
    const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const update = async extra => {await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', {data: value})), {type: 'data', data, now: input.now, creditBasis: 'subscription', colorMode: 'dark', ...extra}); await paint();};
    const geometry = () => page.evaluate(() => Object.fromEntries(['ua-mode', 'ua-basis', 'ua-refs', 'ua-credit', 'ua-credit-mode', 'ua-settings', 'ua-chart', 'ua-navigator'].map(id => {const r = document.getElementById(id).getBoundingClientRect(); return [id, [r.x, r.y, r.width, r.height]];})));
    for (const width of [320, 360, 480, 700, 1440, 2400]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({width, height: 900}); await update({colorMode: theme}); await page.locator('#ua-credit').check(); await paint();
      await page.locator('#ua-credit-mode').selectOption('estimate'); await paint(); const before = await geometry();
      await page.locator('#ua-credit-billing').check(); await paint(); assert.deepEqual(await geometry(), before, 'basis switch changes no control or chart rectangle');
      assert.equal(await page.locator('#ua-credit-mode').inputValue(), 'money'); assert.equal(await page.locator('#ua-credit-mode option[value=estimate]').isDisabled(), true);
      assert.ok(await page.locator('[data-billing-axis]').count());
      await page.waitForFunction(time => [...document.querySelectorAll('[data-series="claude-credit"]')].some(node => node.__data__?.at(-1)?.time === time && Math.abs(node.__data__.at(-1).y - 14) < 1e-9), input.now);
      assert.match(await page.locator('#ua-codex-credit').textContent(), /^금액 14%/);
      await page.waitForFunction(time => [...document.querySelectorAll('[data-series="codex-credit"]')].some(node => node.__data__?.at(-1)?.time === time && Math.abs(node.__data__.at(-1).y - 14) < 1e-9), input.now);
      await page.waitForFunction(time => [...document.querySelectorAll('[data-series="codex-week"]')].some(node => node.__data__?.at(-1)?.time === time && node.__data__.at(-1).y === 2), input.now);
      const radio = await page.locator('.ua-credit-basis').evaluate(node => {const r = node.getBoundingClientRect(), labels = [...node.querySelectorAll('label')].map(label => {const b = label.getBoundingClientRect(); return {x:b.x,y:b.y,right:b.right,bottom:b.bottom};}); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,labels};});
      assert.equal(radio.width, 52); assert.equal(radio.height, 34); assert.equal(radio.labels[0].x, radio.labels[1].x); assert.ok(radio.labels[1].y > radio.labels[0].y);
      const overflow = await page.locator('.ua-credit-controls').evaluate(node => {const b = node.getBoundingClientRect(), root = document.getElementById('usage-atlas').getBoundingClientRect(); return b.left < root.left || b.right > root.right || document.documentElement.scrollWidth > innerWidth;}); assert.equal(overflow, false);
      await page.locator('#ua-credit').uncheck(); await paint(); assert.deepEqual(await geometry(), before); assert.equal(await page.locator('[data-billing-axis]').count(), 0);
      await page.locator('#ua-credit').check(); await page.locator('#ua-credit-subscription').check(); await paint(); assert.deepEqual(await geometry(), before); assert.equal(await page.locator('#ua-credit-mode').inputValue(), 'estimate');
      result.cases.push({width, theme, fixedGeometry: true});
    }
    await page.setViewportSize({width: 1440, height: 900}); await update({pageWidth: 480}); await page.locator('#ua-credit-billing').check(); await paint(); const small = await geometry();
    for (const mode of ['usage', 'delta', 'total']) {
      await page.locator('#ua-mode').selectOption(mode); await paint(); assert.deepEqual(await geometry(), small);
      const expected = mode === 'delta' ? 2 : 14;
      for (const id of ['codex', 'claude']) await page.waitForFunction(({id, expected, time}) => [...document.querySelectorAll('[data-series="' + id + '-credit"]')].some(node => node.__data__?.at(-1)?.time === time && Math.abs(node.__data__.at(-1).y - expected) < 1e-9 && node.getTotalLength() > 0), {id, expected, time: input.now});
      if (mode === 'delta') assert.ok(Number(await page.locator('#ua-chart').getAttribute('data-y-billing-max')) < 10);
    }
    await page.locator('#ua-basis').selectOption('base'); await paint(); assert.deepEqual(await geometry(), small);
    await page.setViewportSize({width: 1440, height: 900}); await update({pageWidth: 0}); await page.locator('#ua-credit-billing').check(); await paint();
    await page.screenshot({path: path.join(root, 'screenshots/credit-basis-wide.png')});
    await page.setViewportSize({width: 320, height: 740}); await paint(); await page.screenshot({path: path.join(root, 'screenshots/credit-basis-narrow.png')});
    await page.locator('#ua-credit-subscription').focus(); await page.keyboard.press('ArrowDown'); await paint(); assert.equal(await page.locator('#ua-credit-billing').isChecked(), true);
    assert.ok((await page.evaluate(() => window.messages)).some(message => message.type === 'creditBasis' && message.value === 'billing'));
    assert.deepEqual(result.errors, []); result.status = 'PASS';
  } finally {await browser.close(); await fs.writeFile(path.join(root, 'test-credit-basis-ui.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));}
})().catch(error => {console.error(error); process.exitCode = 1;});
