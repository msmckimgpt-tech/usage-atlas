const test = require('node:test');
const assert = require('node:assert/strict');
const {intervalSeconds, wakeDelay, retime} = require('../src/schedule.cjs');
test('minimum one-second interval is enforced by runtime, with existing default preserved', () => {
  assert.equal(intervalSeconds(1), 1); assert.equal(intervalSeconds(0), 1); assert.equal(intervalSeconds(300), 300); assert.equal(intervalSeconds(undefined), 300); assert.equal(intervalSeconds(Infinity), 300);
});
test('scheduler wakes at provider due times rather than a fixed minute, and rests when disabled', () => {
  assert.equal(wakeDelay({codex: {next: 2000}, claude: {next: 3000}}, 1000), 1000);
  assert.equal(wakeDelay({codex: {next: 1000000}, claude: {next: 2000000}}, 1000), 60000);
  assert.equal(wakeDelay({}, 1000), 25); assert.equal(wakeDelay({}, 1000, false), 60000);
});
test('interval changes retime successful providers while preserving errors and server retry delays', () => {
  const collectors = {codex: {last: 1000, next: 301000, errors: 0, message: '정상'}, claude: {last: 1000, next: 7200000, errors: 1, message: 'Claude 조회 제한'}};
  assert.equal(retime(collectors, 1), true); assert.equal(collectors.codex.next, 2000); assert.equal(collectors.claude.next, 7200000); assert.equal(retime(collectors, 1), false);
  retime(collectors, 300); assert.equal(collectors.codex.next, 301000);
});
