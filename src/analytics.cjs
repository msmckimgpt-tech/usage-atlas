'use strict';

// Copyright (c) 2026 jisoq; design adapted from https://github.com/jisoq/Codexon.
// See licenses/Codexon-LICENSE.txt. Usage Atlas implementation is independently written.

const providerCatalog = require('../media/provider-focus.js');
const {quotaData, matchCalls} = require('./quota-match.cjs');
const {priceCall, catalog} = require('./pricing.cjs');
const {buildConversion, callConverter, validConversion, scopeKey} = require('./credit-conversion.cjs');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => finite(value) && value >= 0 && Number.isSafeInteger(value);
const text = value => typeof value === 'string' ? value.slice(0, 1000) : null;
const MAX_GAP = 1800000;
const numericFields = ['input', 'cached', 'cacheWrite5m', 'cacheWrite1h', 'output', 'reasoning'];
const latencyNote = '로컬 로그의 시작·완료 시각은 턴 또는 로컬 이벤트의 시각일 수 있습니다. 호출별 타임스탬프 출처가 확인되지 않아 API 호출 지연으로 계산하지 않습니다.';
const canonicalFields = [
  'id'
, 'provider'
, 'account'
, 'accountSource'
, 'homeKey'
, 'time'
, 'startedAt'
, 'completedAt'
, 'sessionId'
, 'parentSessionId'
, 'turnId'
, 'requestId'
, 'compactionEpoch'
, 'resetEpoch'
, 'contextTokens'
, 'contextWindowTokens'
, 'project'
, 'projectName'
, 'model'
, 'effort'
, 'mode'
, ...numericFields
, 'completionState'
, 'provenance'
, 'missingFields'
];

function safe(value, depth = 0, seen = new Set()) {
  if (value == null) return null;
  if (typeof value === 'number') return finite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth > 6 || seen.has(value)) return null;
  seen.add(value);
  const result = Array.isArray(value)
    ? value.slice(0, 50).map(item => safe(item, depth + 1, seen))
    : Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, safe(item, depth + 1, seen)]));
  seen.delete(value);
  return result;
}

function projectName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC');
  return normalized && normalized === normalized.trim() && normalized !== '.' && normalized !== '..' && Array.from(normalized).length <= 80
    && !/[\\/:\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(normalized) ? normalized : null;
}

function projectMetadata(source, selected, displayed) {
  const ids = [...new Set(source.map(row => row.project).filter(id => typeof id === 'string' && /^[a-f\d]{64}$/i.test(id)))].sort();
  const options = ids.slice(0, 50);
  if (ids.includes(selected) && !options.includes(selected)) options[options.length - 1] = selected;
  const needed = new Set([...options, ...displayed.map(row => row.project)]);
  const names = new Map();
  for (const row of source) {
    const name = projectName(row.projectName);
    if (!name || !needed.has(row.project) || typeof row.project !== 'string' || !/^[a-f\d]{64}$/i.test(row.project)) continue;
    if (!names.has(row.project)) names.set(row.project, name);
    else if (names.get(row.project) !== name) names.set(row.project, null);
  }
  return {
    projectLabels: Object.fromEntries([...names].filter(([, name]) => name !== null))
  , filterOptions: {project: options}
  , filterOptionCounts: {project: ids.length}
  };
}

function bounded(items, knownCount = items.length, limit = 50) {
  return {items: items.slice(0, limit), totalCount: items.length, knownCount, limit, truncated: items.length > limit};
}

function observedTimes(times) {
  const unique = [...new Set(times)].sort((a, b) => a - b);
  return {observedTimes: unique.length <= 50 ? unique : Array.from({length: 50}, (_, index) => unique[Math.round(index * (unique.length - 1) / 49)]), observedTimeCount: unique.length};
}

function sumKnown(rows, field) {
  const values = rows.map(row => row[field]).filter(count);
  return {
    value: rows.length && values.length === rows.length ? values.reduce((a, b) => a + b, 0) : null
  , knownSum: values.reduce((a, b) => a + b, 0)
  , knownCount: values.length
  };
}

function cacheStats(rows) {
  const valid = rows.filter(row => count(row.input) && row.input > 0 && count(row.cached) && row.cached <= row.input);
  const input = valid.reduce((sum, row) => sum + row.input, 0);
  const cached = valid.reduce((sum, row) => sum + row.cached, 0);
  return {input, cached, ratio: input > 0 ? cached / input : null, validSampleCount: valid.length};
}

function stats(values) {
  const list = values.filter(finite).sort((a, b) => a - b);
  const middle = Math.floor(list.length / 2);
  return {
    mean: list.length ? list.reduce((a, b) => a + b, 0) / list.length : null
  , median: list.length ? list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2 : null
  , p90: list.length ? list[Math.ceil(list.length * 0.9) - 1] : null
  };
}

function totals(rows, includeTokenCoverage = false) {
  const priced = rows.filter(row => finite(row.costUsd));
  const knownCostUsd = priced.reduce((sum, row) => sum + row.costUsd, 0);
  const cache = cacheStats(rows);
  return {
    callCount: rows.length
  , pricedCallCount: priced.length
  , knownCostUsd
  , costUsd: rows.length > 0 && priced.length === rows.length ? knownCostUsd : null
  , input: sumKnown(rows, 'input').value
  , cached: sumKnown(rows, 'cached').value
  , output: sumKnown(rows, 'output').value
  , cacheRatio: cache.ratio
  , ...(includeTokenCoverage ? {tokenCoverage: Object.fromEntries(numericFields.map(field => [field, sumKnown(rows, field)]))} : {})
  };
}

function groups(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const id = key(row);
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(row);
  }
  return result;
}

const sessionKey = row => JSON.stringify([row.provider, row.account, row.homeKey, row.sessionId]);
const requestKey = row => JSON.stringify([sessionKey(row), row.turnId ?? row.id]);
const comparisonKey = row => JSON.stringify([row.model ?? 'unknown', row.effort ?? 'unknown', row.mode ?? 'unknown']);
const rank = (a, b) => b.knownCostUsd - a.knownCostUsd || b.callCount - a.callCount || String(a.id).localeCompare(String(b.id));
const callTime = row => finite(row.time) ? row.time : finite(row.completedAt) ? row.completedAt : row.startedAt;
const latestTime = rows => rows.reduce((latest, row) => finite(callTime(row)) ? Math.max(latest ?? -Infinity, callTime(row)) : latest, null);
const recentRank = (a, b) => (b.lastObservedAt ?? -Infinity) - (a.lastObservedAt ?? -Infinity) || rank(a, b);

function keepTop(items, item, compare = rank, limit = 50) {
  if (items.length === limit && compare(item, items.at(-1)) >= 0) return;
  items.push(item);
  items.sort(compare);
  if (items.length > limit) items.pop();
}

function band(value, kind) {
  if (!finite(value)) return 'unknown';
  if (kind === 'input') return value < 10000 ? '0-10k' : value < 100000 ? '10k-100k' : value < 200000 ? '100k-200k' : '200k+';
  return value === 0 ? '0%' : value < 0.5 ? '0-50%' : value < 0.9 ? '50-90%' : '90-100%';
}

function inBand(value, selection, kind) {
  if (selection == null || selection === '' || selection === 'all') return true;
  if (typeof selection === 'string') return band(value, kind) === selection;
  if (!finite(value)) return false;
  const min = Array.isArray(selection) ? selection[0] : selection.min;
  const max = Array.isArray(selection) ? selection[1] : selection.max;
  return (!finite(min) || value >= min) && (!finite(max) || value < max);
}

function filtered(row, filters) {
  for (const field of ['project', 'sessionId', 'turnId', 'model', 'effort', 'mode']) {
    const selected = filters[field];
    if (selected != null && selected !== '' && selected !== 'all' && (row[field] ?? 'unknown') !== selected) return false;
  }
  const ratio = count(row.input) && row.input > 0 && count(row.cached) && row.cached <= row.input ? row.cached / row.input : null;
  return inBand(row.input, filters.inputBand, 'input') && inBand(ratio, filters.cacheBand, 'cache');
}

function exclusionRanges(exclusions, provider, account, window, start, end) {
  const relevant = exclusions.filter(item => item && item.provider === provider && item.account === account && item.window === window);
  const valid = item => finite(item.start) && finite(item.end) && item.end > item.start;
  const active = relevant.filter(item => item.restoredAt == null && valid(item));
  const ranges = [];
  for (const item of active.map(item => ({start: Math.max(start, item.start), end: Math.min(end, item.end)})).filter(item => item.start < item.end).sort((a, b) => a.start - b.start)) {
    const previous = ranges.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else ranges.push({...item});
  }
  return {
    items: relevant.map(item => ({...safe(item), id: text(item.id), exclusionId: text(item.id), active: item.restoredAt == null && valid(item)}))
  , activeCount: active.length
  , ranges
  };
}

function overlaps(start, end, ranges) {
  return ranges.some(range => start === end ? start >= range.start && start < range.end : start < range.end && end > range.start);
}

function excludedCall(row, ranges) {
  const time = callTime(row);
  const start = finite(row.startedAt) ? row.startedAt : time;
  const end = finite(row.completedAt) ? row.completedAt : time;
  return overlaps(Math.min(start, end), Math.max(start, end), ranges);
}

function aggregateRow(id, rows) {
  const starts = rows.map(row => row.startedAt).filter(finite);
  const ends = rows.map(row => row.completedAt).filter(finite);
  const project = rows[0]?.project ?? null;
  const names = [...new Set(rows.filter(row => row.project === project).map(row => projectName(row.projectName)).filter(Boolean))];
  return {
    id
  , ...totals(rows)
  , lastObservedAt: latestTime(rows)
  , homeKey: rows[0]?.homeKey ?? null
  , project
  , projectName: names.length === 1 ? names[0] : null
  , startedAt: starts.length ? starts.reduce((a, b) => Math.min(a, b)) : null
  , completedAt: ends.length ? ends.reduce((a, b) => Math.max(a, b)) : null
  , models: [...new Set(rows.map(row => row.model ?? 'unknown'))].slice(0, 50)
  , efforts: [...new Set(rows.map(row => row.effort ?? 'unknown'))].slice(0, 50)
  , modes: [...new Set(rows.map(row => row.mode ?? 'unknown'))].slice(0, 50)
  };
}

function sessionRows(rows) {
  const nodes = new Map();
  for (const [id, list] of groups(rows.filter(row => row.sessionId != null), sessionKey)) {
    const first = list[0];
    const parents = new Set(list.map(row => row.parentSessionId ?? null));
    const parent = first.parentSessionId == null || parents.size > 1 ? null : sessionKey({...first, sessionId: first.parentSessionId});
    nodes.set(id, {id, first, own: {id, ...totals(list), lastObservedAt: latestTime(list)}, rows: list, parent, children: [], pending: 0, descendants: {count: 0, priced: 0, cost: 0}, conflict: parents.size > 1});
  }
  for (const node of nodes.values()) {
    if (node.parent && nodes.has(node.parent)) nodes.get(node.parent).children.push(node.id);
  }
  const ready = [];
  for (const node of nodes.values()) {
    node.pending = node.children.length;
    if (!node.pending) ready.push(node);
  }
  // Leaf-to-root accumulation avoids rescanning every call for every ancestor.
  for (let index = 0; index < ready.length; index++) {
    const node = ready[index];
    node.resolved = true;
    const parent = nodes.get(node.parent);
    if (!parent) continue;
    parent.descendants.count += node.own.callCount + node.descendants.count;
    parent.descendants.priced += node.own.pricedCallCount + node.descendants.priced;
    parent.descendants.cost += node.own.knownCostUsd + node.descendants.cost;
    parent.pending--;
    if (!parent.pending) ready.push(parent);
  }
  const top = [];
  let knownCount = 0;
  for (const node of nodes.values()) {
    if (node.own.costUsd != null) knownCount++;
    keepTop(top, node, (a, b) => recentRank(a.own, b.own));
  }
  const items = top.map(node => {
    const {first, own} = node;
    let descendants = node.descendants;
    // Corrupt cyclic parent metadata is finite and explicitly marked, never recursive.
    if (!node.resolved) {
      const visited = new Set([node.id]);
      const frontier = [...node.children];
      descendants = {count: 0, priced: 0, cost: 0};
      for (let index = 0; index < frontier.length; index++) {
        const child = nodes.get(frontier[index]);
        if (!child || visited.has(child.id)) continue;
        visited.add(child.id);
        descendants.count += child.own.callCount;
        descendants.priced += child.own.pricedCallCount;
        descendants.cost += child.own.knownCostUsd;
        frontier.push(...child.children);
      }
    }
    return {
      ...aggregateRow(node.id, node.rows)
    , sessionId: first.sessionId
    , parentSessionId: first.parentSessionId ?? null
    , homeKey: first.homeKey ?? null
    , ownCostUsd: own.costUsd
    , descendantCostUsd: descendants.count && descendants.priced === descendants.count ? descendants.cost : null
    , descendantKnownCostUsd: descendants.cost
    , descendantCallCount: descendants.count
    , relationship: node.conflict ? 'conflict' : !node.resolved ? 'cycle' : first.parentSessionId ? nodes.has(node.parent) ? 'child' : 'orphan' : 'root'
    };
  });
  return {items, totalCount: nodes.size, knownCount, limit: 50, truncated: nodes.size > 50};
}

function requestRows(rows) {
  const byRequest = groups(rows, requestKey);
  const top = [];
  let knownCount = 0;
  for (const [id, list] of byRequest) {
    const own = {id, ...totals(list), lastObservedAt: latestTime(list)};
    if (own.costUsd != null) knownCount++;
    keepTop(top, {id, rows: list, ...own}, recentRank);
  }
  const items = top.map(({id, rows: list}) => ({...aggregateRow(id, list), turnId: list[0].turnId ?? null, sessionId: list[0].sessionId ?? null, requestId: list[0].turnId ?? list[0].id ?? null}));
  return {items, totalCount: byRequest.size, knownCount, limit: 50, truncated: byRequest.size > 50};
}

function cycleCalls(rows, cycles) {
  const byCycle = new Map();
  for (const row of rows) {
    const time = callTime(row);
    let low = 0;
    let high = cycles.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cycles[middle].start <= time) low = middle + 1;
      else high = middle;
    }
    const cycle = cycles[low - 1];
    if (!cycle || time > cycle.end) continue;
    if (!byCycle.has(cycle.id)) byCycle.set(cycle.id, []);
    byCycle.get(cycle.id).push(row);
  }
  return byCycle;
}

function comparisons(rows) {
  return [...groups(rows, comparisonKey)].map(([id, list]) => {
    // Canonical timestamps lack per-request timing provenance and may describe a turn.
    const priced = list.filter(row => finite(row.costUsd));
    const cache = cacheStats(list);
    return {
      id
    , model: list[0].model ?? 'unknown'
    , effort: list[0].effort ?? 'unknown'
    , mode: list[0].mode ?? 'unknown'
    , sampleCount: list.length
    , pricedSampleCount: priced.length
    , cacheSampleCount: cache.validSampleCount
    , latencySampleCount: 0
    , latencyUnknownSampleCount: list.length
    , cost: stats(priced.map(row => row.costUsd))
    , latencyMs: stats([])
    , latencyIssue: 'unverified-request-timestamp-provenance'
    , latencyLabel: 'API 호출 지연 미확인'
    , latencyNotes: [latencyNote]
    , cacheRatio: cache.ratio
    , smallSample: priced.length < 10 || cache.validSampleCount < 10
    , label: '비용·캐시 관측 표본 비교이며 품질·인과관계를 판단하지 않습니다. API 호출 지연은 미확인입니다.'
    };
  }).sort((a, b) => b.sampleCount - a.sampleCount || a.id.localeCompare(b.id));
}

function cacheSuspicions(rows, window) {
  const suspicions = [];
  const key = row => JSON.stringify([sessionKey(row), comparisonKey(row), window]);
  for (const [id, list] of groups(rows, key)) {
    let run = [];
    for (const row of [...list].sort((a, b) => callTime(a) - callTime(b))) {
      const previous = run.at(-1);
      const compacted = row.compaction === true || row.provenance?.compaction === true || row.provenance?.contextReset === true
        || previous && ['compactionEpoch', 'resetEpoch'].some(field => finite(row[field]) && finite(previous[field]) && row[field] !== previous[field]);
      if (compacted || previous && (callTime(row) - callTime(previous) > MAX_GAP || row.input < previous.input * 0.5)) run = [];
      if (!count(row.input) || row.input <= 0 || !count(row.cached) || row.cached > row.input || !row.model || row.model === 'unknown' || !row.effort || row.effort === 'unknown' || !['Standard', 'Fast', 'Ultrafast'].includes(row.mode)) {run = []; continue;}
      run.push(row);
      if (run.length < 6) continue;
      const before = cacheStats(run.slice(-6, -3));
      const after = cacheStats(run.slice(-3));
      if (before.ratio >= 0.5 && after.ratio <= before.ratio - 0.3 && run.slice(-3).every(item => item.cached / item.input < before.ratio - 0.3)) {
        suspicions.push({
          id: `${id}/${callTime(row)}`
        , sessionId: row.sessionId
        , model: row.model
        , effort: row.effort
        , mode: row.mode
        , window
        , start: callTime(run.at(-3))
        , end: callTime(row)
        , beforeRatio: before.ratio
        , afterRatio: after.ratio
        , sampleCount: 6
        , kind: 'sustained-cache-degradation-suspicion'
        , note: '같은 조건의 직전 3건과 후속 3건의 관측 차이에 따른 의심 표시이며 캐시 장애를 단정하지 않습니다.'
        });
        run = [];
      }
    }
  }
  return bounded(suspicions.sort((a, b) => b.end - a.end));
}

function estimate(rows, intervals, sourceCallCount, eligibleCallCount, includePlanGroups = true) {
  const cohorts = groups(intervals.filter(item => item.delta > 0), item => JSON.stringify([item.plan, item.mult]));
  const mixedCapacity = cohorts.size > 1;
  const matched = rows.filter(row => row.matchState === 'matched');
  const provisional = rows.filter(row => row.matchState === 'provisional');
  const priced = matched.filter(row => finite(row.costUsd));
  const knownCostUsd = priced.reduce((sum, row) => sum + row.costUsd, 0);
  const quotaDelta = intervals.reduce((sum, item) => sum + item.delta, 0);
  const value = !mixedCapacity && quotaDelta > 0 && priced.length ? knownCostUsd / quotaDelta * 100 : null;
  const notes = [
    '모드 미확인 호출은 Standard로 가정하며 계산된 비용·크레딧·구독 사용률은 추정값입니다.'
  , '로컬에서 관측·가격 확인·시간 대응이 된 호출 비용 / 계정 전체의 연속 관측 양수 사용률 증가분 × 100입니다.'
  , '다른 기기·웹·클라우드 작업은 로컬 호출에 없을 수 있으며 계정 전체 사용률은 선택한 프로젝트·모델만의 사용률이 아닙니다.'
  , '실제 청구액·크레딧·공식 한도·미래 예측·통계적 신뢰구간이 아닙니다. 민감도는 가정 변경 시나리오입니다.'
  , '시작 시각 미확인 호출은 잠정 대응으로 분리하며 본 계산에서 제외합니다. 리셋 직후 추정 증가·공백·감소 복구분은 분모에서 제외합니다.'
  ];
  if (mixedCapacity) notes.push('요금제·배율이 다른 구간은 하나의 100%로 환산하지 않습니다. 주기별로 확인하세요.');
  const sensitivity = [];
  if (value != null) {
    for (const factor of [0.8, 1, 1.2]) sensitivity.push({id: `quota-${factor}`, assumption: `관측 사용률 증가분 ${factor}배`, quotaDelta: quotaDelta * factor, valueUsdPer100Pct: knownCostUsd / (quotaDelta * factor) * 100, kind: 'scenario-not-confidence-interval'});
  }
  const provisionalPriced = provisional.filter(row => finite(row.costUsd));
  if (!mixedCapacity && quotaDelta > 0 && provisionalPriced.length) sensitivity.push({id: 'include-provisional', assumption: '시작 시각 미확인 호출도 포함', quotaDelta, valueUsdPer100Pct: (knownCostUsd + provisionalPriced.reduce((sum, row) => sum + row.costUsd, 0)) / quotaDelta * 100, kind: 'scenario-not-confidence-interval'});
  const planGroups = [];
  if (includePlanGroups) {
    const intervalCohorts = new Map(intervals.map(item => [item.id, JSON.stringify([item.plan, item.mult])]));
    const callsByCohort = groups(rows.filter(row => intervalCohorts.has(row.quotaIntervalId)), row => intervalCohorts.get(row.quotaIntervalId));
    for (const [id, cohortIntervals] of [...cohorts].slice(0, 50)) {
      const subset = callsByCohort.get(id) || [];
      const scoped = estimate(subset, cohortIntervals, null, null, false);
      planGroups.push({
        id
      , plan: cohortIntervals[0].plan
      , mult: cohortIntervals[0].mult
      , scope: 'plan-capacity-cohort'
      , status: scoped.status
      , valueUsdPer100Pct: scoped.valueUsdPer100Pct
      , knownCostUsd: scoped.knownCostUsd
      , quotaDelta: scoped.quotaDelta
      , matchedCallCount: scoped.matchedCallCount
      , provisionalCallCount: scoped.provisionalCallCount
      , pricedCallCount: scoped.pricedCallCount
      , matchedPricedCallCount: scoped.matchedPricedCallCount
      , intervalCount: scoped.intervalCount
      , sensitivity: scoped.sensitivity
      , notes: [...scoped.notes, '이 값은 표시된 요금제·배율의 양수 관측 구간과 그 구간에 대응한 호출만의 환산값입니다.']
      });
    }
  }
  return {
    status: mixedCapacity ? 'mixed-capacity' : value == null ? 'insufficient-observations' : 'partial-local-observation'
  , kind: 'observed-cost-equivalent-per-100pct'
  , valueUsdPer100Pct: value
  , knownCostUsd
  , quotaDelta
  , capacityCohortCount: cohorts.size
  , ...(includePlanGroups ? {planGroups, planGroupCount: cohorts.size, planGroupLimit: 50, planGroupsTruncated: cohorts.size > 50} : {})
  , quotaScope: 'account-wide'
  , costScope: 'matched-local-calls'
  , matchedCallCount: matched.length
  , unmatchedCallCount: rows.filter(row => row.matchState === 'unmatched').length
  , provisionalCallCount: provisional.length
  , sourceCallCount
  , eligibleCallCount
  , pricedCallCount: rows.filter(row => finite(row.costUsd)).length
  , matchedPricedCallCount: priced.length
  , accountAssumedCallCount: rows.filter(row => row.accountSource === 'local-root-assumption').length
  , intervalCount: intervals.length
  , sensitivity
  , notes
  };
}

// Host calls this pure entry point only when the graph-click modal requests data.
function analyze(options = {}) {
  const report = buildReport(options);
  if (providerCatalog.isAntigravity(options.provider)) {
    report.quotaOnly = true;
    const {provider, account = report.summary.account, window = 'week', records = []} = options;
    const rows = records.filter(row => row.provider === provider && row.account === account && row.time >= report.summary.start && row.time < report.summary.end && row.windows?.[window]);
    report.observations = {items: rows.slice().sort((a, b) => b.time - a.time).slice(0, 100).map(row => ({time: row.time, used: row.windows[window].used, reset: row.windows[window].reset})), totalCount: rows.length, limit: 100, truncated: rows.length > 100};
    for (const target of [report.summary, report.coverage]) for (const key of Object.keys(target)) if (/^callCount$|CallCount$|^(?:input|cached|output|cacheRatio|sessionCount|requestCount|costUsd|knownCostUsd)$/.test(key)) target[key] = null;
  }
  return report;
}

module.exports = {analyze};

function buildReport(options) {
  const {
    provider = 'codex'
  , window = 'week'
  , calls = []
  , records = []
  , capacities = []
  , coverage = {}
  , exclusions = []
  , diagnostics = null
  , now = Date.now()
  } = options;
  const notes = ['호출 수의 분모는 선택 기간에서 색인된 로컬 호출입니다. 아직 읽지 못했거나 해석할 수 없는 원본의 전체 호출 수를 의미하지 않습니다.'];
  if (coverage.partial || coverage.limited || coverage.cacheWriteFailed || coverage.malformedLines > 0 || coverage.oversizedLines > 0 || coverage.unavailableFiles > 0) notes.push('수집 공백·해석 실패·제한된 원본이 있어 전체 원본 호출 수와 완전한 비율은 확인할 수 없습니다.');
  if (providerCatalog.isAntigravity(provider)) notes.push('Antigravity는 그룹별 한도 관측만 제공합니다. 호출·토큰·대화 및 추가 크레딧 소비는 확인할 수 없습니다.');
  const clock = finite(now) ? now : Date.now();
  const cursorTime = finite(options.cursorTime) ? options.cursorTime : finite(options.time) ? options.time : clock;
  const end = finite(options.end) ? options.end : cursorTime + 1;
  const start = finite(options.start) ? options.start : end - (window === 'five' ? 18000000 : 604800000);
  const validRange = start < end && ['five', 'week'].includes(window) && providerCatalog.valid(provider);
  if (!validRange) notes.push('지원하지 않는 공급자·사용률 창 또는 잘못된 시간 범위입니다.');
  const providerRecords = records.filter(row => row?.provider === provider && finite(row.time) && row.time <= cursorTime).sort((a, b) => a.time - b.time);
  const identities = [...new Set(calls.filter(row => row?.provider === provider && row.account != null).map(row => row.account))];
  const account = options.account ?? providerRecords.at(-1)?.account ?? (identities.length === 1 ? identities[0] : null);
  if (!account) notes.push('계정을 확인할 수 없어 서로 다른 계정의 호출과 사용률을 연결하지 않습니다.');
  const source = validRange ? calls.filter(row => row?.provider === provider && finite(callTime(row)) && callTime(row) >= start && callTime(row) < end) : [];
  const selectedFilters = {...(options.filters || {}), ...Object.fromEntries(['project', 'sessionId', 'turnId', 'model', 'effort', 'mode', 'inputBand', 'cacheBand'].filter(key => options[key] != null).map(key => [key, options[key]]))};
  selectedFilters.sessionId ??= selectedFilters.session;
  const unique = new Map();
  let duplicateCount = 0;
  for (const [index, row] of source.entries()) {
    const key = JSON.stringify([row.provider, row.account, row.homeKey, row.id ?? `missing-${index}`]);
    if (unique.has(key)) {duplicateCount++; continue;}
    unique.set(key, row);
  }
  const accountSource = [...unique.values()].filter(row => account ? row.account === account : row.account == null);
  const eligible = accountSource.filter(row => filtered(row, selectedFilters));
  const before = eligible.map(row => priceCall(row, {assumeMode: 'Standard'}));
  const excluded = exclusionRanges(exclusions, provider, account, window, start, end);
  const quota = validRange && account ? quotaData(records, capacities, provider, account, window, start, end, clock) : {intervals: [], cycles: []};
  const intervals = quota.intervals.filter(item => !overlaps(item.start, item.end, excluded.ranges));
  const rows = matchCalls(before.filter(row => !excludedCall(row, excluded.ranges)), intervals);
  const summary = totals(rows, true);
  const sessions = sessionRows(rows);
  const requests = requestRows(rows);
  const compare = comparisons(rows);
  const missing = new Map();
  for (const row of rows) {
    for (const field of new Set([...(Array.isArray(row.missingFields) ? row.missingFields : []), ...numericFields.filter(key => !count(row[key]))])) missing.set(field, (missing.get(field) || 0) + 1);
  }
  if (rows.length) {
    missing.set('latencyMs', rows.length);
    notes.push(latencyNote);
  }
  const cache = cacheStats(rows);
  const calculatedEstimate = estimate(rows, intervals, source.length, eligible.length);
  calculatedEstimate.assumeMode = 'Standard';
  calculatedEstimate.assumedCallCount = rows.filter(row => row.priceAssumed).length;
  calculatedEstimate.missingModeCallCount = rows.filter(row => row.mode == null || row.mode === 'unknown').length;
  calculatedEstimate.unpricedCallCount = rows.filter(row => row.costUsd == null).length;
  const conversionModel = validConversion(options.conversionModel, scopeKey(capacities, exclusions)) ? options.conversionModel : buildConversion({records, capacities, calls, exclusions, now: clock});
  const convertCall = callConverter(conversionModel, records, capacities, window);
  const callDetails = [...rows].sort((a, b) => (callTime(b) ?? -Infinity) - (callTime(a) ?? -Infinity) || String(a.id).localeCompare(String(b.id))).slice(0, 100).map(row => {
    const canonical = Object.fromEntries(canonicalFields.map(field => [field, field === 'projectName' ? projectName(row[field]) : safe(row[field])]));
    const price = Object.fromEntries(Object.keys(row).filter(field => field.startsWith('price') || ['costUsd', 'costComponents', 'costKind', 'estimated', 'actualCredits', 'actualBillingUsd', 'reasoningCostUsd', 'purchasedCredits', 'subscriptionCredits', 'creditIssue', 'creditAssumed', 'creditCatalogVersion', 'matchState', 'quotaIntervalId'].includes(field)).map(field => [field, safe(row[field])]));
    return {...canonical, ...price, ...convertCall(row), inputBand: band(row.input, 'input'), cacheBand: band(count(row.input) && row.input > 0 && count(row.cached) && row.cached <= row.input ? row.cached / row.input : null, 'cache')};
  });
  const callsByCycle = cycleCalls(rows, quota.cycles);
  const intervalsByCycle = groups(intervals, item => item.cycleId);
  const cycleRows = quota.cycles.map(cycle => {
    const ownIntervals = intervalsByCycle.get(cycle.id) || [];
    const ownCalls = callsByCycle.get(cycle.id) || [];
    return {...cycle, ...totals(ownCalls), quotaDelta: ownIntervals.reduce((sum, item) => sum + item.delta, 0), events: cycle.events.slice(0, 50), eventCount: cycle.events.length};
  });
  const beforeTotal = totals(before);
  const times = source.map(callTime);
  const policy = catalog.policies[provider];
  const projectDetails = projectMetadata(accountSource, selectedFilters.project, [...sessions.items, ...requests.items, ...callDetails, ...compare]);
  return {
    summary: {
      provider
    , account
    , window
    , start
    , end
    , cursorTime
    , observedStart: times.length ? times.reduce((a, b) => Math.min(a, b)) : null
    , observedEnd: times.length ? times.reduce((a, b) => Math.max(a, b)) : null
    , sourceCallCount: source.length
    , eligibleCallCount: eligible.length
    , ...summary
    , sessionCount: sessions.totalCount
    , requestCount: requests.totalCount
    , filters: safe(selectedFilters)
    , project: selectedFilters.project ?? null
    , projectName: Object.hasOwn(projectDetails.projectLabels, selectedFilters.project ?? '') ? projectDetails.projectLabels[selectedFilters.project] : null
    }
  , ...projectDetails
  , coverage: {
      source: safe(coverage)
    , denominatorScope: 'indexed-local-calls-in-selected-range'
    , sourceCallCount: source.length
    , eligibleCallCount: eligible.length
    , pricedCallCount: summary.pricedCallCount
    , matchedCallCount: calculatedEstimate.matchedCallCount
    , unmatchedCallCount: calculatedEstimate.unmatchedCallCount
    , provisionalCallCount: calculatedEstimate.provisionalCallCount
    , duplicateCount
    , unknownAccountCallCount: source.filter(row => row.account == null).length
    , unknownTimeCallCount: calls.filter(row => row?.provider === provider && !finite(callTime(row))).length
    , accountAssumedCallCount: rows.filter(row => row.accountSource === 'local-root-assumption').length
    , ...observedTimes(records.filter(row => row?.provider === provider && row.account === account && finite(row.time) && row.time >= start && row.time < end && row.windows?.[window]).map(row => row.time))
    , missingFields: [...missing].map(([field, callCount]) => ({field, callCount})).slice(0, 50)
    , notes
    }
  , sessions
  , requests
  , calls: {...bounded(callDetails, summary.pricedCallCount, 100), totalCount: rows.length, truncated: rows.length > 100}
  , agents: {...sessions}
  , comparisons: bounded(compare, compare.filter(row => row.pricedSampleCount > 0).length)
  , cache: {...cache, suspicions: cacheSuspicions(rows, window).items, notes: ['캐시 비율은 읽기 토큰 합 / 입력 토큰 합입니다. 같은 세션·모델·effort·모드·창에서 지속된 변화만 의심 표시하며 압축·문맥 초기화·수집 공백 뒤에는 비교를 재시작합니다.']}
  , cycles: {
      ...bounded(cycleRows.sort((a, b) => b.end - a.end), cycleRows.filter(row => row.pricedCallCount > 0).length)
    , summary: {
        currentCount: cycleRows.filter(row => row.current).length
      , partialCount: cycleRows.filter(row => row.partial).length
      , completeCount: cycleRows.filter(row => !row.partial).length
      , rawQuotaDelta: cycleRows.reduce((sum, row) => sum + row.rawQuotaDelta, 0)
      , observedQuotaDelta: calculatedEstimate.quotaDelta
      }
    }
  , conversion: {kind: 'observed-subscription-equivalent', unit: provider === 'codex' ? 'credits' : 'USD', estimated: true, timingPolicy: conversionModel.timingPolicy, assumedDebitCount: provider === 'codex' ? conversionModel.assumedDebitCount : 0, cohorts: conversionModel.cohorts.filter(row => row.provider === provider && row.account === account && row.window === window).slice(0, 50), notes: ['구독 사용률이 증가하고 추가 차감이 없는 동일 계정·요금제·배율·기간의 호출로 자동 환산합니다.', '호출별 차감은 공식 요율의 추정치이며 실제 잔액 감소와 구분합니다. 속도 모드와 호출 근거가 없는 차감 구간은 Standard로 가정합니다. 시작 시각 미확인은 완료·관측 이벤트 시각으로 대응시키며 모두 추정입니다.', '외부 기기·웹 사용과 기록 누락 때문에 공식 구독 한도를 확정한 값이 아닙니다.']}
  , estimate: calculatedEstimate
  , exclusions: {
      ...bounded([...excluded.items].sort((a, b) => b.end - a.end || (b.createdAt ?? 0) - (a.createdAt ?? 0)))
    , activeCount: excluded.activeCount
    , ranges: excluded.ranges.slice(0, 50)
    , rangeCount: excluded.ranges.length
    , effects: {
        before: {callCount: beforeTotal.callCount, pricedCallCount: beforeTotal.pricedCallCount, knownCostUsd: beforeTotal.knownCostUsd}
      , after: {callCount: summary.callCount, pricedCallCount: summary.pricedCallCount, knownCostUsd: summary.knownCostUsd}
      , removedCallCount: beforeTotal.callCount - summary.callCount
      , removedKnownCostUsd: beforeTotal.knownCostUsd - summary.knownCostUsd
      , beforeQuotaDelta: quota.intervals.reduce((sum, item) => sum + item.delta, 0)
      , afterQuotaDelta: calculatedEstimate.quotaDelta
      }
    , notes: ['제외 구간은 합집합으로 분석에만 적용합니다. 원본 사용률은 변경하지 않으며 경계에 걸친 호출·사용률 관측 구간 전체를 제외합니다.']
    }
  , diagnostics: safe(diagnostics)
  , provenance: {
      catalogVersion: catalog.version
    , priceVerifiedAt: catalog.verifiedAt
    , pricePolicy: policy?.id ?? null
    , pricePolicyRef: policy ? `${catalog.version}/${policy.id}` : null
    , sources: safe(catalog.sources)
    , notes: [...(policy?.notes || []), '과거 호출에도 현재 검증한 카탈로그의 비교 요율을 적용하며 당시 청구 단가를 복원하지 않습니다.', '상위 50개·상세 호출 100개를 표시하며 합계와 알려진 표본 수는 전체 대상에서 계산합니다.']
    }
  };
}
