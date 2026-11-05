((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasGaps = api;
})(globalThis, () => {
  const number = n => typeof n === 'number' && Number.isFinite(n);
  function bridges(points, field) {
    const result = []; let previous, missing = false;
    for (const p of points) {
      if (!number(p[field])) {missing = true; continue;}
      if (previous && (missing || !p.continuous) && p.time > previous.time && p.gapContext != null && p.gapContext === previous.gapContext
        && (p.gapPolicy === 'cumulative' && previous.gapPolicy === 'cumulative' ? p[field] >= previous[field]
          : number(previous.reset) && number(p.reset) && p.time < Math.min(previous.reset, p.reset))) result.push([previous, p]);
      previous = p; missing = false;
    }
    return result;
  }
  const at = (pair, field, time) => pair[0][field] + (pair[1][field] - pair[0][field]) * (time - pair[0].time) / (pair[1].time - pair[0].time);
  function visible(segments, field, domain) {
    const result = [];
    for (const pair of segments) {
      const lo = Math.max(domain[0], pair[0].time), hi = Math.min(domain[1], pair[1].time);
      if (lo <= hi) result.push(at(pair, field, lo), at(pair, field, hi));
    }
    return result;
  }
  return {bridges, at, visible};
});
