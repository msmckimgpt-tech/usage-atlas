'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {summaryTable} = require('../src/hover.cjs');
const rows = [
  {name: 'Codex', color: '#62d0d8', used: {five: null, week: 21}, five: '-', week: '21%', resets: {five: '-', week: '6d 12h'}, forecasts: {five: {label: '사용 가능', text: '-'}, week: {label: '사용 가능', text: '≈2d 8h'}}},
  {name: 'AGY <Gemini>', color: '#80c080', used: {five: 33.5, week: 140}, five: '33.5%', week: '140%', resets: {five: '1h 1m', week: '6d 5h'}, forecasts: {}}
];
test('모델별 5시간·주간 칸 뒤에 반투명 막대를 그린다', () => {
  const svg = summaryTable(rows, {forecastEnabled: true});
  assert.equal((svg.match(/data-usage-bar=/g) || []).length, 3);
  assert.match(svg, /opacity="\.32"/);
  assert.match(svg, /5시간/); assert.match(svg, /주간/);
  assert.match(svg, /≈2d 8h/);
  assert.ok(svg.indexOf('data-usage-bar') < svg.indexOf('33.5% (1h 1m)'), '막대는 글자보다 먼저(뒤에) 그려진다');
});
test('100%를 넘는 값은 칸 너비로 제한하고 이름은 이스케이프한다', () => {
  const svg = summaryTable(rows);
  assert.match(svg, /width="128\.0"/);
  assert.match(svg, /AGY &lt;Gemini&gt;/);
});
test('예측을 끄면 한 줄만 표시한다', () => {
  assert.doesNotMatch(summaryTable(rows, {forecastEnabled: false}), /사용 가능/);
});
test('범례 대신 표의 모델 이름 앞에 색 표식을 둔다', () => {
  const svg = summaryTable([{...rows[0], marker: 'circle'}, {...rows[1], marker: 'diamond'}]);
  assert.match(svg, /<circle data-legend-marker="Codex"[^>]*fill="#62d0d8"/);
  assert.match(svg, /<path data-legend-marker="AGY &lt;Gemini&gt;"[^>]*fill="#80c080"/);
});
