((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasCreditSeries = api;
})(globalThis, () => {
  const number = n => typeof n === 'number' && Number.isFinite(n);
  const nativeField = mode => 'native' + mode[0].toUpperCase() + mode.slice(1);
  function value(point, mode = 'usage', basis = 'current', currentMult) {
    const estimate = point.creditEstimate, base = estimate?.[mode];
    const field = nativeField(mode), mult = mode === 'total' ? currentMult : point.mult;
    const native = number(estimate?.[field]) ? estimate[field] : number(base) && (base === 0 || number(mult) && mult > 0) ? base === 0 ? 0 : base / mult : null;
    const calibrated = number(point.mult) && point.mult > 0;
    const useBase = basis === 'base' && calibrated;
    const safeTotal = mode !== 'total' || useBase || native === 0 || point.cumulativeKnown !== false && number(currentMult) || estimate?.nativeTotalKind === 'same-cohort';
    const y = safeTotal ? useBase ? base : native : null;
    const continuous = estimate?.[(useBase ? mode : field) + 'Continuous'] ?? estimate?.[mode + 'Continuous'];
    return {y: number(y) ? y : null, calibrated, continuous: !!continuous};
  }
  const key = (id, window) => id + (window === 'week' ? '-credit' : '-credit-five');
  function series(provider, id, {mode = 'usage', basis = 'current', creditBasis = 'subscription'} = {}) {
    if (creditBasis === 'billing') {
      const points = (provider?.ledger || []).map(point => ({...point, y: point.billing?.[mode] ?? null, amount: point.credit?.[mode] ?? null, continuous: !!point.billing?.[mode + 'Continuous'], delta: point.credit?.delta, reset: point.credit?.reset, gapPolicy: mode === 'total' ? 'cumulative' : 'cycle', gapContext: JSON.stringify([mode === 'total' ? point.credit?.cumulativeSegment : point.credit?.segment, point.billing?.segment]), estimated: false}));
      return [{id, w: 'credit', creditWindow: 'week', key: key(id, 'week'), known: true, billing: true, points}];
    }
    return ['five', 'week'].flatMap(window => {
      const input = provider?.windows?.[window] || [], currentMult = input.at(-1)?.mult;
      const known = number(currentMult) && (mode !== 'total' || (basis === 'base' ? number(input.at(-1)?.creditEstimate?.total) : input.at(-1)?.cumulativeKnown !== false));
      // 5시간 사용량 보기의 원단위 금액은 주간 누적이 아니라 5시간 초기화 이후의 증가분이다.
      const fiveUsage = window === 'five' && mode === 'usage';
      let base = null;
      const points = input.map((p, i) => {
        const scaled = value(p, mode, basis, currentMult);
        if (fiveUsage && (i === 0 || p.credit?.cycleStart || p.event?.kind === 'scheduled-reset' || p.event?.kind === 'early-reset')) base = number(p.credit?.usage) ? p.credit.usage : null;
        const amount = fiveUsage ? number(p.credit?.usage) && number(base) ? p.credit.usage - base : null : p.credit?.[mode];
        const segment = mode === 'total' ? p.credit?.cumulativeSegment ?? p.credit?.segment : p.credit?.segment;
        return {...p, ...scaled, amount: number(amount) ? amount : null, delta: p.credit?.delta, reset: fiveUsage ? p.reset : p.credit?.reset, estimated: number(scaled.y) && amount > 0, gapPolicy: mode === 'total' ? 'cumulative' : 'cycle', gapContext: segment == null ? null : JSON.stringify(fiveUsage ? [segment, p.segment, p.plan, p.mult] : [segment, p.plan, p.mult]), continuous: scaled.continuous && !!p.credit?.[mode + 'Continuous'] && (!fiveUsage || !!p.continuous || i === 0)};
      });
      const make = (known, selected) => ({id, w: 'credit', creditWindow: window, key: key(id, window), known, points: selected});
      if (basis === 'base' && mode !== 'total') return [true, false].map(known => make(known, points.map((p, i) => ({...p, y: p.calibrated === known ? p.y : null, continuous: p.continuous && i > 0 && points[i - 1].calibrated === known}))));
      return [make(known, points)];
    });
  }
  return {value, series, key};
});
