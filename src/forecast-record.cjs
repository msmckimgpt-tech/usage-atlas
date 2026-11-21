'use strict';
// 예상 사용량 기록: 매 갱신의 예측선을 주기적으로 스냅샷해 두고, 시간이 지난 뒤 실제 사용량과 비교할 수 있게 한다.
// 기록은 로컬 저장 폴더의 forecast-record.json 에만 남고, 대화 본문·계정 식별 정보는 담지 않는다.
const fs = require('node:fs/promises');
const path = require('node:path');
const forecasts = require('../media/forecast.js');

const minute = 60000, hour = 60 * minute, day = 24 * hour;
// 5시간 창은 1시간마다(주기당 최대 5개), 주간 창은 6시간마다(주기당 최대 28개) 남긴다.
const policy = {five: {every: hour, keep: 7 * day}, week: {every: 6 * hour, keep: 21 * day}};
// minGap: 같은 키를 이보다 짧게 다시 남기지 않는다. fresh: 이보다 오래된 관측은 예측 시점을 흐리므로 남기지 않는다.
const maxPoints = 24, maxSnapshots = 400, maxBytes = 2 * 1024 * 1024, minGap = 10 * minute, fresh = 15 * minute;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const keyPattern = /^[a-z][a-z0-9-]{0,40}:(five|week)$/;

function downsample(points) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({length: maxPoints}, (_, i) => points[Math.round(i * step)]);
}
// 화면 기본 보기(현재 한도 사용률)와 같은 예측선을 원단위 %로 저장한다.
function snapshot(value, last, now) {
  const curve = forecasts.curve(value, last, {mode: 'usage', basis: 'current'}, now);
  if (!curve || curve.points.length < 2) return null;
  const points = downsample(curve.points).map(p => [Math.round(p.time), Math.round(p.value * 100) / 100]);
  return {at: Math.round(value.observedAt), reset: value.reset, mult: finite(last.mult) && last.mult > 0 ? last.mult : null, end: curve.endKind, points};
}
function validSnapshot(s) {
  return s && finite(s.at) && finite(s.reset) && s.reset > s.at && (s.mult === null || finite(s.mult) && s.mult > 0) && Array.isArray(s.points) && s.points.length >= 2 && s.points.length <= maxPoints
    && s.points.every((p, i) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]) && p[1] >= 0 && p[1] <= 100 && (i === 0 || p[0] > s.points[i - 1][0]));
}
function sanitize(value) {
  const entries = {};
  if (!value || value.version !== 1 || !value.entries || typeof value.entries !== 'object') return entries;
  for (const [key, list] of Object.entries(value.entries)) if (keyPattern.test(key) && Array.isArray(list)) entries[key] = list.filter(validSnapshot).map(s => ({at: s.at, reset: s.reset, mult: s.mult, end: s.end === 'exhaustion' ? 'exhaustion' : 'reset', points: s.points}));
  return entries;
}
// 새 주기: 이전 주기의 초기화 시각이 지났거나 예정 초기화가 간격 이상 뒤로 옮겨졌을 때. 작은 흔들림은 같은 주기로 본다.
function due(prev, at, reset, window) {
  if (!prev) return true;
  const gap = at - prev.at, every = policy[window].every;
  if (gap < minGap) return false;
  return gap >= every || at >= prev.reset || reset - prev.reset >= every;
}
// 여러 창이 따로 남긴 스냅샷을 합친 뒤에도 같은 간격 규칙만 남도록 앞에서부터 거른다.
function thin(list, window) {
  const out = [];
  for (const s of list) if (due(out.at(-1), s.at, s.reset, window)) out.push(s);
  return out;
}
function merge(a, b) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const byTime = new Map();
    for (const s of [...(a[key] || []), ...(b[key] || [])]) if (!byTime.has(s.at)) byTime.set(s.at, s);
    out[key] = [...byTime.values()].sort((x, y) => x.at - y.at);
  }
  return out;
}
function prune(entries, now) {
  for (const key of Object.keys(entries)) {
    const keep = policy[key.split(':')[1]].keep;
    const list = thin(entries[key].filter(s => s.at >= now - keep && s.at <= now + 5 * minute), key.split(':')[1]).slice(-maxSnapshots);
    if (list.length) entries[key] = list; else delete entries[key];
  }
  return entries;
}
// 같은 주기 안에서는 간격(policy.every)이 지나야 새 스냅샷을 남기고, 주기가 바뀌면(due) 즉시 남긴다.
function record(entries, data, now) {
  let changed = false;
  for (const [id, provider] of Object.entries(data || {})) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(id)) continue;
    for (const window of ['five', 'week']) {
      const value = provider?.forecast?.[window], last = provider?.windows?.[window]?.at(-1);
      if (!value || !last || !finite(value.observedAt) || !finite(value.reset) || now - value.observedAt > fresh || value.observedAt > now + minute) continue;
      const key = id + ':' + window, list = entries[key] || [], prev = list.at(-1);
      if (!due(prev, value.observedAt, value.reset, window)) continue;
      const snap = snapshot(value, last, now);
      if (!snap) continue;
      list.push(snap); entries[key] = list; changed = true;
    }
  }
  return changed;
}
// 화면에는 이미 지나간 시점이 있는 스냅샷만 보낸다.
function view(entries, now) {
  const out = {};
  for (const [key, list] of Object.entries(entries)) {
    const [id, window] = key.split(':'), past = list.filter(s => s.at < now);
    if (!past.length) continue;
    (out[id] ||= {})[window] = past.map(s => ({at: s.at, reset: s.reset, mult: s.mult, points: s.points}));
  }
  return out;
}

class ForecastRecord {
  constructor(dir) {this.file = path.join(dir, 'forecast-record.json'); this.entries = {}; this.dirty = false; this.saving = null;}
  async read() {
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > maxBytes) return {};
      return sanitize(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch {return {};}
  }
  async load() {this.entries = prune(merge(this.entries, await this.read()), Date.now());}
  record(data, now = Date.now()) {
    if (record(this.entries, data, now)) {prune(this.entries, now); this.dirty = true;}
    return this.dirty;
  }
  view(now = Date.now()) {return view(this.entries, now);}
  // 여러 VS Code 창이 같은 폴더를 쓰므로 디스크 내용과 합친 뒤 임시 파일을 거쳐 교체한다.
  async save() {
    if (this.saving) return this.saving;
    if (!this.dirty) return;
    this.saving = (async () => {
      this.dirty = false;
      const merged = prune(merge(await this.read(), this.entries), Date.now());
      const text = JSON.stringify({version: 1, entries: merged});
      if (text.length > maxBytes) return;
      const temp = this.file + '.' + process.pid + '.tmp';
      try {await fs.writeFile(temp, text, {mode: 0o600}); await fs.rename(temp, this.file); this.entries = prune(merge(this.entries, merged), Date.now());}
      catch (error) {this.dirty = true; await fs.unlink(temp).catch(() => {}); throw error;}
    })().finally(() => {this.saving = null;});
    return this.saving;
  }
}

module.exports = {ForecastRecord, record, view, merge, prune, thin, due, sanitize, snapshot, policy};
