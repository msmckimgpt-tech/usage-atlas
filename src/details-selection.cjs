'use strict';
const crypto = require('node:crypto');
const {series} = require('./core.cjs');
const catalog = require('../media/provider-focus.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const windows = ['five', 'week'];
function selection(message, records, retentionDays = 90, now = Date.now()) {
  if (!message || !catalog.valid(message.provider) || !['five', 'week', 'credit'].includes(message.window) || typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.requestId)) throw new Error('상세 조회 요청이 올바르지 않습니다.');
  if (![message.start, message.end, message.time].every(finite) || message.start >= message.end) throw new Error('상세 조회 기간이 올바르지 않습니다.');
  const latest = records.findLast(row => row.provider === message.provider);
  if (!latest) throw new Error('확인할 사용량 기록이 없습니다.');
  const days = finite(retentionDays) && retentionDays >= 7 && retentionDays <= 365 ? retentionDays : 90;
  const end = Math.min(now, message.end), start = Math.max(message.start, now - days * 86400000);
  if (start >= end) throw new Error('선택 기간에 확인할 기록이 없습니다.');
  const filters = {};
  for (const key of ['project', 'sessionId', 'turnId', 'model', 'effort', 'mode', 'inputBand', 'cacheBand']) {
    const value = message.filters?.[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f]/.test(value)) throw new Error('상세 조회 필터가 올바르지 않습니다.');
    filters[key] = value;
  }
  return {provider: message.provider, window: message.window === 'credit' ? 'week' : message.window, graphWindow: message.window, account: latest.account, start, end, cursorTime: Math.max(start, Math.min(end, message.time)), filters};
}
function validateExclusions(values, now = Date.now()) {
  if (!Array.isArray(values) || values.length > 4096) throw new Error('지원하지 않는 분석 제외 기록입니다.');
  const seen = new Set();
  return values.map(value => {
    if (!value || !catalog.valid(value.provider) || !windows.includes(value.window) || !/^[a-f0-9]{20}$/.test(value.account) || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || seen.has(value.id) || ![value.start, value.end, value.createdAt].every(finite) || value.start < 0 || value.start >= value.end || value.end > now + 300000 || value.createdAt < 0 || value.createdAt > now + 300000 || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 160 || /[\x00-\x1f]/.test(value.reason) || value.restoredAt != null && (!finite(value.restoredAt) || value.restoredAt < value.createdAt || value.restoredAt > now + 300000)) throw new Error('분석 제외 기록이 올바르지 않습니다.');
    seen.add(value.id);
    return {id: value.id, provider: value.provider, account: value.account, window: value.window, start: value.start, end: value.end, reason: value.reason, createdAt: value.createdAt, restoredAt: value.restoredAt ?? null};
  });
}
function createExclusion(message, records, capacities = [], now = Date.now()) {
  const scope = selection(message, records, 365, now), start = message.excludeStart ?? message.start, end = message.excludeEnd ?? message.end;
  if (!finite(start) || !finite(end) || start >= end || start < scope.start || end > scope.end) throw new Error('제외할 관측 구간이 올바르지 않습니다.');
  const points = series(records, scope.provider, scope.window, capacities), first = points.findIndex(p => p.time === start && finite(p.value)), last = points.findIndex(p => p.time === end && finite(p.value));
  if (first < 0 || last <= first) throw new Error('실제로 관측한 두 시각을 선택하세요.');
  const selected = points.slice(first, last + 1);
  if (selected.some((p, i) => i > 0 && (['early-reset', 'scheduled-reset'].includes(p.event?.kind) || p.plan !== selected[0].plan))) throw new Error('하나의 계정·요금제·초기화 주기 안에서 선택하세요.');
  const reason = typeof message.reason === 'string' ? message.reason.trim() : '';
  if (!reason || reason.length > 160 || /[\x00-\x1f]/.test(reason)) throw new Error('제외 사유는 1~160자로 입력하세요.');
  return {id: crypto.randomUUID(), provider: scope.provider, account: scope.account, window: scope.window, start, end, reason, createdAt: now, restoredAt: null};
}
module.exports = {selection, validateExclusions, createExclusion};
