'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const forecast = require('../media/forecast.js');

const minute = 60000, hour = 60 * minute, day = 24 * hour;
const start = Date.UTC(2026, 10, 17, 0, 0), reset = start + 7 * day;
// 주간 주기 안의 스냅샷: 시각이 늦을수록 예측 기울기가 커진다.
const snap = (hours, from, to, resetAt = reset) => ({at: start + hours * hour, reset: resetAt, mult: 5, points: [[start + hours * hour, from], [resetAt, to]]});
const A = snap(6, 10, 40), B = snap(12, 20, 80), C = snap(18, 30, 100);
const now = start + 3 * day, opts = {now, window: 'week'};
const valueAt = (line, time) => {
  const pts = [...line.past, ...line.future.slice(1)];
  for (let i = 1; i < pts.length; i++) if (time <= pts[i].time) return pts[i - 1].value + (pts[i].value - pts[i - 1].value) * (time - pts[i - 1].time) / (pts[i].time - pts[i - 1].time);
  return pts.at(-1).value;
};

test('cubicBezier maps 0 to 0 and 1 to 1 and never decreases', () => {
  for (const ease of Object.values(forecast.easings)) {
    assert.equal(ease(0), 0); assert.equal(ease(1), 1);
    let last = 0;
    for (let x = 0; x <= 1; x += .05) {const y = ease(x); assert.ok(y >= last - 1e-9); last = y;}
  }
  assert.ok(Math.abs(forecast.easings.smooth(.5) - .5) < 1e-6, 'ease-in-out is symmetric');
});

test('asOf at a stored snapshot time returns that snapshot unchanged', () => {
  const [line] = forecast.asOf([A, B, C], A.at, opts);
  assert.equal(line.at, A.at); assert.equal(line.blended, false);
  assert.equal(line.past[0].value, 10); assert.equal(line.past[0].time, A.at);
  assert.ok(Math.abs(valueAt(line, reset) - 40) < 1e-9, 'ends at the stored value');
});

test('asOf between two snapshots blends them with the bezier weight', () => {
  const mid = (A.at + B.at) / 2, [line] = forecast.asOf([A, B, C], mid, opts);
  assert.equal(line.blended, true);
  // ease-in-out 의 중간 가중치는 0.5 이므로 시작값은 두 예측의 평균이다.
  const a = 10 + (40 - 10) * (mid - A.at) / (reset - A.at), expected = (a + 20) / 2;
  assert.ok(Math.abs(line.past[0].value - expected) < 1e-6, 'start value is the average of A(S) and B(S)');
  assert.ok(Math.abs(valueAt(line, reset) - 60) < 1e-6, 'end value is the average of 40 and 80');
  const linear = forecast.asOf([A, B, C], A.at + (B.at - A.at) * .25, {...opts, ease: forecast.easings.linear})[0];
  assert.ok(Math.abs(valueAt(linear, reset) - (.75 * 40 + .25 * 80)) < 1e-6, 'linear easing weights by position');
});

test('asOf values are continuous while the reference time moves', () => {
  let last = null;
  for (let t = A.at; t <= C.at; t += 10 * minute) {
    const [line] = forecast.asOf([A, B, C], t, opts), end = valueAt(line, reset);
    if (last !== null) assert.ok(Math.abs(end - last) < 6, 'the end value never jumps between steps');
    last = end;
  }
});

test('asOf does not blend across a cycle boundary', () => {
  const nextReset = reset + 7 * day, previous = snap(150, 70, 100), fresh = {at: reset + 6 * hour, reset: nextReset, mult: 5, points: [[reset + 6 * hour, 5], [nextReset, 50]]};
  const at = previous.at + 4 * hour, result = forecast.asOf([previous, fresh], at, {now: reset + 7 * hour, window: 'week'});
  assert.equal(result.length, 1); assert.equal(result[0].blended, false);
  assert.ok(result[0].past.concat(result[0].future).every(p => p.time <= reset), 'the old cycle line ends at its reset');
  assert.deepEqual(forecast.asOf([previous, fresh], reset + 2 * hour, {now: reset + 7 * hour, window: 'week'}), [], 'no snapshot in the new cycle yet');
});

test('asOf returns nothing before the first snapshot, after its reset or in the future', () => {
  assert.deepEqual(forecast.asOf([A, B], A.at - minute, opts), []);
  assert.deepEqual(forecast.asOf([A, B], reset + hour, {now: reset + 2 * hour, window: 'week'}), []);
  assert.deepEqual(forecast.asOf([A, B], now + hour, opts), []);
  assert.deepEqual(forecast.asOf([], A.at, opts), []);
  assert.deepEqual(forecast.asOf([A], A.at, {now, window: 'bogus'}), []);
});

test('asOf splits the line at the current time and honours the visible domain', () => {
  const [line] = forecast.asOf([A, B], A.at, opts);
  assert.equal(line.past.at(-1).time, now); assert.equal(line.future[0].time, now);
  assert.deepEqual(forecast.asOf([A, B], A.at, {...opts, domain: [reset + day, reset + 2 * day]}), []);
});

test('asOf keeps values non-decreasing and capped at 100', () => {
  const [line] = forecast.asOf([B, C], (B.at + C.at) / 2, opts);
  const all = [...line.past, ...line.future];
  for (let i = 1; i < all.length; i++) assert.ok(all[i].value >= all[i - 1].value - 1e-9);
  assert.ok(all.every(p => p.value <= 100));
});

test('asOfRange covers the last seven days up to the latest snapshot', () => {
  const old = snap(-300, 5, 20), recent = snap(60, 15, 50);
  const range = forecast.asOfRange([[old, A], [recent]], now);
  assert.equal(range.hi, recent.at); assert.equal(range.lo, now - 7 * day);
  assert.equal(forecast.asOfRange([[], []], now), null);
  assert.equal(forecast.asOfRange([[A]], now).lo, A.at, 'short history starts at the oldest snapshot');
});
