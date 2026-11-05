'use strict';
// 2026-11 전수 검토에서 확인한 결함의 회귀 검사.
const test = require('node:test');
const assert = require('node:assert/strict');
const {project, hash} = require('../src/core.cjs');
const {buildConversion, converter, callConverter} = require('../src/credit-conversion.cjs');
const {priceCall} = require('../src/pricing.cjs');
const {messages} = require('../src/conversations.cjs');
const creditGraphs = require('../media/credit-series.js');

const minute = 60000, base = Date.UTC(2026, 9, 1, 0, 0), account = hash('review-fixes');
const call = (id, i) => ({id, provider: 'codex', account, homeKey: 'f', sessionId: id, time: base + i * minute - 1000, startedAt: base + (i - 1) * minute + 1000, completedAt: base + i * minute - 1000, completionState: 'completed', model: 'gpt-6.1-sol', mode: 'Standard', input: 1000000, cached: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0});

test('five-hour credit estimate restarts at its own early reset instead of accumulating over the weekly cycle', () => {
  const record = (i, five, week, balance, fiveReset = base + 18000000) => ({v: 1, provider: 'codex', account, plan: 'pro', time: base + i * minute, creditBalance: balance, windows: {five: {used: five, reset: fiveReset}, week: {used: week, reset: base + 604800000}}});
  const records = [record(0, 0, 0, 1000), record(1, 10, 2, 1000), record(2, 10, 2, 900), record(3, 0, 2, 900, base + 30000000), record(4, 0, 2, 800, base + 30000000)];
  const capacities = ['five', 'week'].map(window => ({provider: 'codex', account, plan: 'pro', time: base, window, mult: 1}));
  const model = buildConversion({records, capacities, calls: [call('a', 1), call('p', 2), call('q', 4)], now: base + 5 * minute});
  const data = project(records, capacities, undefined, converter(model));
  const five = data.codex.windows.five, week = data.codex.windows.week;
  assert.equal(five[3].event?.kind, 'early-reset');
  assert.equal(five[3].creditEstimate.usage, 0);
  assert.equal(five.at(-1).creditEstimate.usage, five[2].creditEstimate.usage); // 초기화 전과 후의 차감량이 같다(각 100 크레딧).
  assert.ok(week.at(-1).creditEstimate.usage > week[2].creditEstimate.usage);
  // 원단위 금액도 5시간 초기화 이후의 증가분만 표시한다.
  const [series] = creditGraphs.series(data.codex, 'codex', {mode: 'usage'});
  assert.equal(series.creditWindow, 'five');
  assert.equal(series.points[3].amount, 0);
  assert.equal(series.points.at(-1).amount, 100);
});

test('call conversion picks the same multiplier as the series when two capacities share a timestamp', () => {
  const record = (i, five, balance) => ({v: 1, provider: 'codex', account, plan: 'pro', time: base + i * minute, creditBalance: balance, windows: {five: {used: five, reset: base + 18000000}, week: null}});
  const records = [record(0, 0, 1000), record(1, 10, 1000)];
  const capacities = [{provider: 'codex', account, plan: 'pro', time: base, window: 'five', mult: 5}, {provider: 'codex', account, plan: 'pro', time: base, window: 'five', mult: 20}];
  const model = buildConversion({records, capacities, calls: [call('a', 1)], now: base + 2 * minute});
  assert.equal(project(records, capacities).codex.windows.five.at(-1).mult, 5);
  const result = callConverter(model, records, capacities, 'five')(priceCall(call('a', 1)));
  assert.equal(result.quotaConversionIssue, null);
  assert.ok(Number.isFinite(result.quotaPercent));
});

test('Codex conversation view hides injected environment and instruction context', () => {
  const event = (role, text) => ({type: 'response_item', timestamp: base, payload: {type: 'message', role, id: role + text.length, content: [{type: 'input_text', text}]}});
  assert.deepEqual(messages(event('user', '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>'), 'codex'), []);
  assert.deepEqual(messages(event('user', '# AGENTS.md instructions for /x\n...'), 'codex'), []);
  assert.equal(messages(event('user', '차트를 고쳐 주세요'), 'codex')[0].text, '차트를 고쳐 주세요');
  assert.equal(messages(event('assistant', '<environment_context>'), 'codex').length, 1);
});
