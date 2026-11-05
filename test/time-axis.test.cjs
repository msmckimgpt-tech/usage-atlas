const {test} = require('node:test');
const assert = require('node:assert/strict');
const {layout} = require('../media/time-axis.js');
const hour = 3600000;
const at = (month, day, h = 0, minute = 0, year = 2026) => +new Date(year, month - 1, day, h, minute);
const axis = (start, end, width = 1200) => layout([start, end], width);
function valid(result, width = 1200) {
  for (const labels of [result.dates, result.hours]) {
    labels.forEach((label, i) => {
      assert.ok(label.left >= 0 && label.right <= width);
      const previous = labels.slice(0, i).filter(other => other.row === label.row).at(-1);
      if (previous) assert.ok(label.left >= previous.right + 8);
    });
  }
  const keys = result.dates.flatMap(label => label.keys);
  assert.equal(new Set(keys).size, keys.length, 'a date appears only once');
  for (const label of result.dates) assert.match(label.text, /[일월화수목금토]\)/);
  for (const label of result.hours) assert.match(label.text, /^\d{2}시$/);
}
test('intraday zoom separates one date from 24-hour hourly labels', () => {
  const result = axis(at(10, 20, 8), at(10, 20, 18));
  valid(result);
  assert.deepEqual(result.dates.map(x => x.text), ['20일(화)']);
  assert.equal(result.hours.length, 11);
  assert.equal(result.hours[0].text, '08시');
  assert.equal(result.hours.at(-1).text, '18시');
});
test('three-day screenshot range never repeats a day at intraday ticks', () => {
  const result = axis(at(10, 17, 20), at(10, 20, 12));
  valid(result);
  assert.equal(result.dates.length, 4);
  assert.equal(result.hours.length > 4, true);
  assert.equal(result.dayTicks.length, 3);
  assert.equal(result.hourTicks.length, 62);
});
test('sub-hour zoom retains the hour and weekday without minute ticks', () => {
  const result = axis(at(10, 20, 9, 12), at(10, 20, 9, 13));
  valid(result);
  assert.deepEqual(result.hours.map(x => x.text), ['09시']);
  assert.equal(result.dayTicks.length, 0);
  assert.equal(result.hourTicks.length, 0);
});
test('midnight has a large tick instead of a duplicate small tick', () => {
  const result = axis(at(10, 19, 22), at(10, 20, 2));
  valid(result);
  assert.deepEqual(result.dayTicks, [600]);
  assert.ok(!result.hourTicks.includes(600));
  assert.deepEqual(result.hours.map(x => x.text), ['22시', '23시', '00시', '01시', '02시']);
  assert.deepEqual(result.dates.map(x => x.text), ['19일(월)', '20일(화)']);
});
test('month context exists only on the adjacent days around its change', () => {
  const result = axis(at(10, 29), at(11, 4));
  valid(result);
  const month = result.dates.filter(x => /월 /.test(x.text));
  assert.equal(month.flatMap(x => x.keys).length, 2);
  assert.ok(month.some(x => x.text.includes('10월 31일(토)')));
  assert.ok(month.some(x => x.text.includes('11월 1일(일)')));
});
test('year boundary preserves both year contexts when space allows', () => {
  const result = axis(at(12, 31, 12), at(1, 1, 12, 0, 2027));
  valid(result);
  assert.match(result.dates.map(x => x.text).join(' '), /2026년 12월 31일/);
  assert.match(result.dates.map(x => x.text).join(' '), /2027년 1월 1일/);
});
test('narrow month boundary keeps separate labels at their own midnight', () => {
  const result = axis(at(10, 30), at(11, 3), 220);
  valid(result, 220);
  const boundary = result.dates.filter(label => label.priority >= 3);
  assert.equal(boundary.length, 2);
  assert.deepEqual(boundary.map(label => label.keys[0]), ['2026-10-31', '2026-11-1']);
  assert.deepEqual(boundary.map(label => label.x), [55, 110]);
  assert.ok(boundary.every(label => !label.text.includes('→')));
});
test('date, month, year and hour label anchors are never moved away from their actual boundary', () => {
  for (const width of [186, 320, 900, 1800]) for (const domain of [
    [at(10, 17, 20), at(10, 20, 12)]
    , [at(10, 29), at(11, 4)]
    , [at(12, 31, 12), at(1, 1, 12, 0, 2027)]
    , [at(10, 20, 9, 12), at(10, 20, 9, 13)]
  ]) {
    const result = layout(domain, width); valid(result, width);
    for (const label of [...result.dates, ...result.hours]) {
      const expected = label.context ? 0 : (label.time - domain[0]) / (domain[1] - domain[0]) * width;
      assert.equal(label.x, expected);
      if (label.context) {assert.ok(label.time < domain[0]); assert.equal(label.anchor, 'start');}
    }
  }
});
test('overview density stays bounded and labels do not overlap', () => {
  for (const width of [186, 320, 900, 1800]) {
    const result = axis(at(1, 1), at(12, 31), width);
    valid(result, width);
    assert.equal(result.hours.length, 0);
    assert.equal(result.hourTicks.length, 0);
    assert.ok(result.dayTicks.length <= width / 2 + 1);
  }
});
test('two-week default supplies small hourly and large daily ticks', () => {
  const result = axis(at(10, 13), at(10, 27));
  valid(result);
  assert.equal(result.hours.length, 0);
  assert.equal(result.dayTicks.length, 15);
  assert.equal(result.hourTicks.length, 14 * 23);
});
test('subpixel edge slivers do not introduce an unrelated day label', () => {
  const result = axis(at(10, 29) - 1, at(11, 4) - 1);
  valid(result);
  assert.ok(!result.dates.some(label => label.keys.includes('2026-10-28')));
});
test('a real midnight near the left edge takes priority over clipped previous-day context', () => {
  const start = at(10, 19, 23, 59), end = at(10, 20, 4, 59);
  const result = axis(start, end, 316); valid(result, 316);
  const day = result.dates.find(label => label.keys.includes('2026-10-20'));
  assert.ok(day); assert.equal(day.context, false);
  assert.equal(day.time, at(10, 20));
  assert.ok(Math.abs(day.x - 316 / 300) < 1e-9);
});
test('a range ending exactly at midnight includes the new date at its right boundary', () => {
  const result = axis(at(10, 31, 19), at(11, 1), 316); valid(result, 316);
  const day = result.dates.find(label => label.keys.includes('2026-11-1'));
  assert.ok(day); assert.equal(day.time, at(11, 1)); assert.equal(day.x, 316);
  assert.equal(day.anchor, 'end'); assert.match(day.text, /11월 1일/);
});
test('DST calendar days and true hours stay aligned', () => {
  const {execFileSync} = require('node:child_process');
  const code = `const {layout}=require('./media/time-axis.js'); const start=+new Date(2026,2,8),end=+new Date(2026,2,9); console.log(JSON.stringify({span:end-start,axis:layout([start,end],1200)}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', code], {cwd: require('node:path').resolve(__dirname, '..'), env: {...process.env, TZ: 'America/New_York'}, windowsHide: true, encoding: 'utf8'}));
  assert.equal(result.span, 23 * hour);
  assert.equal(result.axis.hourTicks.length, 22);
  assert.deepEqual(result.axis.dayTicks, [0, 1200]);
  assert.ok(!result.axis.hours.some(x => x.text === '02시'));
});
