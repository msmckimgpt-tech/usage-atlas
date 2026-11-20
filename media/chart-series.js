((scope, factory) => {
  const api = typeof module === 'object' && module.exports ? factory(require('./credit-series.js'), require('./gaps.js')) : factory(scope.usageAtlasCreditSeries, scope.usageAtlasGaps);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasChartSeries = api;
})(globalThis, (creditGraphs, gaps) => {
  const number = n => typeof n === 'number' && Number.isFinite(n);
  const antigravity = id => typeof id === 'string' && /^antigravity-[a-f\d]{16}$/.test(id);
  // 초기화 시각 직후(수 초~수 분) 수집이 같은 초기화 시각의 이전 주기 값을 돌려주면 주기의 마지막 관측으로 잇는다.
  const resetGrace = 300000;
  const resetEvent = p => p?.event?.kind === 'scheduled-reset' || p?.event?.kind === 'early-reset';
  const cycleTail = (a, b) => !!(a && b && number(a.value) && number(b.value) && b.value >= a.value && b.time > a.time && b.totalContinuous !== false && !resetEvent(b)
    && a.plan === b.plan && a.mult === b.mult && number(a.reset) && number(b.reset) && Math.abs(a.reset - b.reset) <= 60000 && b.time >= Math.min(a.reset, b.reset) && b.time < Math.min(a.reset, b.reset) + resetGrace);
  const smoothing = value => number(value) && value >= 0 && value <= 60 ? value : 5;
  // 수집 공백 판단은 core의 totalContinuous(설정한 최대 수집 간격 기준)를 따른다. 30분 고정값은 유휴 수집(최대 20분 x3)을 끊었다.
  function stabilize(input, minutes = 5) {
    const width = smoothing(minutes) * 60000;
    if (!width || !input.length || input.some(p => p.displayCycle == null)) return input;
    const points = input.map(p => ({...p})), blocks = []; let block = [], context = 0, previous;
    for (const p of points) {
      const valid = number(p.value), sameCycle = previous && p.displayCycle != null && p.displayCycle === previous.displayCycle && p.plan === previous.plan && p.mult === previous.mult;
      const correction = previous && valid && number(previous.value) && previous.value - p.value > 1;
      if (previous && (!sameCycle || correction)) context++;
      const continuous = sameCycle && !correction && number(previous.value) && valid && (p.totalContinuous === undefined ? p.time - previous.time <= 1800000 : p.totalContinuous) && p.time > previous.time && p.time < Math.min(p.reset, previous.reset) + resetGrace;
      p.displayContext = 'stable/' + context;
      p.displayContinuous = !!continuous;
      p.displayEstimated = !!(continuous && !p.continuous);
      if (!continuous && block.length) {blocks.push(block); block = [];}
      if (valid) block.push(p);
      previous = p;
    }
    if (block.length) blocks.push(block);
    for (const group of blocks) {
      if (group.length < 3) continue;
      const times = group.map(p => p.time), values = group.map(p => p.value), area = [0];
      for (let i = 1; i < group.length; i++) area[i] = area[i - 1] + (values[i - 1] + values[i]) / 2 * (times[i] - times[i - 1]);
      let left = 0, right = 0;
      const integral = (time, i) => {
        if (i === group.length - 1) return area[i];
        const dt = time - times[i];
        return area[i] + values[i] * dt + (values[i + 1] - values[i]) * dt * dt / (2 * (times[i + 1] - times[i]));
      };
      // 같은 관측 구간 안에서만 시간 가중 평균한다. 주기 끝과 최신 관측값은 고정한다.
      for (let i = 1; i < group.length - 1; i++) {
        const from = Math.max(times[0], times[i] - width / 2), until = Math.min(times.at(-1), times[i] + width / 2);
        while (left + 1 < group.length && times[left + 1] <= from) left++;
        while (right + 1 < group.length && times[right + 1] <= until) right++;
        const value = Math.max(0, Math.min(100, (integral(until, right) - integral(from, left)) / (until - from)));
        group[i].rawValue = group[i].value; group[i].value = value;
        group[i].displayEstimated ||= Math.abs(value - group[i].rawValue) > 1e-8;
      }
    }
    return points;
  }
  function events(provider, id, {mode = 'usage', antigravitySmoothingMinutes = 5} = {}) {
    const input = provider?.events || [];
    return antigravity(id) && mode === 'usage' && smoothing(antigravitySmoothingMinutes) > 0 ? input.filter(e => e.kind !== 'decrease' || e.before - e.after > 1) : input;
  }
  function quota(provider, id, w, {mode = 'usage', basis = 'current', credit = false, creditMode = 'money', antigravitySmoothingMinutes = 5} = {}) {
    const raw = provider?.windows?.[w] || [], input = antigravity(id) && mode === 'usage' ? stabilize(raw, antigravitySmoothingMinutes) : raw, currentMult = input.at(-1)?.mult;
    const known = number(currentMult) && (mode !== 'total' || input.at(-1)?.cumulativeKnown !== false);
    const estimateCredit = credit && creditMode === 'estimate' && (provider?.ledgerAvailable ?? number(provider?.last?.spentUsd));
    const points = input.map((p, i) => {
      const calibrated = mode === 'total' ? known : number(p.mult);
      const factor = basis === 'base' && calibrated ? p.mult : 1;
      let y = p.value === null ? null : mode === 'usage' ? p.value * factor : mode === 'delta' ? (p.delta === null ? null : p.delta * factor) : (known ? p.cumulative / (basis === 'base' ? 1 : currentMult) : p.nativeCumulative);
      let estimated = false;
      const extra = creditGraphs.value(p, mode, mode === 'total' && !known ? 'current' : basis, currentMult);
      if (number(y) && estimateCredit) {if (number(extra.y)) {y += extra.y; estimated = true;} else y = null;}
      const continuous = mode === 'total' ? p.totalContinuous ?? p.continuous : p.displayContinuous ?? (p.continuous || mode === 'usage' && cycleTail(input[i - 1], p));
      const segment = mode === 'total' ? p.cumulativeSegment ?? p.segment : p.displayContext ?? p.segment;
      const creditSegment = mode === 'total' ? p.credit?.cumulativeSegment ?? p.credit?.segment : p.credit?.segment;
      const gapContext = segment == null || estimated && creditSegment == null ? null : segment + '/' + (estimated ? creditSegment : '');
      return {...p, y, estimated: estimated || !!p.displayEstimated, calibrated, gapContext, gapPolicy: mode === 'total' ? 'cumulative' : 'cycle', resetEstimated: mode === 'delta' ? !!p.estimatedDelta : mode === 'total' && !!p.cumulativeEstimated, continuous: !!(continuous && (!estimated || extra.continuous && p.credit?.[mode + 'Continuous']))};
    });
    if (basis === 'base' && mode !== 'total') return [true, false].map(known => ({id, w, known, points: points.map((p, i) => ({...p, y: p.calibrated === known ? p.y : null, continuous: p.continuous && i > 0 && points[i - 1].calibrated === known}))}));
    return [{id, w, known, points}];
  }
  // 시간순 배열에서 time 이상인 첫 위치(lower bound)와 time 초과인 첫 위치(upper bound)를 이분 탐색한다.
  const lowerBound = (points, time) => {let a = 0, b = points.length; while (a < b) {const m = (a + b) >> 1; if (points[m].time < time) a = m + 1; else b = m;} return a;};
  const upperBound = (points, time, from = 0) => {let a = from, b = points.length; while (a < b) {const m = (a + b) >> 1; if (points[m].time <= time) a = m + 1; else b = m;} return a;};
  function values(points, bridges, domain, field = 'y') {
    const lo = lowerBound(points, domain[0]), hi = upperBound(points, domain[1], lo), found = [];
    for (let i = lo; i < hi; i++) if (number(points[i][field])) found.push(points[i][field]);
    // 가장자리를 가로지르는 선분은 경계의 보간값만 더한다. 시간순 점에서는 가장자리마다 한 쌍뿐이다.
    for (const edge of domain) {
      const i = lowerBound(points, edge), a = points[i - 1], b = points[i];
      if (a && b && b.continuous && number(a[field]) && number(b[field]) && a.time < edge && edge < b.time) found.push(gaps.at([a, b], field, edge));
    }
    return found.concat(gaps.visible(bridges, field, domain));
  }
  function maxInView(points, bridges, domain, field = 'y') {
    let best = -Infinity;
    const lo = lowerBound(points, domain[0]), hi = upperBound(points, domain[1], lo);
    for (let i = lo; i < hi; i++) {const v = points[i][field]; if (number(v) && v > best) best = v;}
    for (const edge of domain) {
      const i = lowerBound(points, edge), a = points[i - 1], b = points[i];
      if (a && b && b.continuous && number(a[field]) && number(b[field]) && a.time < edge && edge < b.time) {
        const v = gaps.at([a, b], field, edge); if (v > best) best = v;
      }
    }
    for (const v of gaps.visible(bridges, field, domain)) if (v > best) best = v;
    return best;
  }
  function limits(plotted, domain, {mode = 'usage', basis = 'current', refs: showRefs = false} = {}) {
    const active = plotted.filter(s => s.hasData ?? s.points.some(p => number(p.y)));
    const rawTotal = mode === 'total' && active.length > 0 && active.every(s => !s.known);
    const split = basis === 'base' || mode === 'total' && !rawTotal && active.some(s => !s.known);
    const refs = mode === 'delta' ? [] : basis === 'base' ? (showRefs ? [100, 500, 2000] : [100, 500]) : rawTotal ? [] : [100];
    let scaledMax = -Infinity, unscaledMax = -Infinity;
    for (const s of plotted) {
      const m = maxInView(s.points, s.bridges || gaps.bridges(s.points, 'y'), domain);
      if (!split || s.known) {if (m > scaledMax) scaledMax = m;}
      else if (m > unscaledMax) unscaledMax = m;
    }
    const yMax = Math.max(1, ...refs, scaledMax);
    const referenceZoom = basis === 'base' && showRefs && mode !== 'delta' ? yMax / Math.max(500, scaledMax) : 1;
    const rawMax = Math.max(mode === 'delta' ? 1 : 100, unscaledMax) * referenceZoom;
    // 현재 한도의 누적 %와 미환산 pp는 단위를 보존하고 같은 숫자 간격으로 비교한다.
    const sharedTotal = mode === 'total' && basis === 'current' && split;
    const maximum = (sharedTotal ? Math.max(yMax, rawMax) : yMax) * 1.08;
    return {rawTotal, split, refs, maximum, unscaledMaximum: sharedTotal ? maximum : rawMax * 1.08};
  }
  function billingMaximum(series, domain, mode = 'usage') {
    let maximum = 0;
    for (const item of series) if (item.billing) {
      const m = maxInView(item.points, item.bridges || gaps.bridges(item.points, 'y'), domain);
      if (m > maximum) maximum = m;
    }
    return (mode === 'delta' ? maximum > 0 ? Math.max(.000001, maximum) : 1 : Math.max(100, maximum)) * 1.08;
  }
  // 보이는 시간 범위만 잘라 픽셀 열마다 첫·마지막·최소·최대 점(M4)만 남긴다. 래스터 결과는 전체 점과 같고 점 수는 폭에 비례한다.
  function decimate(points, domain, px, py) {
    const first0 = lowerBound(points, domain[0]), lo = Math.max(0, first0 - 1), hi = Math.min(points.length, upperBound(points, domain[1], first0) + 1);
    const out = []; let column = NaN, first = 0, last = 0, low = 0, high = 0, lowY = 0, highY = 0;
    const flush = () => {
      if (column !== column) return;
      const picks = [first, low, high, last].sort((a, b) => a - b);
      for (let i = 0; i < picks.length; i++) if (i === 0 || picks[i] !== picks[i - 1]) out.push(points[picks[i]]);
    };
    for (let i = lo; i < hi; i++) {
      const p = points[i], c = Math.floor(px(p)), y = py(p);
      if (c !== column) {flush(); column = c; first = last = low = high = i; lowY = highY = y;}
      else {last = i; if (y < lowY) {lowY = y; low = i;} if (y > highY) {highY = y; high = i;}}
    }
    flush();
    return out;
  }
  return {quota, values, limits, billingMaximum, stabilize, events, smoothing, decimate, lowerBound, upperBound};
});
