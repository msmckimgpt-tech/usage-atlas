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
    const last = points.at(-1), cutoff = last.time - config.patternDays * day, through = recent.sampleStart ?? last.time - recent.lookbackMs;
    if (!config.patternDays || !['predicted', 'reset-first', 'inactive'].includes(recent.state) && recent.reason !== 'unobserved-growth' || last.reset - last.time > 7 * day || through <= cutoff) return recent;
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
    const historicalOnly = options.method === 'historical' || recent.reason === 'unobserved-growth';
    const pooled = new Map(); for (const bucket of buckets) merge(pooled, bucket);
    const globalRate = rateOf(pooled);
    if (historicalOnly && recent.reason === 'unobserved-growth' && globalRate === 0) return recent;
    if (!qualifiedSlots) return recent;
    // 관측이 없는 시간대는 최근 평균을 유지하고, 충분한 과거 패턴만 절반 반영한다.
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
    const last = points.at(-1), cutoff = last.time - config.patternDays * day, through = recent.sampleStart ?? last.time - recent.lookbackMs;
    if (!config.patternDays || !['predicted', 'reset-first', 'inactive'].includes(recent.state) && recent.reason !== 'unobserved-growth' || last.reset - last.time > 7 * day || through <= cutoff) return recent;
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
    if (!qualified(global) || global.activeMs === 0 && (currentRate > 0 || recent.reason === 'unobserved-growth')) return recent;
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
    if (!points.length || options.method === 'recent' && recent.reason !== 'unobserved-growth') return recent;
    return options.method === 'activity' ? activityPattern(points, recent, settings(options), options) : patternEstimate(points, recent, settings(options), options);
  }
  function accountStart(records, id, account, through) {
    let since = null;
    for (const row of records) if (row.provider === id && row.account !== account && row.time <= through && (since === null || row.time > since)) since = row.time;
    return since;
  }
  function provider(windows, options = {}) {
    const shared = {...options, slots: new Map()};
    return Object.fromEntries(['five', 'week'].map(window => {
      const learned = options.learning?.[window];
      const value = estimate(windows[window] || [], window, {...shared, method: learned?.method, archiveCells: options.archiveCells?.[window]});
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
    if (used !== null) {
      const remainingPercent = 100 - used, rounded = Math.round(remainingPercent * 10) / 10;
      return {...status, label: '초기화 잔여', text: (remainingPercent > 0 && rounded === 0 ? '<0.1' : '≈' + rounded) + '%', remainingPercent};
    }
    return {...status, label: '예상', text: '-'};
  }
  function curve(value, last, {mode = 'usage', basis = 'current'} = {}, now) {
    const status = present(value, now);
    if (!['predicted', 'reset-first'].includes(status.state) || mode === 'delta' || !last || last.time !== value.observedAt || last.value !== value.used || last.reset !== value.reset || !value.trajectory && (!finite(value.ratePerHour) || value.ratePerHour <= 0)) return null;
    const end = status.state === 'predicted' ? value.eta : value.reset;
    const rawEnd = status.state === 'predicted' ? 100 : atReset(value);
    const calibrated = finite(last.mult) && last.mult > 0, known = calibrated && (mode !== 'total' || last.cumulativeKnown !== false);
    const factor = basis === 'base' && (mode === 'total' ? known : calibrated) ? last.mult : 1;
    const start = mode === 'total' ? known ? last.cumulative / (basis === 'base' ? 1 : last.mult) : last.nativeCumulative : last.value * factor;
    const finish = mode === 'total' ? start + (rawEnd - value.used) * factor : rawEnd * factor;
    if (!finite(rawEnd) || !finite(start) || !finite(finish) || end <= value.observedAt) return null;
    const raw = value.trajectory || [{time: value.observedAt, value: value.used}, {time: end, value: rawEnd}];
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
  return {settings, estimate, accountStart, provider, present, remaining, summary, curve};
});
