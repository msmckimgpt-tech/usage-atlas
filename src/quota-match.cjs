'use strict';
// Copyright (c) 2026 jisoq; adapted Usage Atlas observation matching. See licenses/Codexon-LICENSE.txt.
const {series} = require('./core.cjs');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const MAX_GAP = 1800000;
const callTime = row => finite(row.time) ? row.time : finite(row.completedAt) ? row.completedAt : row.startedAt;
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

function observedTimes(times) {
  const unique = [...new Set(times)].sort((a, b) => a - b);
  return {observedTimes: unique.length <= 50 ? unique : Array.from({length: 50}, (_, index) => unique[Math.round(index * (unique.length - 1) / 49)]), observedTimeCount: unique.length};
}

function quotaData(records, capacities, provider, account, window, start, end, now) {
  // series() uses the core's unthinned transitions, reset assumptions and peak recovery.
  const all = records.filter(row => row?.provider === provider && finite(row.time) && row.time <= Math.max(end, now) && row.windows).sort((a, b) => a.time - b.time);
  const blocks = [];
  let block = null;
  for (const row of all) {
    if (row.account !== account) {block = null; continue;}
    if (!block) {block = []; blocks.push(block);}
    block.push(row);
  }
  const intervals = [];
  const cycles = [];
  for (const [blockIndex, rows] of blocks.entries()) {
    const points = series(rows, provider, window, capacities);
    let cycle;
    for (const [index, point] of points.entries()) {
      if (point.time >= end) break;
      const previous = points[index - 1];
      const resetEvent = ['scheduled-reset', 'early-reset'].includes(point.event?.kind);
      const changed = previous && (previous.plan !== point.plan || previous.mult !== point.mult || resetEvent);
      if (!cycle || changed) {
        if (cycle) cycle.current = false;
        cycle = {
          id: `${provider}/${account}/${window}/${blockIndex}/${point.time}`
        , provider
        , account
        , window
        , plan: point.plan
        , mult: point.mult
        , start: point.time
        , end: point.time
        , reset: point.reset
        , current: false
        , partial: true
        , startObserved: resetEvent
        , endObserved: false
        , quotaDelta: 0
        , rawQuotaDelta: 0
        , estimatedQuotaDelta: 0
        , gapCount: 0
        , events: []
        , points: []
        };
        if (resetEvent && previous && cycles.length) cycles.at(-1).endObserved = true;
        cycles.push(cycle);
      }
      cycle.end = point.time;
      cycle.reset = point.reset;
      if (point.event) cycle.events.push(safe(point.event));
      if (previous && (point.time - previous.time > MAX_GAP || !resetEvent && !point.continuous)) cycle.gapCount++;
      if (point.time >= start) {
        cycle.points.push(point);
        if (finite(point.delta) && point.delta > 0) cycle.rawQuotaDelta += point.delta;
        if (point.estimatedDelta && point.delta > 0) cycle.estimatedQuotaDelta += point.delta;
      }
      if (previous && point.continuous && finite(point.delta) && point.delta > 0 && previous.time >= start && point.time < end) {
        intervals.push({id: `${cycle.id}/${point.time}`, start: previous.time, end: point.time, delta: point.delta, cycleId: cycle.id, plan: point.plan, mult: point.mult});
        cycle.quotaDelta += point.delta;
      }
    }
  }
  const visible = cycles.filter(cycle => cycle.end >= start && cycle.start < end);
  const latest = visible.at(-1);
  if (latest) latest.current = latest === cycles.at(-1) && finite(latest.reset) && now < latest.reset && all.at(-1)?.account === account;
  for (const cycle of visible) {
    cycle.partial = !cycle.startObserved || !cycle.endObserved || cycle.gapCount > 0 || cycle.start < start;
    cycle.observedStart = cycle.points[0]?.time ?? null;
    cycle.observedEnd = cycle.points.at(-1)?.time ?? null;
    Object.assign(cycle, observedTimes(cycle.points.map(point => point.time)));
    delete cycle.points;
  }
  return {intervals, cycles: visible};
}

function matchCalls(rows, intervals) {
  const intervalAt = time => {
    let low = 0;
    let high = intervals.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (intervals[middle].end < time) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return rows.map(row => {
    const start = row.startedAt;
    const end = row.completedAt;
    const complete = ['completed', 'complete', 'success', 'succeeded'].includes(row.completionState);
    let interval;
    let matchState = 'unmatched';
    if (complete && finite(start) && finite(end) && end >= start) {
      const candidate = intervalAt(end);
      interval = [intervals[candidate], intervals[candidate + 1]].find(item => item && start >= item.start && end <= item.end && (start < item.end || start === end && start === item.start));
      if (interval) matchState = 'matched';
    } else if (complete && !finite(start)) {
      const time = finite(end) ? end : callTime(row);
      const candidate = intervals[intervalAt(time)];
      interval = candidate && time > candidate.start && time <= candidate.end ? candidate : null;
      if (interval) matchState = 'provisional';
    }
    row.matchState = matchState;
    row.quotaIntervalId = interval?.id ?? null;
    return row;
  });
}


module.exports = {quotaData, matchCalls};
