'use strict';
const crypto = require('node:crypto');
const {priceCall, creditCall, catalog} = require('./pricing.cjs');
const {quotaData, matchCalls} = require('./quota-match.cjs');
const GAP = 1800000;
const TIMING = 'completion-or-observation-event';
const PAID_RATIO_POLICY = 'observed-debits-including-gaps-pending-standard-v3';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const complete = row => ['completed', 'complete', 'success', 'succeeded'].includes(row.completionState);
const eventTime = row => !finite(row.startedAt) && (complete(row) || !row.completionState || row.completionState === 'unknown') ? [row.completedAt, row.provenance?.observedAt, row.time].find(finite) ?? null : null;
const positive = n => finite(n) && n > 0;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const native = row => row?.provider === 'codex' ? row.creditBalance : row?.spentUsd;
const cohortKey = (provider, account, plan, mult, window) => JSON.stringify([provider, account, plan, mult, window]);
const debitKey = (before, after) => hash([before.provider, before.account, before.plan, before.time, after.time, native(before), native(after), before.spendPeriod, after.spendPeriod]);
function sourceKey(records, capacities = [], exclusions = []) {
  const value = crypto.createHash('sha256').update(scopeKey(capacities, exclusions));
  for (const row of records) value.update(JSON.stringify(row)).update('\n');
  return value.digest('hex');
}
function scopeKey(capacities = [], exclusions = []) {return hash([catalog.version, TIMING, 'Standard', PAID_RATIO_POLICY, capacities, exclusions]);}
function currentRecords(records, provider) {
  const rows = records.filter(row => row.provider === provider).sort((a, b) => a.time - b.time);
  const account = rows.at(-1)?.account;
  let start = rows.length - 1;
  while (start >= 0 && rows[start].account === account) start--;
  return rows.slice(start + 1);
}
function pricedCall(row) {
  if (row.provider === 'codex') {
    const price = creditCall(row, {assumeMode: 'Standard'});
    return {...row, ...price, subscriptionUnits: price.subscriptionCredits, purchasedUnits: price.purchasedCredits};
  }
  const price = priceCall(row, {assumeMode: 'Standard'});
  return {...price, subscriptionUnits: price.costUsd, purchasedUnits: price.costUsd};
}
function modeRatio(row) {
  if (row.provenance?.modeConflict || row.provenance?.inputConflict || (row.tokenCategory ?? row.provenance?.tokenCategory ?? 'text') !== 'text' || row.missingFields?.some(field => /(?:tokenCategor|unsupported.*token)/i.test(field))) return null;
  const mode = !row.mode || row.mode === 'unknown' ? 'Standard' : row.mode;
  const policy = catalog.policies.codex, included = policy.modeMultipliers[mode], paid = policy.purchasedCreditMultipliers[mode];
  return positive(included) && positive(paid) ? included / paid : null;
}
function activeExclusion(exclusions, provider, account, window, start, end) {
  return exclusions.some(e => !e.restoredAt && e.provider === provider && e.account === account && e.window === window && e.start < end && e.end > start);
}
function matchGroups(rows, intervals) {
  const matched = matchCalls(rows.map(row => ({...row})), intervals), groups = new Map();
  const changes = new Int32Array(intervals.length + 1);
  const search = (value, field, strict) => {
    let low = 0, high = intervals.length;
    while (low < high) {const mid = (low + high) >>> 1; if (strict ? intervals[mid][field] <= value : intervals[mid][field] < value) low = mid + 1; else high = mid;}
    return low;
  };
  for (const row of matched) {
    const event = eventTime(row);
    if (finite(event)) {
      const candidate = intervals[search(event, 'end', false)];
      if (candidate && event > candidate.start && event <= candidate.end) {
        row.matchState = 'estimated-event'; row.quotaIntervalId = candidate.id; row.conversionTimingAssumed = true;
      } else continue;
    }
    if (row.quotaIntervalId) {
      if (!groups.has(row.quotaIntervalId)) groups.set(row.quotaIntervalId, []);
      groups.get(row.quotaIntervalId).push(row);
    }
    if (['matched', 'estimated-event'].includes(row.matchState)) continue;
    const end = row.completedAt ?? row.time, start = row.startedAt ?? end;
    if (!finite(end) || !finite(start)) continue;
    const first = search(Math.min(start, end), 'end', false), last = search(Math.max(start, end), 'start', true);
    if (first < last) {changes[first]++; changes[last]--;}
  }
  let count = 0;
  const tainted = new Set();
  for (let i = 0; i < intervals.length; i++) {count += changes[i]; if (count) tainted.add(intervals[i].id);}
  return {groups, tainted};
}
function buildConversion({records = [], capacities = [], calls = [], exclusions = [], now = Date.now(), revision = 0} = {}) {
  const cohorts = [], debitWeights = [], paidThrough = {};
  let assumedDebitCount = 0, ratioOnlyDebitCount = 0;
  const seen = new Set();
  const unique = calls.filter(row => {
    if (!row.id || !row.account) return false;
    const key = JSON.stringify([row.provider, row.account, row.homeKey, row.id]);
    if (seen.has(key)) return false; seen.add(key); return true;
  });
  for (const provider of ['codex', 'claude']) {
    const mine = currentRecords(records, provider), account = mine.at(-1)?.account;
    if (!account || !mine.length) continue;
    const rows = unique.filter(row => row.provider === provider && row.account === account && (eventTime(row) ?? row.completedAt ?? row.time) >= mine[0].time).map(pricedCall);
    const byTime = new Map(mine.map((row, i) => [row.time, {row, before: mine[i - 1]}]));
    for (const window of ['five', 'week']) {
      const quota = quotaData(mine, capacities, provider, account, window, mine[0].time, now + 1, now);
      const intervals = quota.intervals.filter(item => {
        const pair = byTime.get(item.end), before = pair?.before, after = pair?.row;
        if (!before || activeExclusion(exclusions, provider, account, window, item.start, item.end)) return false;
        const a = native(before), b = native(after);
        // Included and paid activity must not share a calibration denominator.
        return finite(a) && finite(b) && a === b && (provider !== 'claude' || before.spendPeriod === after.spendPeriod);
      });
      const {groups, tainted} = matchGroups(rows, intervals);
      const map = new Map();
      for (const interval of intervals) {
        const list = groups.get(interval.id) || [];
        if (tainted.has(interval.id) || !list.length || list.some(row => !['matched', 'estimated-event'].includes(row.matchState) || !finite(row.subscriptionUnits))) continue;
        const units = list.reduce((sum, row) => sum + row.subscriptionUnits, 0);
        if (!positive(units)) continue;
        const id = cohortKey(provider, account, interval.plan, interval.mult, window);
        let value = map.get(id);
        if (!value) {value = {id, provider, account, plan: interval.plan, mult: interval.mult, window, units: 0, quotaDelta: 0, callCount: 0, intervalCount: 0, assumedCallCount: 0, eventCallCount: 0, observedThrough: 0}; map.set(id, value);}
        value.units += units; value.quotaDelta += interval.delta; value.callCount += list.length; value.intervalCount++; value.assumedCallCount += list.filter(row => row.creditAssumed || row.priceAssumed).length; value.eventCallCount += list.filter(row => row.conversionTimingAssumed).length; value.observedThrough = Math.max(value.observedThrough, interval.end);
      }
      for (const value of map.values()) {value.unitsPerPercent = value.units / value.quotaDelta; cohorts.push(value);}
    }
    if (provider !== 'codex') continue;
    paidThrough[provider] = {account, time: mine.at(-1).time};
    const paidIntervals = [];
    for (let i = 1; i < mine.length; i++) {
      const before = mine[i - 1], after = mine[i];
      // 잔액 차감 총량과 구간 내 발생 시각의 연속성은 별도로 검증한다.
      if (after.time <= before.time || after.plan !== before.plan || !finite(native(before)) || !finite(native(after)) || native(before) <= native(after)) continue;
      paidIntervals.push({id: debitKey(before, after), start: before.time, end: after.time});
    }
    if (!paidIntervals.length) continue;
    const {groups: paidGroups, tainted: paidTainted} = matchGroups(rows, paidIntervals);
    for (const interval of paidIntervals) {
      const list = paidGroups.get(interval.id) || [];
      if (!paidTainted.has(interval.id) && !list.length) {
        // Unknown paid activity uses the same approved Standard assumption as unknown call modes.
        debitWeights.push([interval.id, 1]); assumedDebitCount++; continue;
      }
      if (paidTainted.has(interval.id) || !list.length || list.some(row => !['matched', 'estimated-event'].includes(row.matchState))) continue;
      const ratios = list.map(modeRatio);
      // 실측 차감량을 환산하므로 동일 모드 배율에서 모델별 토큰 단가는 상쇄된다.
      if (ratios.every(positive) && ratios.every(value => Math.abs(value - ratios[0]) < 1e-12)) {
        debitWeights.push([interval.id, ratios[0]]);
        if (list.some(row => !finite(row.subscriptionUnits) || !finite(row.purchasedUnits))) ratioOnlyDebitCount++;
        if (list.some(row => !row.mode || row.mode === 'unknown')) assumedDebitCount++;
        continue;
      }
      if (list.some(row => !finite(row.subscriptionUnits) || !finite(row.purchasedUnits))) continue;
      const included = list.reduce((sum, row) => sum + row.subscriptionUnits, 0), paid = list.reduce((sum, row) => sum + row.purchasedUnits, 0);
      if (positive(included) && positive(paid)) debitWeights.push([interval.id, included / paid]);
    }
  }
  return {schema: 5, paidThrough, timingPolicy: TIMING, ratioOnlyDebitCount, assumedDebitCount, assumedMode: 'Standard', catalogVersion: catalog.version, scopeKey: scopeKey(capacities, exclusions), measuredAt: now, revision, inputKey: sourceKey(records, capacities, exclusions), recordCount: records.length, cohorts, debitWeights};
}
function validConversion(value, key) {
  return value?.schema === 5 && !!value.paidThrough && typeof value.paidThrough === 'object' && !Array.isArray(value.paidThrough) && Object.entries(value.paidThrough).every(([provider, row]) => provider === 'codex' && /^[a-f0-9]{20}$/.test(row?.account || '') && finite(row?.time) && row.time >= 0 && row.time <= value.measuredAt) && value.timingPolicy === TIMING && Number.isSafeInteger(value.ratioOnlyDebitCount) && value.ratioOnlyDebitCount >= 0 && value.ratioOnlyDebitCount <= 120000 && Number.isSafeInteger(value.assumedDebitCount) && value.assumedDebitCount >= 0 && value.assumedDebitCount <= 120000 && value.assumedMode === 'Standard' && finite(value.measuredAt) && Number.isSafeInteger(value.recordCount) && value.recordCount >= 0 && value.recordCount <= 120000 && /^[a-f0-9]{64}$/.test(value.inputKey || '') && value.catalogVersion === catalog.version && value.scopeKey === key
    && Array.isArray(value.cohorts) && value.cohorts.length <= 240000 && value.cohorts.every(row => row && ['codex', 'claude'].includes(row.provider) && ['five', 'week'].includes(row.window) && typeof row.id === 'string' && row.id === cohortKey(row.provider, row.account, row.plan, row.mult, row.window) && positive(row.unitsPerPercent) && (row.mult === null || positive(row.mult)))
    && Array.isArray(value.debitWeights) && value.debitWeights.length <= 120000 && value.debitWeights.every(row => Array.isArray(row) && row.length === 2 && /^[a-f0-9]{64}$/.test(row[0]) && positive(row[1]) && row[1] <= 16);
}
function converter(model) {
  const cohorts = new Map((model?.cohorts || []).map(row => [row.id, row]));
  const weights = new Map(model?.debitWeights || []);
  return (provider, mine, windows, ledger) => {
    for (const window of ['five', 'week']) {
      let usage = 0, total = 0, usageKnown = true, totalKnown = true;
      let nativeUsage = 0, nativeTotal = 0, nativeUsageKnown = true, nativeTotalKnown = true;
      const points = windows[window], currentMult = points.at(-1)?.mult;
      for (let i = 0; i < mine.length; i++) {
        const row = mine[i], before = mine[i - 1], point = points[i], paid = ledger[i], credit = paid.credit;
        const cohort = cohorts.get(cohortKey(provider, row.account, row.plan, point.mult, window));
        const raw = paid.delta;
        const coverage = model?.paidThrough?.[provider];
        const standardPending = provider === 'codex' && positive(raw) && coverage?.account === row.account && row.time > coverage.time;
        const ratio = !positive(raw) || provider === 'claude' ? 1 : cohort && before ? weights.get(debitKey(before, row)) ?? (standardPending ? 1 : null) : null;
        const samePlan = !before || before.plan === row.plan && points[i - 1].mult === point.mult;
        const converted = raw === 0 || i === 0 ? 0 : positive(raw) && samePlan && cohort && positive(ratio) ? raw * ratio / cohort.unitsPerPercent : null;
        const nativeDelta = finite(converted) ? converted : null;
        const delta = nativeDelta === 0 ? 0 : finite(nativeDelta) && positive(point.mult) && finite(nativeDelta * point.mult) ? nativeDelta * point.mult : null;
        if (!samePlan) {if (nativeUsage > 0) nativeUsageKnown = false; if (nativeTotal > 0) nativeTotalKnown = false;}
        if (i && positive(raw)) {
          if (finite(delta)) total += delta; else totalKnown = false;
          if (finite(nativeDelta)) nativeTotal += nativeDelta; else nativeTotalKnown = false;
        }
        if (credit.cycleStart) {usage = 0; usageKnown = true; nativeUsage = 0; nativeUsageKnown = true;}
        else if (positive(raw)) {
          if (finite(delta)) usage += delta; else usageKnown = false;
          if (finite(nativeDelta)) nativeUsage += nativeDelta; else nativeUsageKnown = false;
        }
        const currentUsage = positive(point.mult) && usageKnown ? usage / point.mult : nativeUsageKnown ? nativeUsage : null;
        const currentTotal = positive(currentMult) && totalKnown ? total / currentMult : nativeTotalKnown ? nativeTotal : null;
        point.creditEstimate = {
          standardPending
        , usage: finite(credit.usage) && usageKnown ? usage : null
        , delta: finite(credit.delta) ? delta : null
        , total: finite(credit.total) && totalKnown ? total : null
        , nativeUsage: finite(credit.usage) && finite(currentUsage) ? currentUsage : null
        , nativeDelta: finite(credit.delta) ? nativeDelta : null
        , nativeTotal: finite(credit.total) && finite(currentTotal) ? currentTotal : null
        , nativeTotalKind: positive(currentMult) && totalKnown ? 'calibrated' : nativeTotalKnown ? 'same-cohort' : null
        , usageContinuous: credit.usageContinuous && usageKnown
        , deltaContinuous: credit.deltaContinuous && finite(delta)
        , totalContinuous: credit.totalContinuous && totalKnown
        , nativeUsageContinuous: credit.usageContinuous && finite(currentUsage)
        , nativeDeltaContinuous: credit.deltaContinuous && finite(nativeDelta)
        , nativeTotalContinuous: credit.totalContinuous && finite(currentTotal)
        };
      }
    }
  };
}
function callConverter(model, records, capacities, window) {
  const providers = new Map(['codex', 'claude'].map(provider => [provider, currentRecords(records, provider)]));
  const cohorts = new Map((model?.cohorts || []).map(row => [row.id, row]));
  const capacityCache = new Map();
  return row => {
    const mine = providers.get(row.provider) || [];
    const event = eventTime(row), end = finite(event) ? event : row.completedAt, start = finite(event) ? event : row.startedAt;
    const result = {quotaPercent: null, quotaBasePercent: null, quotaConversionIssue: 'insufficient-observations'};
    if (!finite(start) || !finite(end) || end < start || !finite(event) && !complete(row)) return {...result, quotaConversionIssue: 'unverified-call-interval'};
    let low = 0, high = mine.length;
    while (low < high) {const mid = (low + high) >>> 1; if (mine[mid].time < end) low = mid + 1; else high = mid;}
    const after = mine[low], before = mine[low - 1];
    if (!after || !before || before.time > start || after.time - before.time > GAP || before.plan !== after.plan || after.account !== row.account) return result;
    const capacityKey = JSON.stringify([row.provider, row.account, after.plan, window]);
    let candidates = capacityCache.get(capacityKey);
    if (!candidates) {candidates = capacities.filter(c => c.provider === row.provider && c.account === row.account && c.window === window && c.plan === after.plan).sort((a, b) => a.time - b.time); capacityCache.set(capacityKey, candidates);}
    const mult = candidates.findLast(c => c.time <= after.time)?.mult ?? candidates[0]?.mult ?? null;
    const cohort = cohorts.get(cohortKey(row.provider, row.account, after.plan, mult, window));
    const units = row.provider === 'codex' ? row.subscriptionCredits : row.costUsd;
    if (!cohort || !finite(units)) return result;
    const percent = units / cohort.unitsPerPercent;
    if (!finite(percent)) return result;
    result.quotaTimingAssumed = finite(event); result.quotaCalibrationTimingAssumed = cohort.eventCallCount > 0;
    result.quotaPercent = percent; result.quotaBasePercent = positive(mult) && finite(percent * mult) ? percent * mult : null; result.quotaConversionIssue = null;
    return result;
  };
}
module.exports = {buildConversion, converter, callConverter, validConversion, scopeKey, sourceKey};
