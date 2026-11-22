((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasForecast = api;
})(globalThis, () => {
  const minute = 60000, hour = 60 * minute, day = 24 * hour, quarter = 15 * minute, finite = n => typeof n === 'number' && Number.isFinite(n);
  const formatters = new Map(), weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const resetEvent = p => ['scheduled-reset', 'early-reset'].includes(p.event?.kind);
  const clamp = (n, fallback, min, max) => finite(n) && n >= min && n <= max ? n : fallback;
  function formatter(timeZone) {
    if (formatters.has(timeZone)) return formatters.get(timeZone);
    const value = new Intl.DateTimeFormat('en-US', {timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'});
    if (formatters.size >= 8) formatters.delete(formatters.keys().next().value);
    formatters.set(timeZone, value); return value;
  }
  function settings(value = {}) {
    let timeZone = typeof value.timeZone === 'string' && value.timeZone.length <= 100 ? value.timeZone : 'Asia/Seoul';
    try {formatter(timeZone);} catch {timeZone = 'Asia/Seoul';}
    return {
        fiveMinutes: clamp(value.fiveMinutes, 60, 10, 300)
      , weekHours: clamp(value.weekHours, 72, 1, 168)
      , patternDays: Number.isInteger(value.patternDays) ? clamp(value.patternDays, 21, 0, 365) : 21
      , timeZone
      , staleAfterMs: Math.max(15 * minute, clamp(value.intervalSeconds, 300, 1, 3600) * 3000)
    };
  }
  function recentEstimate(points, window, options = {}) {
    const config = settings(options), last = points.at(-1), lookbackMs = window === 'five' ? config.fiveMinutes * minute : config.weekHours * hour;
    const result = {state: 'insufficient', eta: null, observedAt: last?.time ?? null, reset: last?.reset ?? null, used: last?.value ?? null, lookbackMs, staleAfterMs: config.staleAfterMs, coverage: 0, sampleCount: 0, positiveSamples: 0, ratePerHour: null};
    if (!last || !finite(last.time) || !finite(last.value) || last.value < 0 || last.value > 100 || !finite(last.reset) || last.reset <= last.time) return {...result, state: 'missing'};
    if (last.value === 100) return {...result, state: 'exhausted'};
    let first = points.length - 1, peak = last.value;
    while (first > 0 && !resetEvent(points[first])) {
      const before = points[first - 1];
      if (before.plan !== last.plan || before.mult !== last.mult || finite(options.since) && before.time <= options.since) break;
      if (finite(before.value)) peak = Math.max(peak, before.value);
      first--;
    }
    if (last.value < peak) return {...result, state: 'recovery'};
    const start = Math.max(last.time - lookbackMs, points[first].time), span = last.time - start;
    let coveredMs = 0, consumed = 0, sampleCount = 0, positiveSamples = 0;
    for (let i = points.length - 1; i > first; i--) {
      const a = points[i - 1], b = points[i];
      if (b.time <= start) break;
      const dt = b.time - a.time;
      if (!b.continuous || !finite(b.delta) || b.delta < 0 || b.estimatedDelta || b.recoveryExcluded > 0 || dt <= 0 || a.plan !== last.plan || a.mult !== last.mult) continue;
      const duration = b.time - Math.max(a.time, start);
      coveredMs += duration; consumed += b.delta * duration / dt; sampleCount++;
      if (b.delta > 0) positiveSamples++;
    }
    const coverage = span > 0 ? coveredMs / span : 0;
    const anchor = points.slice(first).find(p => p.time >= start && finite(p.value));
    const netGrowth = anchor ? Math.max(0, last.value - anchor.value) : 0;
    const consumptionCoverage = netGrowth > 0 ? Math.min(1, consumed / netGrowth) : 1;
    const detail = {...result, coverage, consumptionCoverage, observedGrowth: consumed, netGrowth, sampleCount, positiveSamples, coveredMs, observedSpanMs: span, sampleStart: start};
    const minimum = Math.min(lookbackMs / 4, window === 'five' ? 15 * minute : hour);
    if (sampleCount < 2 || coveredMs < minimum || coverage < .75) return detail;
    if (consumptionCoverage < .75) return {...detail, reason: 'unobserved-growth'};
    if (consumed === 0) return {...detail, state: 'inactive', ratePerHour: 0};
    if (positiveSamples < 2) return detail;
    const ratePerHour = consumed / coveredMs * hour, eta = last.time + (100 - last.value) / ratePerHour * hour;
    if (!finite(eta) || !finite(ratePerHour) || ratePerHour <= 0) return detail;
    return {...detail, ratePerHour, state: eta < last.reset ? 'predicted' : 'reset-first', eta: eta < last.reset ? eta : null};
  }
  function patternEstimate(points, recent, config, options) {
    const last = points.at(-1), cutoff = last.time - config.patternDays * day, through = ['insufficient', 'recovery'].includes(recent.state) && recent.reason !== 'unobserved-growth' ? last.time : recent.sampleStart ?? last.time - recent.lookbackMs;
    if (!config.patternDays || !['predicted', 'reset-first', 'inactive', 'insufficient', 'recovery'].includes(recent.state) || last.reset - last.time > 7 * day || through <= cutoff) return recent;
    const buckets = Array.from({length: 168}, () => new Map()), slots = options.slots || new Map(), format = formatter(config.timeZone);
    const slot = time => {
      const key = Math.floor(time / quarter);
      if (!slots.has(key)) {
        const parts = Object.fromEntries(format.formatToParts(key * quarter + quarter / 2).map(p => [p.type, p.value]));
        slots.set(key, {index: weekdays.indexOf(parts.weekday) * 24 + Number(parts.hour), date: parts.year + parts.month + parts.day, end: (key + 1) * quarter});
      }
      return slots.get(key);
    };
    let observedMs = 0, peak = points[0].value;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dt = b.time - a.time;
      if (a.time >= through) break;
      const changed = resetEvent(b) || a.plan !== b.plan || a.mult !== b.mult;
      const recovering = !changed && (finite(a.value) && a.value < peak || finite(b.value) && b.value < peak);
      if (changed) peak = b.value;
      else if (finite(b.value)) peak = finite(peak) ? Math.max(peak, b.value) : b.value;
      if (b.time <= cutoff || !b.continuous || !finite(b.delta) || b.delta < 0 || b.estimatedDelta || b.recoveryExcluded > 0 || recovering || resetEvent(b) || !finite(a.value) || a.value >= 100 || dt <= 0 || a.plan !== last.plan || b.plan !== last.plan || a.mult !== last.mult || b.mult !== last.mult || finite(options.since) && a.time <= options.since) continue;
      let time = Math.max(a.time, cutoff), end = Math.min(b.time, through);
      while (time < end) {
        const cell = slot(time), until = Math.min(cell.end, end), duration = until - time;
        const bucket = buckets[cell.index], entry = bucket.get(cell.date) || {ms: 0, consumed: 0};
        entry.ms += duration; entry.consumed += b.delta * duration / dt; bucket.set(cell.date, entry);
        observedMs += duration; time = until;
      }
    }
    for (const cell of Array.isArray(options.archiveCells) ? options.archiveCells : []) {
      const time = cell.key * quarter;
      if (time < cutoff || time + quarter > through || finite(options.since) && time <= options.since) continue;
      const c = slot(time), bucket = buckets[c.index], entry = bucket.get(c.date) || {ms: 0, consumed: 0};
      entry.ms += cell.ms; entry.consumed += cell.consumed; bucket.set(c.date, entry); observedMs += cell.ms;
    }
    const rateOf = bucket => {
      const days = [...bucket.values()].filter(p => p.ms >= 15 * minute), ms = days.reduce((sum, p) => sum + p.ms, 0);
      return days.length >= 2 && ms >= hour ? days.reduce((sum, p) => sum + p.consumed, 0) / ms * hour : null;
    };
    const dayTypes = Array.from({length: 48}, () => new Map()), hours = Array.from({length: 24}, () => new Map());
    const dayType = index => ([0, 6].includes(Math.floor(index / 24)) ? 24 : 0) + index % 24;
    const merge = (target, source) => {
      for (const [date, value] of source) {
        const entry = target.get(date) || {ms: 0, consumed: 0};
        entry.ms += value.ms; entry.consumed += value.consumed; target.set(date, entry);
      }
    };
    for (let i = 0; i < buckets.length; i++) {merge(dayTypes[dayType(i)], buckets[i]); merge(hours[i % 24], buckets[i]);}
    const typeRates = dayTypes.map(rateOf), hourRates = hours.map(rateOf);
    const tiers = buckets.map((bucket, i) => {
      const weekday = rateOf(bucket);
      return finite(weekday) ? {rate: weekday, tier: 'weekday'} : finite(typeRates[dayType(i)]) ? {rate: typeRates[dayType(i)], tier: 'dayType'} : finite(hourRates[i % 24]) ? {rate: hourRates[i % 24], tier: 'hour'} : {rate: null, tier: null};
    });
    const rates = tiers.map(p => p.rate), tierSlots = {weekday: 0, dayType: 0, hour: 0}, tierMatchedMs = {weekday: 0, dayType: 0, hour: 0};
    for (const p of tiers) if (p.tier) tierSlots[p.tier]++;
    const qualifiedSlots = rates.filter(finite).length;
    const historicalOnly = options.method === 'historical' || ['insufficient', 'recovery'].includes(recent.state);
    const pooled = new Map(); for (const bucket of buckets) merge(pooled, bucket);
    const globalRate = rateOf(pooled);
    if (historicalOnly && (recent.netGrowth > 0 || recent.reason === 'unobserved-growth' || recent.state === 'recovery') && globalRate === 0) return recent;
    if (!qualifiedSlots) return recent;
    // 최근 평균이 불완전하면 실제 관측된 과거 패턴만 사용한다. 누락 시간은 휴식이 아니다.
    const trajectory = [{time: last.time, value: last.value}];
    let time = last.time, used = last.value, previousRate, matchedMs = 0;
    while (time < last.reset) {
      const cell = slot(time), historical = rates[cell.index], rate = finite(historical) ? historicalOnly ? historical : (recent.ratePerHour + historical) / 2 : historicalOnly ? globalRate : recent.ratePerHour;
      if (!finite(rate)) return recent;
      let end = Math.min(cell.end, last.reset), growth = rate * (end - time) / hour;
      if (growth >= 100 - used && rate > 0) {end = time + (100 - used) / rate * hour; growth = 100 - used;}
      if (finite(historical)) {matchedMs += end - time; tierMatchedMs[tiers[cell.index].tier] += end - time;}
      used = Math.min(100, used + growth);
      const point = {time: end, value: used};
      if (previousRate === rate && trajectory.length > 1) trajectory[trajectory.length - 1] = point;
      else trajectory.push(point);
      previousRate = rate; time = end;
      if (used >= 100) break;
    }
    if (!matchedMs) return recent;
    const eta = used >= 100 && time < last.reset ? time : null;
    return {
        ...recent
      , state: eta !== null ? 'predicted' : 'reset-first'
      , eta
      , trajectory
      , pattern: {days: config.patternDays, timeZone: config.timeZone, weight: historicalOnly ? 1 : .5, qualifiedSlots, observedMs, matchedMs, policy: 'weekday-daytype-hour', tierSlots, tierMatchedMs}
    };
  }
  function activityPattern(points, recent, config, options) {
    const last = points.at(-1), cutoff = last.time - config.patternDays * day, through = ['insufficient', 'recovery'].includes(recent.state) && recent.reason !== 'unobserved-growth' ? last.time : recent.sampleStart ?? last.time - recent.lookbackMs;
    if (!config.patternDays || !['predicted', 'reset-first', 'inactive', 'insufficient', 'recovery'].includes(recent.state) || last.reset - last.time > 7 * day || through <= cutoff) return recent;
    const slots = options.slots || new Map(), fmt = formatter(config.timeZone), cells = new Map();
    const slot = time => {
      const key = Math.floor(time / quarter);
      if (!slots.has(key)) {
        const parts = Object.fromEntries(fmt.formatToParts(key * quarter + quarter / 2).map(part => [part.type, part.value]));
        slots.set(key, {index: weekdays.indexOf(parts.weekday) * 24 + Number(parts.hour), date: parts.year + parts.month + parts.day, end: (key + 1) * quarter});
      }
      return slots.get(key);
    };
    let peak = points[0].value, recentMs = 0, recentUsed = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dt = b.time - a.time, changed = resetEvent(b) || a.plan !== b.plan || a.mult !== b.mult;
      const recovery = !changed && (finite(a.value) && a.value < peak || finite(b.value) && b.value < peak);
      if (changed) peak = b.value; else if (finite(b.value)) peak = finite(peak) ? Math.max(peak, b.value) : b.value;
      if (!b.continuous || !finite(b.delta) || b.delta < 0 || b.estimatedDelta || b.recoveryExcluded > 0 || recovery || resetEvent(b) || !finite(a.value) || a.value >= 100 || dt <= 0 || a.plan !== last.plan || b.plan !== last.plan || a.mult !== last.mult || b.mult !== last.mult || finite(options.since) && a.time <= options.since) continue;
      const overlap = b.time - Math.max(a.time, last.time - quarter);
      if (overlap > 0) {recentMs += overlap; recentUsed += b.delta * overlap / dt;}
      let time = Math.max(a.time, cutoff), end = Math.min(b.time, through);
      while (time < end) {
        const key = Math.floor(time / quarter), calendar = slot(time), until = Math.min(calendar.end, end), duration = until - time;
        let cell = cells.get(key);
        if (!cell) {cell = {key, ms: 0, consumed: 0, segment: a.segment, conflict: false, ...calendar}; cells.set(key, cell);}
        if (cell.segment !== a.segment) cell.conflict = true;
        cell.ms += duration; cell.consumed += b.delta * duration / dt; time = until;
      }
    }
    for (const cell of Array.isArray(options.archiveCells) ? options.archiveCells : []) {
      const time = cell.key * quarter;
      if (time < cutoff || time + quarter > through || finite(options.since) && time <= options.since) continue;
      cells.set(cell.key, {...cell, ...slot(time), conflict: false});
    }
    const usable = [...cells.values()].filter(cell => cell.ms >= quarter * .75 && !cell.conflict).sort((a, b) => a.key - b.key);
    const make = () => ({dates: new Set(), ms: 0, activeMs: 0, consumed: 0, aa: 0, ai: 0, ia: 0, ii: 0});
    const buckets = Array.from({length: 168}, make), types = Array.from({length: 48}, make), hours = Array.from({length: 24}, make), global = make();
    const dayType = index => ([0, 6].includes(Math.floor(index / 24)) ? 24 : 0) + index % 24;
    let previous;
    for (const cell of usable) {
      const active = cell.consumed > 0, groups = [buckets[cell.index], types[dayType(cell.index)], hours[cell.index % 24], global];
      for (const group of groups) {
        group.dates.add(cell.date); group.ms += cell.ms; group.consumed += cell.consumed;
        if (active) group.activeMs += cell.ms;
        if (previous && previous.key + 1 === cell.key && previous.segment === cell.segment) group[(previous.consumed > 0 ? 'a' : 'i') + (active ? 'a' : 'i')]++;
      }
      previous = cell;
    }
    const qualified = group => group.dates.size >= 2 && group.ms >= hour;
    const currentKnown = recentMs >= quarter * .75, currentRate = currentKnown ? recentUsed / recentMs * hour : recent.ratePerHour;
    if (!qualified(global) || global.activeMs === 0 && (currentRate > 0 || recent.netGrowth > 0 || recent.reason === 'unobserved-growth' || recent.state === 'recovery')) return recent;
    const activeRate = global.activeMs ? global.consumed / global.activeMs * hour : 0;
    const aa = global.aa + global.ai ? global.aa / (global.aa + global.ai) : null, ia = global.ia + global.ii ? global.ia / (global.ia + global.ii) : null;
    if (aa === null && currentRate > 0 || ia === null) return recent;
    const profiles = buckets.map((group, index) => {
      const choices = [[group, 'weekday'], [types[dayType(index)], 'dayType'], [hours[index % 24], 'hour'], [global, 'global']];
      const [value, tier] = choices.find(([value]) => qualified(value));
      return {tier, activeFraction: value.activeMs / value.ms, rate: value.activeMs ? value.consumed / value.activeMs * hour : activeRate, aa: value.aa + value.ai ? value.aa / (value.aa + value.ai) : aa ?? 0, ia: value.ia + value.ii ? value.ia / (value.ia + value.ii) : ia};
    });
    const currentActive = finite(currentRate) ? currentRate > 0 ? 1 : 0 : profiles[slot(last.time).index].activeFraction;
    let probability = currentActive, time = last.time, used = last.value, previousRate, matchedMs = 0;
    const trajectory = [{time, value: used}], tierSlots = {weekday: 0, dayType: 0, hour: 0, global: 0}, tierMatchedMs = {weekday: 0, dayType: 0, hour: 0, global: 0};
    for (const profile of profiles) tierSlots[profile.tier]++;
    while (time < last.reset) {
      const calendar = slot(time), profile = profiles[calendar.index], rate = probability * profile.rate;
      let end = Math.min(calendar.end, last.reset), growth = rate * (end - time) / hour;
      if (growth >= 100 - used && rate > 0) {end = time + (100 - used) / rate * hour; growth = 100 - used;}
      matchedMs += end - time; tierMatchedMs[profile.tier] += end - time; used = Math.min(100, used + growth);
      const point = {time: end, value: used};
      if (previousRate === rate && trajectory.length > 1) trajectory[trajectory.length - 1] = point; else trajectory.push(point);
      previousRate = rate; time = end;
      if (used >= 100) break;
      const next = profiles[slot(time).index]; probability = probability * next.aa + (1 - probability) * next.ia;
    }
    const eta = used >= 100 && time < last.reset ? time : null;
    return {
        ...recent
      , state: eta !== null ? 'predicted' : 'reset-first'
      , eta, trajectory
      , pattern: {days: config.patternDays, timeZone: config.timeZone, weight: 0, qualifiedSlots: profiles.filter(profile => profile.tier !== 'global').length, observedMs: global.ms, matchedMs, policy: 'calendar-activity', tierSlots, tierMatchedMs, currentActive, currentRate}
    };
  }

  function estimate(points, window, options = {}) {
    const recent = recentEstimate(points, window, options);
    if (!points.length || options.method === 'recent' && !['insufficient', 'recovery'].includes(recent.state)) return recent;
    return options.method === 'activity' ? activityPattern(points, recent, settings(options), options) : patternEstimate(points, recent, settings(options), options);
  }
  function accountStart(records, id, account, through) {
    let since = null;
    for (const row of records) if (row.provider === id && row.account !== account && row.time <= through && (since === null || row.time > since)) since = row.time;
    return since;
  }
  // Antigravity는 같은 주기 안에서도 사용률이 1%p 미만으로 오르내린다. 이 흔들림을 회복·결측으로 보면
  // 예측이 recovery/insufficient로 멈추므로, 예측 입력에서만 주기 내 최고값으로 눌러 소비 구간을 잇는다.
  // 허용폭을 넘는 감소, 초기화, 요금제·배율 변경, 수집 공백(totalContinuous=false)은 그대로 둔다.
  function denoise(points, tolerance = 1) {
    if (!Array.isArray(points) || !points.length || !finite(tolerance) || tolerance <= 0) return points || [];
    const clean = p => {delete p.recoveryExcluded; delete p.recoveryPeak; if (p.event?.kind === 'decrease') delete p.event; return p;};
    let previous = null, peak = null;
    return points.map(p => {
      if (!finite(p.value)) {previous = null; peak = null; return p;}
      const sameCycle = previous && !resetEvent(p) && p.totalContinuous !== false && p.plan === previous.plan && p.mult === previous.mult && finite(p.reset) && finite(previous.reset) && Math.abs(p.reset - previous.reset) <= minute && p.time > previous.time && p.time < previous.reset;
      if (!sameCycle || p.value >= peak) {
        const out = sameCycle && (!p.continuous || p.recoveryExcluded > 0) ? clean({...p, continuous: true, delta: p.value - previous.value}) : p;
        previous = out; peak = p.value; return out;
      }
      if (peak - p.value > tolerance) {previous = p; peak = p.value; return p;}
      const out = clean({...p, value: peak, rawValue: p.value, delta: 0, continuous: true});
      previous = out; return out;
    });
  }
  function provider(windows, options = {}) {
    const shared = {...options, slots: new Map()};
    return Object.fromEntries(['five', 'week'].map(window => {
      const learned = options.learning?.[window], points = windows[window] || [], last = points.at(-1);
      const value = estimate(points, window, {...shared, method: learned?.method, archiveCells: options.archiveCells?.[window]});
      // 흔들림을 누른 마지막 값과 화면의 원래 관측값을 구분해, 예상선이 실제 마지막 관측점에서 시작하게 한다.
      if (finite(last?.rawValue) && value.observedAt === last.time) value.observedValue = last.rawValue;
      return [window, learned ? {...value, calibration: {method: learned.method, samples: learned.samples, origins: learned.origins, dates: learned.dates, errors: learned.errors}} : value];
    }));
  }
  function remaining(ms) {
    if (!finite(ms) || ms <= 0) return '-';
    if (ms >= 24 * hour) {const hours = Math.floor(ms / hour); return Math.floor(hours / 24) + 'd ' + hours % 24 + 'h';}
    const minutes = Math.min(1439, Math.ceil(ms / minute)); return Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm';
  }
  function present(value, now) {
    if (!value || !finite(value.observedAt) || !finite(value.staleAfterMs) || !finite(value.reset) || !finite(now) || value.observedAt > now || value.reset <= now || now - value.observedAt > value.staleAfterMs) return {state: 'unavailable', text: '-'};
    if (value.state === 'predicted') return finite(value.eta) && value.eta > now && value.eta < value.reset ? {state: 'predicted', eta: value.eta, text: '≈' + remaining(value.eta - now)} : {state: 'unavailable', text: '-'};
    return {state: value.state, text: value.state === 'exhausted' ? '도달' : value.state === 'reset-first' ? '초기화 우선' : '-'};
  }
  function atReset(value) {
    if (!finite(value?.used) || value.used < 0 || value.used > 100 || !value.trajectory && (!finite(value.ratePerHour) || value.ratePerHour < 0) || !finite(value.reset) || !finite(value.observedAt) || value.reset <= value.observedAt) return null;
    if (value.trajectory) return value.trajectory.at(-1)?.time === value.reset ? value.trajectory.at(-1).value : null;
    const used = value.used + value.ratePerHour * (value.reset - value.observedAt) / hour;
    return finite(used) ? Math.min(100, used) : null;
  }
  function summary(value, now) {
    const status = present(value, now);
    if (status.state === 'predicted') return {...status, label: '사용 가능', remainingMs: value.eta - now};
    if (status.state === 'exhausted') return {...status, label: '사용 가능', text: '0h 0m', remainingMs: 0};
    const used = ['reset-first', 'inactive'].includes(status.state) ? atReset(value) : null;
    if (finite(used) && used >= 0 && used <= 100) {
      const rounded = Math.round(used * 10) / 10;
      return {...status, label: '도달 사용량', text: (used > 0 && rounded === 0 ? '<0.1' : used < 100 && rounded === 100 ? '>99.9' : '≈' + rounded) + '%', usedPercent: used};
    }
    return {...status, label: '예상', text: '-'};
  }
  function curve(value, last, {mode = 'usage', basis = 'current'} = {}, now) {
    const status = present(value, now);
    // 소비가 없는 inactive도 미리보기가 초기화 시점 사용량을 표시하므로 같은 값을 잇는 수평 예상선을 그린다.
    if (!['predicted', 'reset-first', 'inactive'].includes(status.state) || mode === 'delta' || !last || last.time !== value.observedAt || last.value !== (finite(value.observedValue) ? value.observedValue : value.used) || last.reset !== value.reset || !value.trajectory && (!finite(value.ratePerHour) || value.ratePerHour < 0 || value.ratePerHour === 0 && status.state !== 'inactive')) return null;
    const end = status.state === 'predicted' ? value.eta : value.reset;
    const rawEnd = status.state === 'predicted' ? 100 : atReset(value);
    const calibrated = finite(last.mult) && last.mult > 0, known = calibrated && (mode !== 'total' || last.cumulativeKnown !== false);
    const factor = basis === 'base' && (mode === 'total' ? known : calibrated) ? last.mult : 1;
    const start = mode === 'total' ? known ? last.cumulative / (basis === 'base' ? 1 : last.mult) : last.nativeCumulative : last.value * factor;
    const finish = mode === 'total' ? start + (rawEnd - value.used) * factor : rawEnd * factor;
    if (!finite(rawEnd) || !finite(start) || !finite(finish) || end <= value.observedAt) return null;
    const raw = (value.trajectory || [{time: value.observedAt, value: value.used}, {time: end, value: rawEnd}]).map((p, i) => i === 0 && finite(value.observedValue) && p.time === value.observedAt ? {...p, value: Math.min(p.value, value.observedValue)} : p);
    if (raw.some((p, i) => !finite(p.time) || !finite(p.value) || p.value < 0 || p.value > 100 || i > 0 && (p.time <= raw[i - 1].time || p.value < raw[i - 1].value))) return null;
    const project = p => mode === 'total' ? start + (p - value.used) * factor : p * factor;
    const errors = (value.calibration?.errors || []).filter(p => finite(p.hours) && p.hours > 0 && p.samples >= 8 && p.dates >= 3 && finite(p.low) && p.low <= 0 && finite(p.high) && p.high >= 0).sort((a, b) => a.hours - b.hours);
    const range = [];
    if (errors.length) {
      const maxTime = Math.min(end, value.observedAt + errors.at(-1).hours * hour);
      const timePoints = [...new Set([value.observedAt, ...raw.map(p => p.time).filter(t => t <= maxTime), ...errors.map(p => value.observedAt + p.hours * hour).filter(t => t <= maxTime), maxTime])].sort((a, b) => a - b);
      const at = time => {const index = raw.findIndex(p => p.time >= time); if (index <= 0) return raw[0].value; const a = raw[index - 1], b = raw[index]; return a.value + (b.value - a.value) * (time - a.time) / (b.time - a.time);};
      for (const time of timePoints) {
        const hours = (time - value.observedAt) / hour, index = errors.findIndex(p => p.hours >= hours), b = errors[index < 0 ? errors.length - 1 : index], a = index > 0 ? errors[index - 1] : {hours: 0, low: 0, high: 0};
        const ratio = b.hours === a.hours ? 1 : (hours - a.hours) / (b.hours - a.hours), center = at(time);
        const low = Math.max(value.used, center + a.low + (b.low - a.low) * ratio), high = Math.min(100, center + a.high + (b.high - a.high) * ratio);
        range.push({time, low: project(low), high: project(high)});
      }
      // 하단은 뒤에서 낮추고 상단은 앞에서 높여 오차 범위를 좁히지 않는다.
      for (let i = range.length - 2; i >= 0; i--) range[i].low = Math.min(range[i].low, range[i + 1].low);
      for (let i = 1; i < range.length; i++) range[i].high = Math.max(range[i].high, range[i - 1].high);
    }
    return {known, endKind: status.state === 'predicted' ? 'exhaustion' : 'reset', range, points: raw.map((p, i) => ({...p, y: project(p.value), continuous: i > 0, estimated: true}))};
  }
  // 주기별 기준 예측: 기록된 예측 스냅샷을 주기로 묶고, 주기 시작 뒤 lead 가 지난 첫 스냅샷 하나를 그 주기 전체에 걸쳐 그린다.
  // 매번 새로 고친 예측은 실제 값에서 출발해 실제선과 겹쳐 보이므로, 고정된 예측 하나와 실제 소진 모양을 비교하게 한다.
  // 값은 당시 현재 한도 기준 사용률(%)이며, 기본 요금제 기준은 당시 배율로 환산한다. past 는 지금까지, future 는 지금 이후 구간이다.
  // 주기 시작은 초기화 시각 - 창 길이로 본다(첫 사용 때 시작하는 창도 초기화가 시작 + 창 길이로 정해진다).
  const baselineWindows = {five: {span: 5 * hour, lead: 30 * minute, every: hour}, week: {span: 7 * day, lead: 6 * hour, every: 6 * hour}};
  // 직전 스냅샷 대비 새 주기인가: 이전 초기화가 지났거나, 초기화가 간격 이상 뒤로 옮겨졌거나(작은 흔들림은 같은 주기),
  // 출발 사용률이 1%p 넘게 줄었을 때(같은 주기에서 사용률은 줄지 않으므로 조기 초기화). 기록기와 화면이 함께 쓴다.
  function cycleBreak(prev, snap, every) {
    const startOf = s => Array.isArray(s.points) && Array.isArray(s.points[0]) && finite(s.points[0][1]) ? s.points[0][1] : null;
    const a = startOf(prev), b = startOf(snap);
    return snap.at >= prev.reset || snap.reset - prev.reset >= every || a !== null && b !== null && b < a - 1;
  }
  // CSS cubic-bezier(x1, y1, x2, y2) 와 같은 이징. x(0..1)를 받아 가중치(0..1)를 돌려준다.
  function cubicBezier(x1, y1, x2, y2) {
    const at = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
    return x => {
      if (!(x > 0)) return 0;
      if (!(x < 1)) return 1;
      let lo = 0, hi = 1, t = x;
      for (let i = 0; i < 40; i++) {t = (lo + hi) / 2; if (at(t, x1, x2) < x) lo = t; else hi = t;}
      return at(t, y1, y2);
    };
  }
  const easings = {smooth: cubicBezier(.65, 0, .35, 1), linear: x => Math.min(1, Math.max(0, x)), late: cubicBezier(.9, 0, .95, .3)};
  const validSnapshot = snap => snap && finite(snap.at) && finite(snap.reset) && snap.reset > snap.at && Array.isArray(snap.points) && snap.points.length >= 2
    && snap.points.every((p, i) => Array.isArray(p) && finite(p[0]) && finite(p[1]) && p[1] >= 0 && p[1] <= 100 && (i === 0 || p[0] > snap.points[i - 1][0]));
  // 스냅샷의 예측선을 시각 t 에서 읽는다. 첫 점 이전은 첫 값, 마지막 점 이후는 마지막 값을 유지한다.
  function snapshotValue(snap, t) {
    const pts = snap.points;
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (t - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
    return pts.at(-1)[1];
  }
  // 예측 시각 S 에 기록돼 있던 예측: S 이전 마지막 스냅샷 A 와 다음 스냅샷 B 를 같은 주기 안에서만 베지어 가중치로 섞는다.
  // 주기가 바뀌는 경계는 섞지 않는다. 이 주기에 아직 스냅샷이 없거나 S 가 A 의 초기화 이후면 선이 없다.
  // 반환 모양은 baseline() 과 같고 blended 는 저장된 두 예측을 섞은 보정값인지 나타낸다.
  function asOf(snapshots, at, {now, domain, basis = 'current', window = 'five', ease = easings.smooth} = {}) {
    const rule = baselineWindows[window];
    if (!Array.isArray(snapshots) || !finite(now) || !finite(at) || !rule) return [];
    const valid = snapshots.filter(validSnapshot).sort((a, b) => a.at - b.at);
    let index = -1;
    for (let i = 0; i < valid.length; i++) if (valid[i].at <= at) index = i;
    if (index < 0) return [];
    const A = valid[index], next = valid[index + 1];
    if (at >= A.reset || at >= now) return [];
    const sameCycle = !!next && !cycleBreak(A, next, rule.every), tau = sameCycle ? Math.min(1, Math.max(0, (at - A.at) / (next.at - A.at))) : 0, w = tau > 0 ? ease(tau) : 0;
    const lastA = A.points.at(-1)[0], limit = sameCycle && w > 0 ? Math.max(lastA, next.points.at(-1)[0]) : lastA;
    const end = Math.min(A.reset, next && !sameCycle ? next.at : Infinity, limit);
    if (!(end > at)) return [];
    const value = time => w > 0 ? (1 - w) * snapshotValue(A, time) + w * snapshotValue(next, time) : snapshotValue(A, time);
    const times = [...new Set([at, ...A.points.map(p => p[0]), ...(w > 0 ? next.points.map(p => p[0]) : []), end].filter(t => t >= at && t <= end))].sort((a, b) => a - b);
    const factor = basis === 'base' && finite(A.mult) && A.mult > 0 ? A.mult : 1, point = (time, v) => ({time, value: v, y: v * factor});
    const full = times.map(time => point(time, Math.min(100, value(time))));
    if (full.length < 2) return [];
    if (Array.isArray(domain) && (full.at(-1).time < domain[0] || full[0].time > domain[1])) return [];
    const past = full.filter(p => p.time <= now), future = full.filter(p => p.time >= now), cut = full.findIndex(p => p.time > now);
    if (cut > 0 && full[cut - 1].time < now) {
      const a = full[cut - 1], b = full[cut], v = a.value + (b.value - a.value) * (now - a.time) / (b.time - a.time);
      past.push(point(now, v)); future.unshift(point(now, v));
    }
    return [{at, reset: A.reset, start: A.reset - rule.span, known: basis !== 'base' || factor !== 1 || A.mult === 1, blended: tau > 0 && tau < 1, past: past.length >= 2 ? past : [], future: future.length >= 2 ? future : []}];
  }
  // 예측 시각을 고를 수 있는 범위: 가장 오래된 스냅샷(또는 지금-7일)부터 가장 최근 스냅샷까지.
  function asOfRange(lists, now, span = 7 * day) {
    const times = lists.flat().filter(validSnapshot).map(s => s.at).filter(t => t < now);
    if (!times.length || !finite(now)) return null;
    const hi = Math.max(...times), lo = Math.min(hi, Math.max(Math.min(...times), now - span));
    return {lo, hi};
  }
  function baseline(snapshots, {now, domain, basis = 'current', window = 'five'} = {}) {
    const rule = baselineWindows[window];
    if (!Array.isArray(snapshots) || !finite(now) || !rule) return [];
    const valid = snapshots.filter(snap => snap && finite(snap.at) && finite(snap.reset) && snap.reset > snap.at && Array.isArray(snap.points) && snap.points.length >= 2
      && snap.points.every((p, i) => Array.isArray(p) && finite(p[0]) && finite(p[1]) && p[1] >= 0 && p[1] <= 100 && (i === 0 || p[0] > snap.points[i - 1][0]))).sort((a, b) => a.at - b.at);
    const cycles = [];
    for (const snap of valid) {
      const cycle = cycles.at(-1);
      if (!cycle || cycleBreak(cycle.list.at(-1), snap, rule.every)) cycles.push({list: [snap]}); else cycle.list.push(snap);
    }
    const lines = [];
    for (const [index, cycle] of cycles.entries()) {
      const snap = cycle.list.find(s => s.at - (s.reset - rule.span) >= rule.lead);
      if (!snap || snap.at >= now) continue;
      // 다음 주기가 예정보다 일찍 시작했으면 그 시작에서 끊는다.
      const end = Math.min(snap.reset, cycles[index + 1]?.list[0].at ?? Infinity);
      const factor = basis === 'base' && finite(snap.mult) && snap.mult > 0 ? snap.mult : 1, point = (time, value) => ({time, value, y: value * factor});
      const full = [];
      for (const [time, value] of snap.points) {
        if (time <= end) {full.push(point(time, value)); continue;}
        const prev = full.at(-1);
        if (prev) full.push(point(end, prev.value + (value - prev.value) * (end - prev.time) / (time - prev.time)));
        break;
      }
      if (full.length < 2) continue;
      if (Array.isArray(domain) && (full.at(-1).time < domain[0] || full[0].time > domain[1])) continue;
      const past = full.filter(p => p.time <= now), future = full.filter(p => p.time >= now), cut = full.findIndex(p => p.time > now);
      if (cut > 0 && full[cut - 1].time < now) {
        const a = full[cut - 1], b = full[cut], v = a.value + (b.value - a.value) * (now - a.time) / (b.time - a.time);
        past.push(point(now, v)); future.unshift(point(now, v));
      }
      lines.push({at: snap.at, reset: snap.reset, start: snap.reset - rule.span, known: basis !== 'base' || factor !== 1 || snap.mult === 1, past: past.length >= 2 ? past : [], future: future.length >= 2 ? future : []});
    }
    return lines;
  }
  return {revision: 3, settings, estimate, accountStart, denoise, provider, present, remaining, summary, curve, baseline, cycleBreak, asOf, asOfRange, cubicBezier, easings};
});
