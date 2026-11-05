'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {adaptiveInterval, advanceOnWake, intervalSeconds, wakeDelay, retime} = require('../src/schedule.cjs');
test('active activity preserves configured 60 seconds and the user one-second minimum', () => {
  assert.equal(adaptiveInterval(60, {active: true}, 100000), 60);
  assert.equal(adaptiveInterval(1, {active: true}, 100000), 1);
  assert.equal(intervalSeconds(1), 1);
});
test('idle activity scales from user base, supports host multiplier and a recent-activity window', () => {
  assert.equal(adaptiveInterval(60, {active: false}, 100000), 240);
  assert.equal(adaptiveInterval(300, {active: false}, 100000), 1200);
  assert.equal(adaptiveInterval(1, {active: false}, 100000), 60);
  assert.equal(adaptiveInterval(60, {active: false}, 100000, 2), 120);
  assert.equal(adaptiveInterval(60, {active: false, idleMultiplier: 3}, 100000), 180);
  assert.equal(adaptiveInterval(60, {active: false, lastActivity: 99000}, 100000), 60);
  assert.equal(adaptiveInterval(60, {active: false, lastActivity: 0}, 100000), 240);
  assert.equal(adaptiveInterval(60, {active: false}, 100000, 0), 60);
});
test('activity wake advances only successful collectors and preserves the five-second source floor', () => {
  const collectors = {
    codex: {last: 98000, next: 338000, errors: 0}
  , claude: {last: 1000, next: 999999, errors: 1}
  };
  assert.equal(advanceOnWake(collectors, 100000), true);
  assert.equal(collectors.codex.next, 103000);
  assert.equal(collectors.claude.next, 999999);
  assert.equal(advanceOnWake(collectors, 100000), false);
  collectors.codex.last = 1;
  assert.equal(advanceOnWake(collectors, 100000), true);
  assert.equal(collectors.codex.next, 100000);
  assert.equal(wakeDelay(collectors, 100000), 25);
});
test('backoff timestamps and earlier reset wakeups survive activity maintenance', () => {
  const collectors = {
    codex: {last: 1000, next: 200000, errors: 0, backoffUntil: 200000}
  , claude: {last: 99000, next: 101000, errors: 0}
  };
  assert.equal(advanceOnWake(collectors, 100000), false);
  assert.equal(collectors.codex.next, 200000);
  assert.equal(collectors.claude.next, 101000);
  collectors.codex = {last: 1000, next: 200000, errors: 0, retryAfter: 200000};
  assert.equal(advanceOnWake(collectors, 100000), false);
});
test('existing retime and wake contracts remain unchanged', () => {
  const collectors = {codex: {last: 1000, next: 241000, errors: 0, message: '정상'}};
  assert.equal(retime(collectors, 60), true);
  assert.equal(collectors.codex.next, 61000);
  assert.equal(wakeDelay(collectors, 1000, false), 60000);
});
