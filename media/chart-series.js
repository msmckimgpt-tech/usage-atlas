((scope, factory) => {
  const api = typeof module === 'object' && module.exports ? factory(require('./credit-series.js'), require('./gaps.js')) : factory(scope.usageAtlasCreditSeries, scope.usageAtlasGaps);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasChartSeries = api;
})(globalThis, (creditGraphs, gaps) => {
  const number = n => typeof n === 'number' && Number.isFinite(n);
  const antigravity = id => typeof id === 'string' && /^antigravity-[a-f\d]{16}$/.test(id);
  const smoothing = value => number(value) && value >= 0 && value <= 60 ? value : 5;
  function stabilize(input, minutes = 5) {
    const width = smoothing(minutes) * 60000;
    if (!width || !input.length || input.some(p => p.displayCycle == null)) return input;
    const points = input.map(p => ({...p})), blocks = []; let block = [], context = 0, previous;
    for (const p of points) {
      const valid = number(p.value), sameCycle = previous && p.displayCycle != null && p.displayCycle === previous.displayCycle && p.plan === previous.plan && p.mult === previous.mult;
      const correction = previous && valid && number(previous.value) && previous.value - p.value > 1;
      if (previous && (!sameCycle || correction)) context++;
      const continuous = sameCycle && !correction && number(previous.value) && valid && p.totalContinuous !== false && p.time > previous.time && p.time - previous.time <= 1800000 && p.time < Math.min(p.reset, previous.reset);
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
    const points = input.map(p => {
      const calibrated = mode === 'total' ? known : number(p.mult);
      const factor = basis === 'base' && calibrated ? p.mult : 1;
      let y = p.value === null ? null : mode === 'usage' ? p.value * factor : mode === 'delta' ? (p.delta === null ? null : p.delta * factor) : (known ? p.cumulative / (basis === 'base' ? 1 : currentMult) : p.nativeCumulative);
      let estimated = false;
      const extra = creditGraphs.value(p, mode, mode === 'total' && !known ? 'current' : basis, currentMult);
      if (number(y) && estimateCredit) {if (number(extra.y)) {y += extra.y; estimated = true;} else y = null;}
      const continuous = mode === 'total' ? p.totalContinuous ?? p.continuous : p.displayContinuous ?? p.continuous;
      const segment = mode === 'total' ? p.cumulativeSegment ?? p.segment : p.displayContext ?? p.segment;
      const creditSegment = mode === 'total' ? p.credit?.cumulativeSegment ?? p.credit?.segment : p.credit?.segment;
      const gapContext = segment == null || estimated && creditSegment == null ? null : segment + '/' + (estimated ? creditSegment : '');
      return {...p, y, estimated: estimated || !!p.displayEstimated, calibrated, gapContext, gapPolicy: mode === 'total' ? 'cumulative' : 'cycle', resetEstimated: mode === 'delta' ? !!p.estimatedDelta : mode === 'total' && !!p.cumulativeEstimated, continuous: !!(continuous && (!estimated || extra.continuous && p.credit?.[mode + 'Continuous']))};
    });
    if (basis === 'base' && mode !== 'total') return [true, false].map(known => ({id, w, known, points: points.map((p, i) => ({...p, y: p.calibrated === known ? p.y : null, continuous: p.continuous && i > 0 && points[i - 1].calibrated === known}))}));
    return [{id, w, known, points}];
  }
  function values(points, bridges, domain, field = 'y') {
    const found = points.filter(p => p.time >= domain[0] && p.time <= domain[1] && number(p[field])).map(p => p[field]);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (!b.continuous || !number(a[field]) || !number(b[field]) || b.time <= a.time) continue;
      for (const edge of domain) if (a.time < edge && edge < b.time) found.push(gaps.at([a, b], field, edge));
    }
    return found.concat(gaps.visible(bridges, field, domain));
  }
  function limits(plotted, domain, {mode = 'usage', basis = 'current', refs: showRefs = false} = {}) {
    const active = plotted.filter(s => s.points.some(p => number(p.y)));
    const rawTotal = mode === 'total' && active.length > 0 && active.every(s => !s.known);
    const split = basis === 'base' || mode === 'total' && !rawTotal && active.some(s => !s.known);
    const refs = mode === 'delta' ? [] : basis === 'base' ? (showRefs ? [100, 500, 2000] : [100, 500]) : rawTotal ? [] : [100];
    const visible = s => values(s.points, s.bridges || gaps.bridges(s.points, 'y'), domain);
    const scaled = plotted.filter(s => !split || s.known).flatMap(visible);
    const unscaled = plotted.filter(s => split && !s.known).flatMap(visible);
    const yMax = Math.max(1, ...refs, ...scaled);
    const referenceZoom = basis === 'base' && showRefs && mode !== 'delta' ? yMax / Math.max(500, ...scaled) : 1;
    const rawMax = Math.max(mode === 'delta' ? 1 : 100, ...unscaled) * referenceZoom;
    // 현재 한도의 누적 %와 미환산 pp는 단위를 보존하고 같은 숫자 간격으로 비교한다.
    const sharedTotal = mode === 'total' && basis === 'current' && split;
    const maximum = (sharedTotal ? Math.max(yMax, rawMax) : yMax) * 1.08;
    return {rawTotal, split, refs, maximum, unscaledMaximum: sharedTotal ? maximum : rawMax * 1.08};
  }
  function billingMaximum(series, domain, mode = 'usage') {
    const maximum = Math.max(0, ...series.filter(item => item.billing).flatMap(item => values(item.points, item.bridges || gaps.bridges(item.points, 'y'), domain)));
    return (mode === 'delta' ? maximum > 0 ? Math.max(.000001, maximum) : 1 : Math.max(100, maximum)) * 1.08;
  }
  return {quota, values, limits, billingMaximum, stabilize, events, smoothing};
});
