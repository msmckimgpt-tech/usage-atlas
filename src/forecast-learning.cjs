'use strict';
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
const forecast = require('../media/forecast.js');
const hour = 3600000, day = 24 * hour;
const methods = ['seasonal', 'recent', 'historical', 'activity'];
const finite = Number.isFinite;
function pack(points) {
  if (!points.some(point => Number.isFinite(point.value))) return {data: new Float64Array(0), plans: []};
  const plans = [], indexes = new Map(), data = new Float64Array(points.length * 8);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]; let plan = indexes.get(p.plan); if (plan === undefined) {plan = plans.length; plans.push(p.plan); indexes.set(p.plan, plan);}
    data.set([p.time, p.value ?? NaN, p.reset ?? NaN, p.mult ?? NaN, p.delta ?? NaN, plan, p.segment ?? 0, (p.continuous ? 1 : 0) | (p.estimatedDelta ? 2 : 0) | (p.recoveryExcluded > 0 ? 4 : 0) | (['scheduled-reset', 'early-reset'].includes(p.event?.kind) ? 8 : 0)], i * 8);
  }
  return {data, plans};
}
function unpack({data, plans}) {
  const points = [];
  for (let i = 0; i < data.length; i += 8) {
    const flags = data[i + 7];
    points.push({time: data[i], value: finite(data[i + 1]) ? data[i + 1] : null, reset: finite(data[i + 2]) ? data[i + 2] : null, mult: finite(data[i + 3]) ? data[i + 3] : null, delta: finite(data[i + 4]) ? data[i + 4] : null, plan: plans[data[i + 5]], segment: data[i + 6], continuous: !!(flags & 1), estimatedDelta: !!(flags & 2), recoveryExcluded: flags & 4 ? 1 : 0, ...(flags & 8 ? {event: {kind: 'scheduled-reset'}} : {})});
  }
  return points;
}
function at(value, time) {
  if (!['predicted', 'reset-first', 'inactive'].includes(value.state) || time >= value.reset) return null;
  if (!value.trajectory) return Math.min(100, value.used + value.ratePerHour * (time - value.observedAt) / hour);
  const points = value.trajectory; if (time >= points.at(-1).time) return points.at(-1).value;
  let lo = 1, hi = points.length - 1;
  while (lo < hi) {const mid = (lo + hi) >>> 1; if (points[mid].time < time) lo = mid + 1; else hi = mid;}
  const a = points[lo - 1], b = points[lo]; return a.value + (b.value - a.value) * (time - a.time) / (b.time - a.time);
}
const mean = rows => rows.reduce((sum, row) => sum + Math.abs(row), 0) / Math.max(1, rows.length);
const quantile = (rows, ratio) => {const sorted = [...rows].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * ratio)];};
function calibrate(points, window, config, archiveCells = [], since) {
  const last = points.at(-1), rows = [], slots = new Map();
  const calendar = new Intl.DateTimeFormat('en-CA', {timeZone: forecast.settings(config).timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}), dateOf = time => calendar.format(time);
  if (!last || last.value === null || !config.patternDays) return {method: 'seasonal', samples: 0, errors: []};
  const bad = [0];
  for (let i = 1; i < points.length; i++) bad[i] = bad[i - 1] + (!points[i].continuous || points[i].estimatedDelta || points[i].recoveryExcluded || points[i].plan !== points[i - 1].plan || points[i].mult !== points[i - 1].mult ? 1 : 0);
  let previous = Infinity, origins = 0;
  const step = window === 'five' ? hour : 6 * hour, horizons = window === 'five' ? [1, 3] : [6, 24];
  for (let i = points.length - 2; i > 0 && origins < 32; i--) {
    const p = points[i];
    if (p.time < last.time - Math.min(config.patternDays, 14) * day) break;
    if (previous - p.time < step || p.value === null || p.value >= 100 || p.plan !== last.plan || p.mult !== last.mult || finite(since) && p.time <= since) continue;
    previous = p.time;
    const targets = [];
    for (const hours of horizons) {
      const target = p.time + hours * hour; let lo = i + 1, hi = points.length;
      while (lo < hi) {const mid = (lo + hi) >>> 1; if (points[mid].time < target) lo = mid + 1; else hi = mid;}
      if (lo < points.length && points[lo].time - target <= 10 * 60000 && points[lo].time < p.reset && bad[lo] === bad[i]) targets.push({p: points[lo], hours});
    }
    if (!targets.length) continue;
    const prefix = points.slice(0, i + 1), values = methods.map(method => forecast.estimate(prefix, window, {...config, since, slots, archiveCells, method})); origins++;
    for (const target of targets) {
      const predicted = values.map(value => at(value, target.p.time));
      if (predicted.every(finite)) rows.push({origin: p.time, time: target.p.time, hours: target.hours, actual: target.p.value, errors: predicted.map(value => value - target.p.value)});
    }
  }
  rows.sort((a, b) => a.origin - b.origin);
  const unique = [...new Set(rows.map(row => row.origin))], dates = new Set(rows.map(row => dateOf(row.origin))).size;
  const split = unique[Math.floor(unique.length * 2 / 3)] ?? Infinity, train = rows.filter(row => row.origin < split), validation = rows.filter(row => row.origin >= split);
  let selected = 0;
  if (unique.length >= 8 && dates >= 3 && train.length >= 6 && validation.length >= 4) {
    const score = (list, index) => mean(list.map(row => row.errors[index]));
    const best = methods.reduce((winner, _method, index) => score(train, index) < score(train, winner) ? index : winner, 0);
    if (best && score(train, best) <= score(train, 0) * .95 && score(validation, best) <= score(validation, 0) * .95) selected = best;
  }
  const errors = horizons.flatMap(hours => {
    const samples = rows.filter(row => row.hours === hours), days = new Set(samples.map(row => dateOf(row.origin))).size;
    if (samples.length < 8 || days < 3) return [];
    const residuals = samples.map(row => -row.errors[selected]);
    return [{hours, samples: samples.length, dates: days, low: Math.min(0, quantile(residuals, .1)), high: Math.max(0, quantile(residuals, .9))}];
  });
  return {method: methods[selected], evaluatedThrough: rows.reduce((time, row) => Math.max(time, row.time), 0), samples: rows.length, origins: unique.length, dates, validated: selected !== 0, train: methods.map((method, i) => ({method, mae: mean(train.map(row => row.errors[i])), validationMae: mean(validation.map(row => row.errors[i]))})), errors};
}
function fit(input) {
  const result = {version: 1, key: input.key, observedAt: input.observedAt, providers: {}};
  for (const [id, provider] of Object.entries(input.providers)) result.providers[id] = Object.fromEntries(Object.entries(provider.windows).map(([window, value]) => [window, !value.data.length && value.priorModel?.scopeKey === value.scopeKey ? value.priorModel : {...calibrate(unpack(value), window, input.config, value.archiveCells, provider.since), scopeKey: value.scopeKey, observedAt: value.sourceTime || input.observedAt}]));
  return result;
}
function fitWorker(input, {signal, timeoutMs = 15000} = {}) {
  return new Promise((resolve, reject) => {
    const transfers = Object.values(input.providers).flatMap(provider => Object.values(provider.windows).map(window => window.data.buffer));
    const worker = new Worker(__filename, {workerData: input, transferList: transfers, resourceLimits: {maxOldGenerationSizeMb: 96}});
    let done = false;
    const finish = (error, value) => {if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate(); error ? reject(error) : resolve(value);};
    const cancel = () => finish(new Error('forecast calibration cancelled'));
    const timer = setTimeout(() => finish(new Error('forecast calibration timed out')), timeoutMs);
    worker.once('message', value => value.error ? finish(new Error(value.error)) : finish(null, value)); worker.once('error', error => finish(error)); worker.once('exit', code => {if (!done) finish(new Error('forecast worker exited ' + code));});
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, {once: true});
  });
}
if (!isMainThread) {try {parentPort.postMessage(fit(workerData));} catch {parentPort.postMessage({error: 'forecast calibration failed'});}}
module.exports = {pack, unpack, at, calibrate, fit, fitWorker};
