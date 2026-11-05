'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const providers = ['codex', 'claude'];
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
const number = x => typeof x === 'number' && Number.isFinite(x);
function windowValue(percent, reset) {
  const r = typeof reset === 'number' ? reset * 1000 : Date.parse(reset);
  return number(percent) && percent >= 0 && percent <= 100 && number(r) ? {used: percent, reset: Math.round(r / 60000) * 60000} : null;
}
function codexSnapshot(data, account, now = Date.now()) {
  const limit = data.rateLimitsByLimitId?.codex || data.rateLimits;
  if (!limit) throw new Error('Codex 사용량 응답에 제한 정보가 없습니다');
  const windows = {five: null, week: null};
  for (const w of [limit.primary, limit.secondary]) {
    const key = w?.windowDurationMins === 300 ? 'five' : w?.windowDurationMins === 10080 ? 'week' : null;
    if (key) windows[key] = windowValue(w.usedPercent, w.resetsAt);
  }
  const rawBalance = limit.credits?.balance;
  const creditBalance = (typeof rawBalance === 'number' || typeof rawBalance === 'string' && rawBalance.trim() !== '') && number(Number(rawBalance)) && Number(rawBalance) >= 0 ? Number(rawBalance) : null;
  return {v: 1, provider: 'codex', account: hash(data.accountId || account?.email || 'codex-local'), time: now, plan: limit.planType || account?.planType || 'unknown', windows, source: 'app-server', creditBalance};
}
function claudeSnapshot(data, identity, plan, now = Date.now()) {
  const spend = data.spend?.used;
  const usd = spend?.currency === 'USD' && number(spend.amount_minor) && Number.isInteger(spend.exponent) && spend.exponent >= 0 && spend.exponent <= 6 ? spend.amount_minor / 10 ** spend.exponent : null;
  const extras = data.extra_usage;
  const extraUsd = extras?.currency === 'USD' && number(extras.used_credits) && Number.isInteger(extras.decimal_places) ? extras.used_credits / 10 ** extras.decimal_places : null;
  return {v: 1, provider: 'claude', account: hash(identity), time: now, plan, windows: {five: windowValue(data.five_hour?.utilization, data.five_hour?.resets_at), week: windowValue(data.seven_day?.utilization, data.seven_day?.resets_at)}, source: 'claude-compatibility', spentUsd: usd ?? extraUsd, spendPeriod: new Date(now).toISOString().slice(0, 7)};
}
function validSnapshot(s) {
  if (!s || s.v !== 1 || !providers.includes(s.provider) || !/^[a-f0-9]{20}$/.test(s.account) || !number(s.time) || s.time < 0 || s.time > Date.now() + 300000 || typeof s.plan !== 'string' || s.plan.length > 100 || !s.windows) return false;
  for (const key of ['five', 'week']) {
    const w = s.windows[key];
    if (w !== null && (!w || !number(w.used) || w.used < 0 || w.used > 100 || !number(w.reset))) return false;
  }
  return true;
}
function sanitize(s) {
  if (!validSnapshot(s)) throw new Error('기록 형식이 올바르지 않습니다');
  const out = {v: 1, provider: s.provider, account: s.account, time: s.time, plan: s.plan, source: ['app-server', 'claude-compatibility'].includes(s.source) ? s.source : 'import', windows: {}};
  for (const key of ['five', 'week']) out.windows[key] = s.windows[key] ? {used: s.windows[key].used, reset: s.windows[key].reset} : null;
  for (const key of ['spentUsd', 'creditBalance']) if (number(s[key]) && s[key] >= 0) out[key] = s[key];
  if (/^\d{4}-\d{2}$/.test(s.spendPeriod)) out.spendPeriod = s.spendPeriod;
  return out;
}
function series(records, provider, key, capacities = [], maxGap = 1800000) {
  const list = records.filter(s => s.provider === provider).sort((a, b) => a.time - b.time);
  const account = list.at(-1)?.account;
  let prev, cumulative = 0, nativeCumulative = 0, cumulativeKnown = true;
  return list.filter(s => s.account === account).map(s => {
    const w = s.windows[key];
    const cap = capacities.filter(c => c.provider === provider && c.account === account && c.window === key && c.plan === s.plan && c.time <= s.time).sort((a, b) => b.time - a.time)[0];
    const mult = cap?.mult ?? null;
    // 초기화·요금제 변경·감소·수집 공백은 소비량으로 추정하지 않는다.
    const valid = prev && w && prev.w && Math.abs(w.reset - prev.w.reset) <= 60000 && s.time < prev.w.reset && s.time - prev.time <= maxGap && s.plan === prev.plan && mult === prev.mult && w.used >= prev.w.used;
    const delta = valid ? w.used - prev.w.used : null;
    // 배율 설정은 이전 관측 누적을 지우거나 미확인 이력을 소급 환산하지 않는다.
    if (delta !== null) {nativeCumulative += delta; if (mult !== null) cumulative += delta * mult; else if (delta > 0) cumulativeKnown = false;}
    const totalContinuous = !!(prev && w && prev.w && s.time - prev.time <= maxGap);
    const p = {time: s.time, value: w?.used ?? null, reset: w?.reset ?? null, mult, delta, cumulative, nativeCumulative, cumulativeKnown, totalContinuous, plan: s.plan, continuous: !!valid};
    prev = {w, time: s.time, plan: s.plan, mult};
    return p;
  });
}
function creditLedger(records, provider, maxGap = 1800000) {
  const list = records.filter(r => r.provider === provider).sort((a, b) => a.time - b.time);
  const account = list.at(-1)?.account, unit = provider === 'codex' ? 'credits' : 'USD';
  let amount = 0, prev;
  const points = list.filter(r => r.account === account).map(r => {
    const value = unit === 'credits' ? r.creditBalance : r.spentUsd;
    const previous = prev && (unit === 'credits' ? prev.creditBalance : prev.spentUsd);
    const comparable = number(value) && value >= 0 && number(previous) && previous >= 0 && (unit === 'credits' || r.spendPeriod === prev.spendPeriod);
    const change = comparable ? (unit === 'credits' ? previous - value : value - previous) : null;
    const delta = change !== null && change >= 0 ? change : null;
    if (delta !== null) amount += delta;
    const p = {time: r.time, amount: number(value) && value >= 0 ? amount : null, delta, continuous: delta !== null && r.time - prev.time <= maxGap};
    prev = r; return p;
  });
  return {unit, points, available: points.some(p => p.amount !== null), total: amount};
}
class Store {
  constructor(dir, retentionDays = 90) {this.dir = dir; this.retentionDays = retentionDays; this.queue = Promise.resolve();}
  async withLock(fn) {
    await fs.mkdir(this.dir, {recursive: true});
    const lock = path.join(this.dir, 'writer.lock');
    let handle;
    try {handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(JSON.stringify({pid: process.pid, time: Date.now()}));}
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {const v = JSON.parse(await fs.readFile(lock, 'utf8')); try {process.kill(v.pid, 0);} catch (p) {if (p.code === 'ESRCH') {await fs.unlink(lock); return this.withLock(fn);}}}
      catch {try {if (Date.now() - (await fs.stat(lock)).mtimeMs > 120000) {await fs.unlink(lock); return this.withLock(fn);}} catch {}}
      return null;
    }
    try {return await fn();} finally {await handle.close(); await fs.unlink(lock).catch(() => {});}
  }
  async read() {
    let text, stamp; try {const file = path.join(this.dir, 'history.jsonl'); const stat = await fs.stat(file); if (stat.size > 32 * 1024 * 1024) throw new Error('기록 파일 크기 제한 초과'); stamp = `${stat.mtimeMs}/${stat.size}`; if (this.cachedStamp === stamp) return this.cached; text = await fs.readFile(file, 'utf8');} catch (e) {if (e.code === 'ENOENT') return []; throw e;}
    const out = [];
    for (const line of text.split('\n')) {if (!line) continue; try {out.push(sanitize(JSON.parse(line)));} catch {}}
    this.cachedStamp = stamp; this.cached = out;
    return out;
  }
  async commit(additions) {
    const clean = additions.map(sanitize);
    const data = [...await this.read()];
    const keys = new Set(data.map(s => `${s.provider}/${s.account}/${s.time}`));
    for (const s of clean) {const key = `${s.provider}/${s.account}/${s.time}`; if (!keys.has(key)) {keys.add(key); data.push(s);}}
    const cutoff = Date.now() - this.retentionDays * 86400000;
    const kept = data.filter(s => s.time >= cutoff).sort((a, b) => a.time - b.time).slice(-50000);
    const tmp = path.join(this.dir, `history.${process.pid}.tmp`);
    await fs.writeFile(tmp, kept.map(s => JSON.stringify(s)).join('\n') + '\n', {mode: 0o600});
    await fs.rename(tmp, path.join(this.dir, 'history.jsonl'));
    return kept;
  }
  async append(records) {const op = this.queue.then(() => this.withLock(() => this.commit(records))); this.queue = op.catch(() => {}); return op;}
}
function thin(points, budget) {
  if (points.length <= budget) return points;
  const stride = Math.ceil(points.length / (budget / 4)), kept = new Set([0, points.length - 1]);
  for (let i = 0; i < points.length; i += stride) {
    const end = Math.min(points.length, i + stride); let min = i, max = i;
    for (let j = i; j < end; j++) {const value = p => p.value ?? p.amount ?? 0; if (value(points[j]) < value(points[min])) min = j; if (value(points[j]) > value(points[max])) max = j;}
    for (const k of [i, end - 1, min, max]) kept.add(k);
  }
  return [...kept].sort((a, b) => a - b).map((i, n, a) => {
    const between = n > 0 ? points.slice(a[n - 1] + 1, i + 1) : [];
    return {...points[i], continuous: n > 0 && between.every(p => p.continuous), ...('totalContinuous' in points[i] ? {totalContinuous: n > 0 && between.every(p => p.totalContinuous)} : {})};
  });
}
module.exports = {hash, windowValue, codexSnapshot, claudeSnapshot, validSnapshot, sanitize, series, creditLedger, Store, thin};
