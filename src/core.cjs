'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const providers = ['codex', 'claude'];
const recordLimit = 50000, compactionMargin = 256, fileLimit = 32 * 1024 * 1024;
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
  return quotaSeries(currentRecords(records, provider), key, capacities, maxGap);
}
function currentRecords(records, provider) {
  const list = records.filter(s => s.provider === provider);
  if (list.some((s, i) => i > 0 && s.time < list[i - 1].time)) list.sort((a, b) => a.time - b.time);
  const account = list.at(-1)?.account;
  return list.filter(s => s.account === account);
}
function windowTransitions(list, key) {
  let previous;
  return list.map(s => {
    if (previous && s.plan !== previous.plan) previous = undefined;
    const w = s.windows[key];
    if (!w) return null;
    let event = null;
    if (previous && s.plan === previous.plan) {
      const changed = Math.abs(w.reset - previous.w.reset) > 60000;
      const dropped = w.used < previous.w.used;
      const crossed = s.time >= previous.w.reset && w.reset > s.time;
      const kind = crossed ? 'scheduled-reset' : changed && dropped && w.reset > s.time ? 'early-reset' : dropped ? 'decrease' : changed ? 'schedule-change' : null;
      if (kind) event = {kind, time: s.time, fromTime: previous.time, before: previous.w.used, after: w.used, previousReset: previous.w.reset, reset: w.reset};
    }
    previous = {w, time: s.time, plan: s.plan};
    return event;
  });
}
const isReset = event => event?.kind === 'scheduled-reset' || event?.kind === 'early-reset';
function quotaSeries(list, key, capacities, maxGap, transitions = windowTransitions(list, key)) {
  const {provider, account} = list.at(-1) || {};
  const byPlan = new Map(), positions = new Map();
  for (const c of capacities) if (c.provider === provider && c.account === account && c.window === key) {
    if (!byPlan.has(c.plan)) byPlan.set(c.plan, []);
    byPlan.get(c.plan).push(c);
  }
  // 동일 시각의 배율은 기존처럼 먼저 저장된 항목이 우선한다.
  for (const [plan, caps] of byPlan) {caps.sort((a, b) => a.time - b.time); byPlan.set(plan, caps.filter((c, i) => i === 0 || c.time !== caps[i - 1].time));}
  let prev, watermark, cumulative = 0, nativeCumulative = 0, cumulativeKnown = true, cumulativeEstimated = false, segment = 0, cumulativeSegment = 0;
  return list.map((s, i) => {
    const w = s.windows[key];
    const caps = byPlan.get(s.plan) || [];
    let position = positions.get(s.plan) ?? -1;
    while (position + 1 < caps.length && caps[position + 1].time <= s.time) position++;
    positions.set(s.plan, position);
    // 최초 입력 배율은 같은 계정·요금제·창의 과거 기록에도 적용한다.
    const cap = caps[position] || caps[0];
    const mult = cap?.mult ?? null;
    if (watermark && (watermark.plan !== s.plan || watermark.mult !== mult)) watermark = undefined;
    // 초기화·요금제 변경·감소·수집 공백은 소비량으로 추정하지 않는다.
    const valid = prev && w && prev.w && Math.abs(w.reset - prev.w.reset) <= 60000 && s.time < prev.w.reset && s.time - prev.time <= maxGap && s.plan === prev.plan && mult === prev.mult && w.used >= prev.w.used;
    const event = transitions[i], estimatedDelta = isReset(event) && w.used > 0;
    if (prev && (prev.plan !== s.plan || prev.mult !== mult || isReset(event) || event?.kind === 'decrease')) segment++;
    // 누적 보간은 초기화 경계만 넘고 계정 내 요금제·배율·보정 경계는 유지한다.
    if (prev && (prev.plan !== s.plan || prev.mult !== mult || event?.kind === 'decrease')) cumulativeSegment++;
    const sameWatermark = w && watermark && watermark.plan === s.plan && watermark.mult === mult && Math.abs(watermark.reset - w.reset) <= 60000 && !isReset(event);
    const peak = sameWatermark ? watermark.used : w?.used;
    // 초기화 직후 첫 관측은 사용자 선택에 따라 0% 기준의 새 소비로 합산한다.
    const delta = isReset(event) ? w.used : valid ? Math.max(0, w.used - Math.max(prev.w.used, peak)) : null;
    const recoveryExcluded = valid ? Math.max(0, w.used - prev.w.used - delta) : 0;
    cumulativeEstimated ||= estimatedDelta;
    // 원본 증가분은 보존하고 입력 배율로 기본 용량 누적을 계산한다.
    if (delta !== null) {nativeCumulative += delta; if (mult !== null) cumulative += delta * mult; else if (delta > 0) cumulativeKnown = false;}
    const totalContinuous = !!(prev && w && prev.w && s.time - prev.time <= maxGap);
    const p = {time: s.time, value: w?.used ?? null, reset: w?.reset ?? null, mult, segment, cumulativeSegment, delta, cumulative, nativeCumulative, cumulativeKnown, totalContinuous, plan: s.plan, continuous: !!valid, ...(event ? {event} : {}), ...(estimatedDelta ? {estimatedDelta: true} : {}), ...(cumulativeEstimated ? {cumulativeEstimated: true} : {}), ...(recoveryExcluded > 0 ? {recoveryExcluded, recoveryPeak: peak} : {})};
    if (w) watermark = {plan: s.plan, mult, reset: w.reset, used: Math.max(peak, w.used)};
    prev = {w, time: s.time, plan: s.plan, mult};
    return p;
  });
}
function creditLedger(records, provider, maxGap = 1800000) {
  return ledgerSeries(currentRecords(records, provider), provider, maxGap);
}
function ledgerSeries(list, provider, maxGap) {
  const unit = provider === 'codex' ? 'credits' : 'USD';
  let amount = 0, prev;
  const points = list.map(r => {
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
function project(records, capacities = [], maxGap = 1800000, enrich, forecast) {
  return Object.fromEntries(providers.map(id => {
    const mine = currentRecords(records, id), ledger = ledgerSeries(mine, id, maxGap);
    const transitions = Object.fromEntries(['five', 'week'].map(w => [w, windowTransitions(mine, w)]));
    const credit = creditValues(mine, ledger.points, transitions.week);
    const attach = points => {for (let i = 0; i < points.length; i++) points[i].credit = credit[i]; return points;};
    const windows = Object.fromEntries(['five', 'week'].map(w => [w, attach(quotaSeries(mine, w, capacities, maxGap, transitions[w]))]));
    attach(ledger.points);
    enrich?.(id, mine, windows, ledger.points);
    const forecastValue = forecast?.(id, mine, windows, records);
    const events = ['five', 'week'].flatMap(w => transitions[w].filter(Boolean).map(event => ({...event, window: w, value: Math.abs(event.before - event.after)}))).sort((a, b) => a.time - b.time);
    const latestChanges = new Map();
    for (const event of events) if (event.kind === 'schedule-change') latestChanges.set(event.window, event);
    const eventKey = e => `${e.window}/${e.time}/${e.kind}`;
    const sampled = new Map(thin(events, 2000).map(e => [eventKey(e), e]));
    for (const e of latestChanges.values()) sampled.set(eventKey(e), e);
    return [id, {...(forecastValue ? {forecast: forecastValue} : {}), last: mine.at(-1), first: mine[0]?.time, events: [...sampled.values()].sort((a,b) => a.time-b.time).map(({value, continuous, ...e}) => e), eventCount: events.length, windows: Object.fromEntries(['five', 'week'].map(w => [w, thin(windows[w], 2000)])), ledger: thin(ledger.points, 1500), ledgerUnit: ledger.unit, ledgerAvailable: ledger.available, creditTotal: ledger.total}];
  }));
}
function creditValues(list, ledger, transitions = windowTransitions(list, 'week')) {
  const week = 7 * 86400000;
  let reset = null, usage = 0, segment = 0, cumulativeSegment = 0, lastCreditValue = null;
  return list.map((r, i) => {
    const declared = r.windows?.week?.reset;
    const cycleChanged = !number(reset) || r.time >= reset || isReset(transitions[i]);
    if (number(declared) && declared > r.time) {
      if (!number(reset) || Math.abs(declared - reset) > 60000) reset = declared;
    }
    // 구독 창이 사라져도 마지막으로 관측한 주간 경계를 유지한다.
    if (number(reset) && r.time >= reset) reset += (Math.floor((r.time - reset) / week) + 1) * week;
    const sameCycle = number(reset) && !cycleChanged;
    const p = ledger[i];
    const previous = list[i - 1], key = r.provider === 'codex' ? 'creditBalance' : 'spentUsd';
    const cumulativeBoundary = previous && (previous.plan !== r.plan || r.provider === 'claude' && previous.spendPeriod !== r.spendPeriod || transitions[i]?.kind === 'decrease'
      || number(lastCreditValue) && number(r[key]) && (r.provider === 'codex' ? r[key] > lastCreditValue : r[key] < lastCreditValue));
    if (previous && (cumulativeBoundary || cycleChanged || isReset(transitions[i]))) segment++;
    if (cumulativeBoundary) cumulativeSegment++;
    if (number(r[key])) lastCreditValue = r[key];
    if (!sameCycle) usage = 0;
    if (sameCycle && number(p.delta)) usage += p.delta;
    const continuous = p.continuous && sameCycle;
    const delta = continuous && r.plan === list[i - 1]?.plan ? p.delta : null;
    const result = {usage: number(reset) && number(p.amount) ? usage : null, delta, total: p.amount, reset, segment, cumulativeSegment, cycleStart: !sameCycle, usageContinuous: !!continuous, deltaContinuous: !!(continuous && number(delta)), totalContinuous: !!p.continuous};
    return result;
  });
}
function creditModes(records, provider, maxGap = 1800000) {
  const mine = currentRecords(records, provider), ledger = ledgerSeries(mine, provider, maxGap);
  const credit = creditValues(mine, ledger.points);
  return ledger.points.map((p, i) => ({...p, credit: credit[i]}));
}
class Store {
  constructor(dir, retentionDays = 90) {this.dir = dir; this.retentionDays = retentionDays; this.queue = Promise.resolve();}
  get retentionDays() {return this._retentionDays;}
  set retentionDays(value) {if (number(value) && value >= 7 && value <= 365) this._retentionDays = value; else this._retentionDays ??= 90;}
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
    let handle;
    try {
      const file = path.join(this.dir, 'history.jsonl');
      if (this.cachedStamp === this.stamp(await fs.stat(file))) return this.trim();
      handle = await fs.open(file, 'r');
      const stat = await handle.stat(), stamp = this.stamp(stat);
      if (stat.size > fileLimit) throw new Error('기록 파일 크기 제한 초과');
      if (this.cachedStamp === stamp) return this.trim();
      const incremental = this.complete && stat.birthtimeMs > 0 && this.identity === `${stat.dev}/${stat.ino}/${stat.birthtimeMs}` && stat.size > this.size;
      const offset = incremental ? this.size : 0, bytes = Buffer.alloc(stat.size - offset);
      let read = 0;
      while (read < bytes.length) {const result = await handle.read(bytes, read, bytes.length - read, offset + read); if (!result.bytesRead) break; read += result.bytesRead;}
      const text = bytes.toString('utf8', 0, read), out = incremental ? [...this.cached] : [];
      let corrupt = false, count = incremental ? this.physicalCount : 0;
      for (const line of text.split('\n')) {if (!line) continue; try {out.push(sanitize(JSON.parse(line))); count++;} catch {corrupt = true;}}
      if (out.some((r, i) => i > 0 && r.time < out[i - 1].time)) out.sort((a, b) => a.time - b.time);
      this.cached = out; this.keys = new Set(out.map(s => this.key(s))); this.physicalCount = count;
      this.physicalFirst = incremental ? this.physicalFirst : out[0]?.time;
      this.complete = !corrupt && (!text.length || text.endsWith('\n')) && read === bytes.length && this.stamp(await handle.stat()) === stamp;
      this.cachedStamp = stamp; this.identity = `${stat.dev}/${stat.ino}/${stat.birthtimeMs}`; this.size = stat.size;
      return this.trim();
    } catch (e) {if (e.code === 'ENOENT') {this.cachedStamp = null; this.cached = []; this.keys = new Set(); this.physicalCount = 0; this.complete = false; return this.cached;} throw e;}
    finally {await handle?.close();}
  }
  key(s) {return `${s.provider}/${s.account}/${s.time}`;}
  stamp(stat) {return `${stat.dev}/${stat.ino}/${stat.birthtimeMs}/${stat.mtimeMs}/${stat.ctimeMs}/${stat.size}`;}
  trim() {
    const cutoff = Date.now() - this.retentionDays * 86400000;
    let start = Math.max(0, this.cached.length - recordLimit);
    while (start < this.cached.length && this.cached[start].time < cutoff) start++;
    if (start) {for (let i = 0; i < start; i++) this.keys.delete(this.key(this.cached[i])); this.cached = this.cached.slice(start);}
    return this.cached;
  }
  async commit(additions) {
    const clean = additions.map(sanitize);
    const data = await this.read(), fresh = [], keys = new Set();
    const cutoff = Date.now() - this.retentionDays * 86400000;
    for (const s of clean) {const key = this.key(s); if (s.time >= cutoff && !this.keys.has(key) && !keys.has(key)) {keys.add(key); fresh.push(s);}}
    fresh.sort((a, b) => a.time - b.time);
    const compact = !this.complete || this.physicalCount + fresh.length > recordLimit + compactionMargin || this.physicalFirst < cutoff - 86400000 || fresh[0]?.time < (data.at(-1)?.time ?? 0) || fresh.length > compactionMargin || this.size > fileLimit - 1048576;
    if (!fresh.length && !compact) return data;
    const kept = [...data, ...fresh];
    if (compact) kept.sort((a, b) => a.time - b.time);
    const retained = kept.slice(-recordLimit), file = path.join(this.dir, 'history.jsonl'), tmp = path.join(this.dir, `history.${process.pid}.tmp`);
    let handle;
    try {
      handle = await fs.open(compact ? tmp : file, compact ? 'w' : 'a', 0o600);
      const write = compact ? retained : fresh;
      for (let i = 0; i < write.length; i += 128) await handle.writeFile(write.slice(i, i + 128).map(s => JSON.stringify(s)).join('\n') + '\n');
      await handle.sync(); await handle.close(); handle = null;
      if (compact) await fs.rename(tmp, file);
      const stat = await fs.stat(file);
      this.cached = retained;
      if (compact) this.keys = new Set(retained.map(s => this.key(s)));
      else {for (const s of fresh) this.keys.add(this.key(s)); for (let i = 0; i < kept.length - retained.length; i++) this.keys.delete(this.key(kept[i]));}
      this.cachedStamp = this.stamp(stat); this.identity = `${stat.dev}/${stat.ino}/${stat.birthtimeMs}`; this.size = stat.size; this.complete = true;
      this.physicalCount = compact ? retained.length : this.physicalCount + fresh.length;
      this.physicalFirst = compact ? retained[0]?.time : this.physicalFirst;
      return this.cached;
    } catch (e) {this.cachedStamp = null; this.complete = false; throw e;}
    finally {await handle?.close(); if (compact) await fs.unlink(tmp).catch(() => {});}
  }
  async append(records) {const op = this.queue.then(() => this.withLock(() => this.commit(records))); this.queue = op.catch(() => {}); return op;}
}
function thin(points, budget) {
  if (points.length <= budget) return points;
  const fields = points.some(p => p.credit) ? [p => p.value ?? p.amount, p => p.delta, p => p.credit.usage, p => p.credit.delta] : [p => p.value ?? p.amount];
  if (points.some(p => p.billing)) fields.push(p => p.billing?.usage, p => p.billing?.delta, p => p.billing?.total);
  if (points.some(p => p.creditEstimate)) fields.push(p => p.creditEstimate?.usage, p => p.creditEstimate?.delta, p => p.creditEstimate?.nativeUsage, p => p.creditEstimate?.nativeDelta);
  const kept = new Set([0, points.length - 1]), resetIndexes = [];
  for (let i = 0; i < points.length; i++) if (isReset(points[i].event)) resetIndexes.push(i);
  const eventStride = Math.max(1, Math.ceil(resetIndexes.length / Math.max(1, Math.floor(budget / 6))));
  for (let i = 0; i < resetIndexes.length; i += eventStride) {
    const index = resetIndexes[i], fromTime = points[index].event.fromTime;
    let lo = 0, hi = index;
    while (lo < hi) {const mid = (lo + hi) >>> 1; if (points[mid].time < fromTime) lo = mid + 1; else hi = mid;}
    // 결측이 끼어 있어도 완료 주기의 실제 마지막 관측점을 보존한다.
    const previous = points[lo]?.time === fromTime ? lo : index - 1;
    for (const k of [previous, index, index + 1]) if (k >= 0 && k < points.length) kept.add(k);
  }
  const stride = Math.ceil(points.length / (Math.max(1, budget - kept.size) / (2 + 2 * fields.length)));
  for (let i = 0; i < points.length; i += stride) {
    const end = Math.min(points.length, i + stride);
    kept.add(i); kept.add(end - 1);
    for (const field of fields) {
      let min = i, max = i;
      for (let j = i; j < end; j++) {if ((field(points[j]) ?? 0) < (field(points[min]) ?? 0)) min = j; if ((field(points[j]) ?? 0) > (field(points[max]) ?? 0)) max = j;}
      kept.add(min); kept.add(max);
    }
  }
  return [...kept].sort((a, b) => a - b).map((i, n, a) => {
    let continuous = n > 0, totalContinuous = n > 0;
    const credit = points[i].credit && {...points[i].credit};
    const estimate = points[i].creditEstimate && {...points[i].creditEstimate};
    const billing = points[i].billing && {...points[i].billing};
    for (let j = n > 0 ? a[n - 1] + 1 : i; j <= i; j++) {
      continuous &&= !!points[j].continuous; totalContinuous &&= !!points[j].totalContinuous;
      if (billing) for (const key of ['usageContinuous', 'deltaContinuous', 'totalContinuous']) billing[key] &&= !!points[j].billing?.[key];
      if (credit) for (const key of ['usageContinuous', 'deltaContinuous', 'totalContinuous']) credit[key] &&= !!points[j].credit[key];
      if (estimate) for (const key of ['usageContinuous', 'deltaContinuous', 'totalContinuous', 'nativeUsageContinuous', 'nativeDeltaContinuous', 'nativeTotalContinuous']) estimate[key] &&= !!points[j].creditEstimate?.[key];
    }
    return {...points[i], continuous, ...('totalContinuous' in points[i] ? {totalContinuous} : {}), ...(credit ? {credit} : {}), ...(estimate ? {creditEstimate: estimate} : {}), ...(billing ? {billing} : {})};
  });
}
module.exports = {hash, windowValue, codexSnapshot, claudeSnapshot, validSnapshot, sanitize, series, creditLedger, creditModes, project, Store, thin};
