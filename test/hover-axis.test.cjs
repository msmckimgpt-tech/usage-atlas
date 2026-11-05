const test = require('node:test');
const assert = require('node:assert/strict');
const {preview} = require('../src/hover.cjs');
const texts = (svg, kind) => [...svg.matchAll(new RegExp(`<text([^>]*data-${kind}[^>]*)>([^<]*)</text>`, 'g'))].map(match => ({
  text: match[2], time: +match[1].match(/data-axis-time="([^"]+)"/)[1]
  , x: +match[1].match(/\bx="([^"]+)"/)[1]
  , context: match[1].includes('data-axis-context="true"')
}));
test('mini axis uses whole 24-hour labels, weekdays, and exact hourly positions instead of three arbitrary minute labels', () => {
  const now = +new Date(2026, 9, 20, 12, 37), p = preview([], {now});
  const hours = texts(p.svg, 'hour-label');
  assert.deepEqual(hours.map(label => label.text), ['08시', '09시', '10시', '11시', '12시']);
  for (const label of hours) assert.equal(label.x, 34 + (label.time - p.start) / (p.end - p.start) * 316);
  assert.deepEqual(texts(p.svg, 'date-tick').map(label => label.text), ['20일(화)']);
  assert.match(p.svg, /data-day-ticks="0"/); assert.match(p.svg, /data-hour-ticks="5"/);
  assert.doesNotMatch(p.svg, />\d{2}:\d{2}</);
  assert.match(p.svg, /width="360" height="192"/);
});
test('midnight gets one large tick, no duplicate small tick, and two dates aligned with the true boundary', () => {
  const now = +new Date(2026, 9, 20, 0, 30), p = preview([], {now});
  assert.match(p.svg, /data-day-ticks="1"[^>]*v8/);
  assert.match(p.svg, /data-hour-ticks="4"[^>]*v4/);
  const dates = texts(p.svg, 'date-tick');
  assert.deepEqual(dates.map(label => label.text), ['19일(월)', '20일(화)']);
  assert.equal(dates[0].context, true); assert.equal(dates[0].x, 34);
  assert.equal(dates[1].time, +new Date(2026, 9, 20));
  assert.equal(dates[1].x, 34 + 4.5 / 5 * 316);
});
test('month and year boundaries preserve both contexts at their separate real date anchors', () => {
  for (const now of [+new Date(2026, 10, 1, 4, 59), +new Date(2027, 0, 1, 4, 59)]) {
    const p = preview([], {now}), dates = texts(p.svg, 'date-tick');
    assert.equal(dates.length, 2);
    for (const label of dates) assert.equal(label.x, label.context ? 34 : 34 + (label.time - p.start) / (p.end - p.start) * 316);
    assert.ok(dates.every(label => /[월화수목금토일]\)/.test(label.text)));
    if (new Date(now).getFullYear() === 2027) assert.ok(dates.every(label => /202[67]년/.test(label.text)));
    else {assert.match(dates[0].text, /10월 31일/); assert.match(dates[1].text, /11월 1일/);}
  }
});
