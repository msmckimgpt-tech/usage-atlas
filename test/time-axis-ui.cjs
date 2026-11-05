const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'media', file), 'utf8');
const at = (month, day, hour = 0, year = 2026) => +new Date(year, month - 1, day, hour);
const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${read('style.css')}</style></head><body>${read('body.html')}<script>window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}})</script>${['d3.min.js', 'gaps.js', 'time-axis.js', 'amount-format.js', 'credit-series.js', 'chart-series.js', 'forecast.js', 'provider-focus.js', 'app.js'].map(file => `<script>${read(file)}</script>`).join('')}</body></html>`;
(async () => {
  const browser = await chromium.launch(browserOptions);
  const report = {status: 'RUNNING', cases: [], errors: []};
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    page.on('pageerror', error => report.errors.push(error.message));
    await page.setContent(doc);
    const check = async (name, start, end, width = 1440) => {
      await page.setViewportSize({width, height: 900});
      const now = (start + end) / 2;
      await page.evaluate(now => {
        window.dispatchEvent(new MessageEvent('message', {data: {type: 'data', now, colorMode: 'dark', data: {}}}));
        window.dispatchEvent(new MessageEvent('message', {data: {type: 'resetView'}}));
      }, now);
      await page.waitForTimeout(40);
      const frame = await page.locator('[data-chart-hit]').boundingBox();
      const span = 14 * 86400000, px = time => frame.x + (time - now + span / 2) / span * frame.width;
      await page.mouse.move(px(start), frame.y + 50);
      await page.mouse.down(); await page.mouse.move(px(end), frame.y + 50); await page.mouse.up();
      await page.waitForTimeout(40);
      const result = await page.locator('#ua-chart').evaluate(node => {
        const plot = node.querySelector('[data-chart-frame]'), frame = plot.getBoundingClientRect();
        const start = +node.dataset.domainStart, span = +node.dataset.domainEnd - start;
        const labels = selector => [...node.querySelectorAll(selector)].map(n => {
          const rect = n.getBoundingClientRect(), context = n.dataset.axisContext === 'true';
          const expected = +plot.getAttribute('x') + (context ? 0 : (+n.dataset.axisTime - start) / span * +plot.getAttribute('width'));
          return {text: n.textContent, keys: n.dataset.dateKeys?.split(','), x: rect.x, right: rect.right, y: rect.y, anchorError: Math.abs(+n.getAttribute('x') - expected)};
        });
        return {dates: labels('[data-date-tick]'), hours: labels('[data-hour-label]'), frame: {x: frame.x, right: frame.right}, dayTicks: +node.querySelector('[data-day-ticks]').dataset.dayTicks, hourTicks: +node.querySelector('[data-hour-ticks]').dataset.hourTicks};
      });
      for (const labels of [result.dates, result.hours]) for (const [i, label] of labels.entries()) {
        assert.ok(label.x >= result.frame.x - 1 && label.right <= result.frame.right + 1, `${name} label inside plot`);
        const previous = labels.slice(0, i).filter(other => other.y === label.y).at(-1);
        if (previous) assert.ok(label.x >= previous.right + 7, `${name} labels cannot overlap`);
        assert.ok(label.anchorError < .001, `${name} anchor at actual time boundary`);
      }
      const keys = result.dates.flatMap(item => item.keys);
      assert.equal(new Set(keys).size, keys.length);
      assert.ok(result.dates.length > 0);
      for (const label of result.dates) assert.match(label.text, /[일월화수목금토]\)/);
      for (const label of result.hours) assert.match(label.text, /^\d{2}시$/);
      if (result.hours.length) assert.ok(result.dates.every(date => date.y > result.hours[0].y));
      report.cases.push({name, width, dates: result.dates.map(x => x.text), hours: result.hours.map(x => x.text), dayTicks: result.dayTicks, hourTicks: result.hourTicks});
      await page.screenshot({path: path.join(root, 'screenshots', `time-axis-${name}.png`)});
      return result;
    };
    const multi = await check('three-days', at(10, 17, 20), at(10, 20, 12));
    assert.equal(multi.dates.length, 4); assert.ok(multi.hours.length > 4);
    const single = await check('single-day', at(10, 20, 6), at(10, 20, 18));
    assert.deepEqual(single.dates.map(x => x.text), ['20일(화)']);
    assert.ok(single.hours.some(x => x.text === '12시'));
    const midnight = await check('midnight', at(10, 19, 22), at(10, 20, 2));
    assert.equal(midnight.dayTicks, 1); assert.ok(midnight.hours.some(x => x.text === '00시'));
    const month = await check('month', at(10, 29), at(11, 4));
    assert.match(month.dates.map(x => x.text).join(' '), /10월 31일/);
    assert.match(month.dates.map(x => x.text).join(' '), /11월 1일/);
    await check('month-narrow', at(10, 30), at(11, 3), 320);
    const year = await check('year', at(12, 31, 12), at(1, 1, 12, 2027));
    assert.match(year.dates.map(x => x.text).join(' '), /2026년/);
    assert.match(year.dates.map(x => x.text).join(' '), /2027년/);
    await check('year-narrow', at(12, 31, 4), at(1, 1, 20, 2027), 360);
    // 1분 최소 범위는 작은 드래그보다 키보드 확대를 통해 검증한다.
    await check('fine', at(10, 20, 6), at(10, 20, 18));
    await page.locator('[data-chart-hit]').focus();
    for (let i = 0; i < 14; i++) {await page.keyboard.press('+'); await page.waitForTimeout(20);}
    const fine = await page.locator('[data-hour-label]').allTextContents();
    assert.ok(fine.length > 0); fine.forEach(text => assert.match(text, /^\d{2}시$/));
    assert.equal(await page.locator('[data-date-tick]').count(), 1);
    await page.screenshot({path: path.join(root, 'screenshots', 'time-axis-fine.png')});
    assert.deepEqual(report.errors, []);
    report.status = 'PASS';
  } catch (error) {report.status = 'FAIL'; report.error = error.message; throw error;}
  finally {await browser.close(); fs.writeFileSync(path.join(root, 'test-time-axis-ui.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));}
})().catch(error => {console.error(error); process.exitCode = 1;});
