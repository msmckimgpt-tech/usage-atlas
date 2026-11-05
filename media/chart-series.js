((scope, factory) => {
  const api = typeof module === 'object' && module.exports ? factory(require('./credit-series.js'), require('./gaps.js')) : factory(scope.usageAtlasCreditSeries, scope.usageAtlasGaps);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasChartSeries = api;
})(globalThis, (creditGraphs, gaps) => {
  const number = n => typeof n === 'number' && Number.isFinite(n);
  function quota(provider, id, w, {mode = 'usage', basis = 'current', credit = false, creditMode = 'money'} = {}) {
    const input = provider?.windows?.[w] || [], currentMult = input.at(-1)?.mult;
    const known = number(currentMult) && (mode !== 'total' || input.at(-1)?.cumulativeKnown !== false);
    const estimateCredit = credit && creditMode === 'estimate' && (provider?.ledgerAvailable ?? number(provider?.last?.spentUsd));
    const points = input.map(p => {
      const calibrated = mode === 'total' ? known : number(p.mult);
      const factor = basis === 'base' && calibrated ? p.mult : 1;
      let y = p.value === null ? null : mode === 'usage' ? p.value * factor : mode === 'delta' ? (p.delta === null ? null : p.delta * factor) : (known ? p.cumulative / (basis === 'base' ? 1 : currentMult) : p.nativeCumulative);
      let estimated = false;
      const extra = creditGraphs.value(p, mode, mode === 'total' && !known ? 'current' : basis, currentMult);
      if (number(y) && estimateCredit) {if (number(extra.y)) {y += extra.y; estimated = true;} else y = null;}
      const continuous = mode === 'total' ? p.totalContinuous ?? p.continuous : p.continuous;
      const segment = mode === 'total' ? p.cumulativeSegment ?? p.segment : p.segment;
      const creditSegment = mode === 'total' ? p.credit?.cumulativeSegment ?? p.credit?.segment : p.credit?.segment;
      const gapContext = segment == null || estimated && creditSegment == null ? null : segment + '/' + (estimated ? creditSegment : '');
      return {...p, y, estimated, calibrated, gapContext, gapPolicy: mode === 'total' ? 'cumulative' : 'cycle', resetEstimated: mode === 'delta' ? !!p.estimatedDelta : mode === 'total' && !!p.cumulativeEstimated, continuous: !!(continuous && (!estimated || extra.continuous && p.credit?.[mode + 'Continuous']))};
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
  return {quota, values, limits, billingMaximum};
});
