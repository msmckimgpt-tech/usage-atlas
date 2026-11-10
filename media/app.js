(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const root = document.getElementById('usage-atlas');
  const el = id => document.getElementById('ua-' + id);
  const ids = ['codex', 'claude'];
  const providerKeys = [...ids].sort((a, b) => b.length - a.length);
  const names = {codex: 'Codex', claude: 'Claude Code'};
  const labels = {five: '5시간', week: '주간'};
  const eventLabels = {'early-reset': '예정 전 초기화', 'scheduled-reset': '초기화', decrease: '사용률 하락', 'schedule-change': '예정 변경'};
  const colors = {codex: 'var(--ua-a)', claude: 'var(--ua-b)'};
  const week = 7 * 86400000, minSpan = 60000;
  const providerFocus = globalThis.usageAtlasProviderFocus;
  const defaults = {version: 5, mode: 'usage', basis: 'current', theme: 'system', focusedProvider: null, credit: false, creditMode: 'money', creditBasis: 'subscription', refs: false, range: null};
  let state = {...defaults}, model = {now: Date.now(), data: {}}, raf, view, gesture = null, chartDrag = null;
  const initialNode = document.getElementById('ua-initial-data');
  if (initialNode) {const initial = JSON.parse(initialNode.textContent); if (initial?.type === 'data' && initial.data && Number.isFinite(initial.now)) model = initial; initialNode.remove();}
  const details = globalThis.usageAtlasDetails?.({api, root, getModel: () => model});
  const saved = api.getState();
  if ([3, 4, 5].includes(saved?.version)) {
    for (const [key, values] of Object.entries({mode: ['usage', 'delta', 'total'], basis: ['current', 'base'], theme: ['system', 'light', 'dark'], creditMode: ['money', 'estimate']})) if (values.includes(saved[key])) state[key] = saved[key];
    for (const key of ['credit', 'refs']) if (typeof saved[key] === 'boolean') state[key] = saved[key];
    if (Array.isArray(saved.range) && saved.range.length === 2 && saved.range.every(Number.isFinite) && saved.range[0] < saved.range[1]) state.range = [...saved.range];
  }
  state.focusedProvider = providerFocus.restore(ids, saved);
  state.creditBasis = ['subscription', 'billing'].includes(model.creditBasis) ? model.creditBasis : defaults.creditBasis;
  let basisPending = null;
  const displayCreditMode = () => state.creditBasis === 'billing' ? 'money' : state.creditMode;
  let hoveredProvider = null;
  function emphasize(provider) {
    const target = providerFocus.visible(ids, state.focusedProvider).includes(provider) ? provider : null;
    for (const node of el('chart').querySelectorAll('[data-series],[data-reset],[data-interpolated],[data-cycle-end],[data-forecast],[data-forecast-trend],[data-forecast-marker],[data-forecast-range]')) {
      const key = node.dataset.series || node.dataset.reset || node.dataset.interpolated || node.dataset.cycleEnd || node.dataset.forecast || node.dataset.forecastTrend || node.dataset.forecastMarker || node.dataset.forecastRange || '';
      const owner = providerKeys.find(id => key === id || key.startsWith(id + '-'));
      node.classList.toggle('ua-muted-trace', Boolean(target && owner && owner !== target));
    }
  }
  const save = () => api.setState(state);
  const fmt = time => new Date(time).toLocaleString('ko-KR', {month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false});
  const round = n => Math.round(n * 10) / 10;
  const dash = w => w === 'week' ? '7 4' : w === 'money' ? '1 5' : null;
  const command = name => api.postMessage({type: 'command', command: name});
  const number = n => typeof n === 'number' && Number.isFinite(n);
  const gaps = globalThis.usageAtlasGaps;
  const creditGraphs = globalThis.usageAtlasCreditSeries;
  const chartGraphs = globalThis.usageAtlasChartSeries;
  const forecasts = globalThis.usageAtlasForecast;
  const seriesKey = s => s.key || `${s.id}-${s.w}`;
  const axisCanvas = document.createElement('canvas'); axisCanvas.width = axisCanvas.height = 1;
  const axisContext = axisCanvas.getContext('2d');
  const measureAxis = text => axisContext.measureText(text).width;
  const creditAt = (id, time) => {const l = model.data[id]?.ledger || []; const n = d3.bisector(x => x.time).right(l, time) - 1; return n >= 0 ? l[n].credit?.[state.mode] ?? null : null;};
  const creditPoints = id => (model.data[id]?.ledger || []).map(p => ({...p, amount: p.credit?.[state.mode] ?? null, reset:p.credit?.reset, gapContext:state.mode === 'total' ? p.credit?.cumulativeSegment ?? p.credit?.segment : p.credit?.segment, gapPolicy:state.mode === 'total' ? 'cumulative' : 'cycle', continuous: !!p.credit?.[state.mode + 'Continuous']}));
  const creditUnit = id => model.data[id]?.ledgerUnit || 'USD';
  const creditAvailable = id => model.data[id]?.ledgerAvailable ?? number(model.data[id]?.last?.spentUsd);
  const canEstimate = id => {
    if (state.creditBasis === 'billing') return number(model.data[id]?.ledger?.at(-1)?.billing?.[state.mode]);
    const windows = Object.values(model.data[id]?.windows || {}).filter(points => number(points.at(-1)?.value));
    return creditAvailable(id) && windows.length > 0 && windows.every(points => number(creditGraphs.value(points.at(-1), state.mode, state.basis, points.at(-1)?.mult).y));
  };
  const feeNumber = n => globalThis.usageAtlasAmountFormat.format(n, state.mode === 'delta' ? 8 : 4);
  const creditNumber = (n, providerOrUnit) => globalThis.usageAtlasAmountFormat.format(n, providerOrUnit === 'codex' || providerOrUnit === 'credits' ? model.codexCreditDecimals : model.claudeUsdDecimals);
  const requestDraw = () => {cancelAnimationFrame(raf); raf = requestAnimationFrame(draw);};
  const historyDays = value => Number.isInteger(value) && value >= 1 && value <= 365 ? value : 7;
  const defaultRange = extent => bounded([model.now - historyDays(model.chartHistoryDays) * 86400000, model.now + week], extent);
  const resetRange = () => {state.range = null; if (view) view.domain = defaultRange(view.extent); save(); requestDraw();};
  function bounded(range, extent) {
    const span = Math.min(extent[1] - extent[0], Math.max(minSpan, range[1] - range[0]));
    const start = Math.max(extent[0], Math.min(extent[1] - span, range[0]));
    return [start, start + span];
  }
  function setRange(range, persist = true) {
    state.range = bounded(range, view.extent);
    view.domain = state.range;
    if (persist) save();
    requestDraw();
  }
  function navigator() {
    const {extent, domain} = view, duration = extent[1] - extent[0];
    const position = time => (time - extent[0]) / duration * 100;
    el('nav-thumb').style.left = position(domain[0]) + '%';
    el('nav-thumb').style.width = (domain[1] - domain[0]) / duration * 100 + '%';
    el('nav-thumb').dataset.compact = String((domain[1] - domain[0]) / duration * el('navigator').clientWidth < 36);
    el('nav-now').style.left = position(model.now) + '%';
    for (const [part, value, min, max] of [
      ['start', domain[0], extent[0], domain[1] - minSpan]
      , ['end', domain[1], domain[0] + minSpan, extent[1]]
      , ['pan', (domain[0] + domain[1]) / 2, extent[0] + (domain[1] - domain[0]) / 2, extent[1] - (domain[1] - domain[0]) / 2]
    ]) {
      const node = el('nav-' + part);
      node.setAttribute('aria-valuemin', min); node.setAttribute('aria-valuemax', max); node.setAttribute('aria-valuenow', value);
      node.setAttribute('aria-valuetext', part === 'pan' ? `${fmt(domain[0])} – ${fmt(domain[1])}` : fmt(value));
      node.setAttribute('aria-describedby', 'ua-nav-help');
    }
  }
  function providerInfo() {
    for (const id of ids) {
      const p = model.data[id], last = p?.last;
      const message = p?.status?.message || '수집 대기';
      const stale = Boolean(last && model.now - last.time > (number(model.staleAfterMs) ? model.staleAfterMs : 900000));
      const status = `${last?.plan || '요금제 미확인'} · ${message}${stale ? ' · 기록 지연' : ''}${last ? ' · ' + new Date(last.time).toLocaleTimeString('ko-KR', {hour: '2-digit', minute: '2-digit', hour12: false}) : ''}`;
      const detail = `${status} · 최근 관측 ${last ? fmt(last.time) : '없음'}${p?.status?.next ? ' · 다음 조회 ' + fmt(p.status.next) : ''}`;
      const descriptions = [];
      for (const w of ['five', 'week']) {
        const v = last?.windows[w]?.used, cell = root.querySelector(`[data-legend-cell="${id}-${w}"]`);
        cell.textContent = number(v) ? `${round(v)}% · 잔여 ${round(100 - v)}%` : '-';
        cell.title = `${labels[w]} ${number(v) ? `사용 ${round(v)}% · 잔여 ${round(100 - v)}%` : '-'}`;
        descriptions.push(cell.title);
      }
      el(id + '-status').textContent = status; el(id + '-status').title = detail;
      el(id).title = (state.focusedProvider === id ? '전체 모델 보기로 돌아가기' : names[id] + ' 집중 보기') + ' · ' + detail; el(id).dataset.stale = String(stale || message !== '정상');
      el(id).setAttribute('aria-label', `${names[id]} 집중 보기. 같은 버튼을 다시 누르면 전체 보기. ${descriptions.join('. ')}. ${detail}`);
      const unit = creditUnit(id), total = creditAt(id, model.now);
      const summary = !creditAvailable(id) || !number(total) ? '-' : unit === 'credits' ? `관측 감소 ${creditNumber(total, id)} 크레딧${number(last?.creditBalance) ? ' · 잔액 ' + creditNumber(last.creditBalance, id) : ''}` : `관측 지출 $${creditNumber(total, id)}`;
      const pending = state.credit && !canEstimate(id);
      const conversion = state.creditBasis === 'billing' ? (pending ? '금액 기준 · 가격 미확인' : '공식 월 기본 구독료 대비 지출 비율') : pending ? `자동 환산 대기 · ${!creditAvailable(id) ? '원단위 기록 없음' : state.mode === 'usage' && !number(total) ? '주간 기준 미확인' : '관측 근거 부족'} · 합산 대기` : state.creditMode === 'estimate' ? '사용률에 추정 합산' : '크레딧·금액 ' + ({usage: '주간 사용', delta: '변화량', total: '전체 누적'}[state.mode]);
      el(id).dataset.creditState = !state.credit ? 'off' : pending ? 'pending' : displayCreditMode() === 'estimate' ? 'estimated' : 'native';
      el(id + '-credit').textContent = !state.credit ? '' : pending ? (state.creditMode === 'money' ? summary + ' · 환산 대기' : conversion) : state.creditMode === 'estimate' ? '추정 합산 · ' + summary : summary;
      if (state.credit && state.creditBasis === 'billing') {const value = p?.ledger?.at(-1)?.billing?.[state.mode]; el(id + '-credit').textContent = (number(value) ? '금액 ' + feeNumber(value) + '% · ' : '금액 - · ') + summary;}
      el(id + '-credit').title = conversion + ' · ' + summary + (state.creditBasis === 'billing' ? ' · 기본 월 요금 ' + (number(p?.ledger?.at(-1)?.billing?.monthlyUsd) ? '$' + p.ledger.at(-1).billing.monthlyUsd : '-') + ' · 공식 가격 확인 ' + (p?.ledger?.at(-1)?.billing?.priceVerifiedAt || '-') + ' · 실제 청구액 아님' : '') + (unit === 'credits' ? ' · 잔액 감소 관측값이며 충전·만료·조정을 구분하는 결제 내역은 아닙니다.' : '');
      if (state.credit) el(id).setAttribute('aria-label', el(id).getAttribute('aria-label') + '. ' + summary + conversion);
    }
    const environment = `${model.host || '로컬'} · 기록 ${model.count ?? 0}건${model.storagePath ? ' · ' + model.storagePath : ''}`;
    el('environment').textContent = environment; el('environment').title = environment;
  }
  const quota = (id, w) => chartGraphs.quota(model.data[id], id, w, {...state, credit: state.credit && state.creditBasis !== 'billing'});

  function sync() {
    for (const k of ['mode', 'basis']) el(k).value = state[k];
    for (const k of ['credit', 'refs']) el(k).checked = state[k];
    const visible = providerFocus.visible(ids, state.focusedProvider);
    root.dataset.focusedProvider = state.focusedProvider || 'all';
    for (const id of ids) {el(id).setAttribute('aria-pressed', String(state.focusedProvider === id)); el(id).dataset.visible = String(visible.includes(id));}
    el('credit-mode').value = displayCreditMode(); el('credit-mode').disabled = !state.credit;
    el('credit-mode').querySelector('[value=estimate]').disabled = state.creditBasis === 'billing';
    for (const value of ['subscription', 'billing']) {el('credit-' + value).checked = state.creditBasis === value; el('credit-' + value).disabled = !state.credit;}
    root.dataset.creditBasis = state.creditBasis;
    root.dataset.creditMode = state.credit ? displayCreditMode() : 'off';
    el('refs').disabled = state.basis !== 'base' || state.mode === 'delta';
    state.theme = model.colorMode || 'system';
    root.style.setProperty('--ua-tooltip-opacity', (100 - (number(model.tooltipTransparency) ? Math.max(0, Math.min(100, model.tooltipTransparency)) : 14)) + '%');
    for (const [key, fallback, automatic] of [
        ['pageWidth', 1440, '100%']
      , ['pageHeight', 0, '100%']
    ]) {
      const value = Number.isInteger(model[key]) && model[key] >= 0 && model[key] <= 16384 ? model[key] : fallback;
      root.style.setProperty(key === 'pageWidth' ? '--ua-page-width' : '--ua-page-height', value === 0 ? automatic : value + 'px');
    }
    root.style.colorScheme = state.theme === 'system' ? ([2, 3].includes(model.theme) ? 'dark' : 'light') : state.theme;
    document.documentElement.style.colorScheme = root.style.colorScheme;
    document.body.style.backgroundColor = getComputedStyle(root).backgroundColor;
  }
  function draw() {
    const chartFocused = document.activeElement?.hasAttribute('data-chart-hit');
    const focusedLine = document.activeElement?.dataset?.detailsLine;
    const focusedForecast = document.activeElement?.dataset?.forecastMarker;
    const focusedForecastTrend = document.activeElement?.dataset?.forecastTrend;
    sync(); providerInfo(); el('tooltip').hidden = true;
    const svg = d3.select(el('chart')); svg.selectAll('*').remove();
    const chartBox = el('chart').getBoundingClientRect(), width = Math.max(240, chartBox.width), narrow = width < 700;
    const height = Math.max(200, chartBox.height), left = narrow ? 42 : 58, right = Math.max(left + 60, width - 12), top = 32;
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
    const visible = providerFocus.visible(ids, state.focusedProvider);
    const data = visible.flatMap(id => ['five', 'week'].flatMap(w => quota(id, w))).map(s => ({...s, bridges:gaps.bridges(s.points, 'y')}));
    const all = ids.flatMap(id => Object.values(model.data[id]?.windows || {}).flat());
    const resets = visible.flatMap(id => ['five', 'week'].map(w => ({id, w, time: model.data[id]?.last?.windows[w]?.reset}))).filter(r => number(r.time) && r.time > model.now);
    const events = visible.flatMap(id => (model.data[id]?.events || []).map(e => ({...e, id, w: e.window}))).filter(e => e.kind !== 'scheduled-reset');
    const start = model.firstObserved ?? d3.min(all, p => p.time) ?? model.now;
    // 첫 기록이 최근이어도 현재를 중앙에 놓도록 과거 빈 구간을 확보한다.
    const full = [Math.min(start, model.now - week), model.now + week];
    const domain = state.range ? bounded(state.range, full) : defaultRange(full);
    axisContext.font = `12px ${getComputedStyle(root).fontFamily}`;
    const axis = globalThis.usageAtlasTimeAxis.layout(domain, right - left, measureAxis);
    const dateRows = Math.max(1, ...axis.dates.map(tick => tick.row + 1)), axisRows = dateRows + (axis.hours.length ? 1 : 0);
    const bottom = height - 112 - Math.max(0, axisRows - 2) * 16;
    view = {extent: full, domain, left, right, width, top, bottom, height}; navigator();
    svg.attr('data-domain-start', domain[0]).attr('data-domain-end', domain[1]).attr('data-extent-start', full[0]).attr('data-extent-end', full[1]);
    const x = d3.scaleLinear().domain(domain).range([left, right]);
    const nativeCredits = visible.filter(id => state.credit && creditAvailable(id) && displayCreditMode() === 'money' && model.data[id]?.ledger.some(p => number(p.credit?.[state.mode])));
    const nativeData = nativeCredits.flatMap(id => creditGraphs.series(model.data[id], id, state)).map(s => ({...s, bridges: gaps.bridges(s.points, 'y')}));
    const forecastTrends = model.forecastEnabled === false ? [] : visible.flatMap(id => ['five', 'week'].map(w => {
      const provider = model.data[id], last = provider?.windows?.[w]?.at(-1), curve = forecasts.curve(provider?.forecast?.[w], last, state, model.now);
      if (!curve) return null;
      // 추정 합산 보기에서는 관측선과 같은 기준(구독 + 추가 크레딧 환산)에서 예상선을 잇는다.
      if (state.credit && displayCreditMode() === 'estimate') {
        const observed = quota(id, w).flatMap(s => s.points).find(p => p.time === last.time && number(p.y));
        if (!observed) return null;
        const offset = observed.y - curve.points[0].y;
        if (offset) {curve.points = curve.points.map(p => ({...p, y: p.y + offset})); curve.range = curve.range.map(p => ({...p, low: p.low + offset, high: p.high + offset}));}
      }
      return {id, w, ...curve};
    })).filter(s => s && s.points.at(-1).time >= domain[0] && s.points[0].time <= domain[1]);
    const rangeExtents = forecastTrends.flatMap(s => ['low','high'].map(field => ({...s, points: (s.range || []).map((p,i)=>({time:p.time,y:p[field],continuous:i>0}))})));
    const plotted = [...data, ...nativeData.filter(s => !s.billing), ...forecastTrends, ...rangeExtents];
    const {rawTotal, split, refs, maximum, unscaledMaximum} = chartGraphs.limits(plotted, domain, state);
    const units = [...new Set(nativeCredits.map(creditUnit))];
    const y = d3.scaleLinear().domain([0, maximum]).range([bottom, top]);
    const uy = d3.scaleLinear().domain([0, unscaledMaximum]).range([bottom, top]);
    const feeMaximum = chartGraphs.billingMaximum(nativeData, domain, state.mode);
    const by = d3.scaleLinear().domain([0, feeMaximum]).range([bottom, top]);
    const scale = s => s.billing ? by : split && !s.known ? uy : y;
    svg.attr('data-y-billing-max', state.creditBasis === 'billing' && state.credit ? feeMaximum : null);
    svg.attr('data-y-max', y.domain()[1]).attr('data-y-unscaled-max', uy.domain()[1]);
    const nativePoints = Object.fromEntries(nativeCredits.map(id => [id, creditPoints(id)]));
    const nativeBridges = Object.fromEntries(nativeCredits.map(id => [id, gaps.bridges(nativePoints[id], 'amount')]));
    const inView = (points, bridges) => {
      const values = points.filter(p => p.time >= domain[0] && p.time <= domain[1] && number(p.amount)).map(p => p.amount);
      for (const edge of domain) {
        const i = d3.bisector(p => p.time).left(points, edge), a = points[i - 1], b = points[i];
        if (a && b && b.continuous && number(a.amount) && number(b.amount)) values.push(a.amount + (b.amount - a.amount) * (edge - a.time) / (b.time - a.time));
      }
      return values.concat(gaps.visible(bridges, 'amount', domain));
    };
    const creditRanges = Object.fromEntries(units.map(unit => {
      const values = nativeCredits.filter(id => creditUnit(id) === unit).flatMap(id => inView(nativePoints[id], nativeBridges[id]));
      let lo = d3.min(values) ?? 0, hi = d3.max(values) ?? 1;
      return [unit, [lo, hi]];
    }));
    const text = (s, px, py, cls = '') => svg.append('text').attr('x', px).attr('y', py).attr('class', cls).text(s);
    const marker = (g, id, px, py, size = 40) => g.append('path').attr('d', d3.symbol().type(id === 'codex' ? d3.symbolCircle : d3.symbolDiamond).size(size)()).attr('transform', `translate(${px},${py})`).attr('fill', colors[id]).attr('stroke', 'var(--ua-bg)').attr('vector-effect', 'non-scaling-stroke');
    const estimated = [...data, ...nativeData].some(s => s.points.some(p => p.estimated)) || forecastTrends.length > 0;
    const pendingEstimate = state.credit && state.creditBasis !== 'billing' && visible.some(id => !canEstimate(id));
    const rawAxis = state.mode === 'total' ? '미환산 pp' : state.mode === 'delta' ? '원본 pp' : '원본 %';
    text((state.mode === 'delta' ? '변화량 pp' : state.mode === 'total' ? rawTotal && !split ? '관측 누적 pp' : '관측 누적 %' : split ? '기본 용량 %' : '사용률 %') + (estimated ? pendingEstimate ? ' (일부 추정)' : ' (추정)' : pendingEstimate ? ' · 환산 대기' : ''), left, top - 14, 'ua-axis');
    const insideAxis = (value, px, py) => text(value, px, py, 'ua-inside-axis').attr('text-anchor', 'end').attr('data-inside-axis', '');
    if (split) {insideAxis(rawAxis, right - 5, top - 14).append('title').text(state.mode === 'total' ? '배율 이력이 없는 관측 증가분은 원본 퍼센트포인트로 유지' : '배율 미확인: 해당 요금제 한도 기준'); for (const n of uy.ticks(3)) insideAxis(round(n), right - 5, uy(n) + 4);}
    if (state.credit && state.creditBasis === 'billing') {
      const offset = split ? Math.max(measureAxis(rawAxis), ...uy.ticks(3).map(value => measureAxis(String(round(value))))) + 16 : 0;
      const axisX = right - 5 - offset;
      insideAxis('금액 %', axisX, top - 14).attr('data-billing-axis', '').append('title').text('공식 월 기본 요금 대비 비율. 100%는 구독 한도 소진이 아닙니다.');
      for (const value of by.ticks(3)) insideAxis(feeNumber(value) + '%', axisX, by(value) + 4).attr('data-billing-tick', '');
    }
    const creditLegendRight = right - 5 - (state.creditBasis === 'billing' && state.credit ? 120 : 0) - (split ? Math.max(48, measureAxis(rawAxis)) + 10 : 0);
    let creditAxisRight = state.creditBasis === 'billing' ? left : creditLegendRight, creditLegendRow = 0;
    for (const unit of units) {
      const [lo, hi] = creditRanges[unit], name = unit === 'credits' ? '크레딧' : 'USD';
      const legendWidth = measureAxis(name + ' ' + creditNumber(lo, unit) + '–' + creditNumber(hi, unit));
      if (state.creditBasis !== 'billing' && creditAxisRight - legendWidth < left && creditAxisRight !== creditLegendRight) {creditAxisRight = creditLegendRight; creditLegendRow++;}
      const legend = insideAxis('', creditAxisRight, state.creditBasis === 'billing' ? top + 32 + creditLegendRow * 14 : top - 14 + creditLegendRow * 14).attr('text-anchor', state.creditBasis === 'billing' ? 'start' : 'end');
      legend.append('tspan').text(name + ' ');
      legend.append('tspan').attr('data-credit-minmax', unit).attr('data-value', lo).text(creditNumber(lo, unit));
      legend.append('tspan').text('–');
      legend.append('tspan').attr('data-credit-minmax', unit).attr('data-value', hi).text(creditNumber(hi, unit));
      legend.append('title').text(state.creditBasis === 'billing' ? '표시 구간 원단위 범위. 선 높이는 공식 월 구독료 대비 지출 비율입니다.' : '표시 구간 원단위 범위. 선 높이는 5시간·주간 구독 환산 사용률입니다.');
      if (state.creditBasis === 'billing') creditLegendRow++; else creditAxisRight -= legendWidth + 14;
    }
    // 기본 용량 기준선 외에도 일반 눈금을 더해 기준선보다 큰 값의 축을 읽을 수 있게 한다.
    const ticks = state.basis === 'base' && state.mode !== 'delta' ? [...new Set([0, ...refs, ...y.ticks(4).filter(n => refs.every(r => Math.abs(y(n) - y(r)) >= 14))])].sort((a, b) => a - b) : y.ticks(4);
    for (const n of ticks) {svg.append('line').attr('x1', left).attr('x2', right).attr('y1', y(n)).attr('y2', y(n)).attr('stroke', refs.includes(n) ? 'var(--ua-border)' : 'var(--ua-grid)'); text(round(n), left - 7, y(n) + 4).attr('text-anchor', 'end');}
    const frame = svg.append('rect').attr('data-chart-frame', '').attr('x', left).attr('y', top).attr('width', right - left).attr('height', bottom - top).attr('fill', 'none').attr('stroke', 'var(--ua-border)');
    svg.append('defs').append('clipPath').attr('id', 'ua-clip').append('rect').attr('x', left).attr('y', top).attr('width', right - left).attr('height', bottom - top);
    const g = svg.append('g').attr('clip-path', 'url(#ua-clip)');
    // 가까운 사건은 화면 좌표별로 묶어 긴 이력에서도 DOM 크기를 제한한다.
    const eventGroups = new Map();
    const latestChanges = new Map();
    for (const e of events) if (e.kind === 'schedule-change') {
      const key = `${e.id}-${e.w}`;
      if (!latestChanges.has(key) || latestChanges.get(key).time < e.time) latestChanges.set(key, e);
    }
    for (const e of events.filter(e => e.time >= domain[0] && e.time <= domain[1] && (e.kind !== 'schedule-change' || latestChanges.get(`${e.id}-${e.w}`) === e))) {
      const key = `${e.id}-${e.w}-${Math.round(x(e.time) / 8)}`;
      if (!eventGroups.has(key)) eventGroups.set(key, []);
      eventGroups.get(key).push(e);
    }
    const eventMarks = [...eventGroups.values()].map(group => ({...(group.findLast(e => e.kind === 'early-reset') || group.at(-1)), count: group.length}));
    for (const e of eventMarks) {
      const px = x(e.time), py = top + 12 + (e.w === 'week' ? 12 : 0);
      if (e.kind === 'early-reset') g.append('line').attr('data-event-line', `${e.id}-${e.w}`).attr('x1', px).attr('x2', px).attr('y1', top).attr('y2', bottom).attr('stroke', colors[e.id]).attr('stroke-dasharray', '2 5').attr('opacity', .38);
      g.append('path').attr('data-event', `${e.id}-${e.w}`).attr('data-event-kind', e.kind).attr('data-event-count', e.count).attr('data-time', e.time).attr('d', d3.symbol().type(e.kind === 'early-reset' ? d3.symbolTriangle : d3.symbolDiamond).size(50)()).attr('transform', `translate(${px},${py})`).attr('fill', colors[e.id]).attr('stroke', 'var(--ua-bg)');
    }
    const pointMarks = [];
    for (const s of data) {
      const chunks = []; let chunk = [];
      for (const p of s.points) {if (!p.continuous && chunk.length) {chunks.push(chunk); chunk = [];} if (number(p.y)) chunk.push(p); else if (chunk.length) {chunks.push(chunk); chunk = [];}}
      if (chunk.length) chunks.push(chunk);
      for (const points of chunks) {
        if (points.length === 1) {marker(g, s.id, x(points[0].time), scale(s)(points[0].y), 25).datum(points).attr('data-series', `${s.id}-${s.w}`).attr('data-series-known', s.known); pointMarks.push({s, p: points[0], ys: scale(s)});}
        else g.append('path').datum(points).attr('data-series', `${s.id}-${s.w}`).attr('d', d3.line().x(p => x(p.time)).y(p => scale(s)(p.y))).attr('fill', 'none').attr('stroke', colors[s.id]).attr('stroke-width', s.w === 'week' ? 1.1 : .9).attr('opacity', s.w === 'week' ? .95 : .82).attr('stroke-dasharray', dash(s.w)).attr('vector-effect', 'non-scaling-stroke').attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
      }
    }
    for (const s of nativeData) {
      const cy = scale(s), chunks = []; let chunk = [];
      for (const p of s.points) {
        if (p.continuous === false && chunk.length) {chunks.push(chunk); chunk = [];}
        if (number(p.y)) chunk.push(p); else if (chunk.length) {chunks.push(chunk); chunk = [];}
      }
      if (chunk.length) chunks.push(chunk);
      for (const points of chunks) {
        const node = points.length === 1 ? marker(g, s.id, x(points[0].time), cy(points[0].y), 25) : g.append('path').datum(points).attr('d', d3.line().x(p => x(p.time)).y(p => cy(p.y))).attr('stroke', colors[s.id]).attr('stroke-width', .8).attr('stroke-dasharray', s.creditWindow === 'week' ? '5 3 1 3' : dash('money')).attr('fill', 'none').attr('opacity', .68).attr('vector-effect', 'non-scaling-stroke').attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
        node.datum(points).attr('data-series', seriesKey(s)).attr('data-series-known', s.known).attr('data-credit-unit', creditUnit(s.id)).attr('data-credit-window', s.creditWindow);
        if (points.length === 1) pointMarks.push({s, p: points[0], ys: cy});
      }
    }
    const interpolated = [];
    const bridgeLine = (s, segments, field, ys) => {
      if (!segments.length) return;
      g.append('path').attr('data-interpolated', seriesKey(s)).attr('data-series-known', s.known).datum(segments).attr('d', segments.map(pair => `M${x(pair[0].time)},${ys(pair[0][field])}L${x(pair[1].time)},${ys(pair[1][field])}`).join('')).attr('fill','none').attr('stroke',colors[s.id]).attr('stroke-width',.85).attr('stroke-dasharray','3 5').attr('opacity',.5).attr('vector-effect','non-scaling-stroke');
      interpolated.push({...s, bridges:segments, field, ys, interpolated:true});
    };
    for (const s of data) bridgeLine(s, s.bridges, 'y', scale(s));
    for (const s of nativeData) bridgeLine(s, s.bridges, 'y', scale(s));
    const cycleEnds = new Map();
    for (const s of data) {
      const byTime = new Map(s.points.map(p => [p.time, p]));
      for (const next of s.points) if (['scheduled-reset', 'early-reset'].includes(next.event?.kind)) {
        const p = byTime.get(next.event.fromTime);
        if (next.time > model.now || !p || !number(p.y) || p.time < domain[0] || p.time > domain[1]) continue;
        cycleEnds.set(`${s.id}-${s.w}-${Math.round(x(p.time) / 8)}`, {s, p, event:next.event});
      }
    }
    // 완료 주기의 실제 마지막 관측점만 표시하며 경계의 마커도 잘리지 않게 한다.
    svg.select('defs').append('clipPath').attr('id', 'ua-marker-clip').append('rect').attr('x', left - 5).attr('y', top - 5).attr('width', right - left + 10).attr('height', bottom - top + 10);
    const ends = svg.append('g').attr('clip-path', 'url(#ua-marker-clip)');
    for (const {s, p, event} of cycleEnds.values()) marker(ends, s.id, x(p.time), scale(s)(p.y), 30).datum(p).attr('data-cycle-end', `${s.id}-${s.w}`).attr('data-time', p.time).attr('data-reset-kind', event.kind).attr('fill', 'var(--ua-bg)').attr('stroke', colors[s.id]).attr('stroke-width', 1);
    const markerBuckets = new Map();
    for (const point of [...cycleEnds.values()].map(p => ({...p, ys: scale(p.s)})).concat(pointMarks)) {
      if (point.p.time < domain[0] || point.p.time > domain[1]) continue;
      const px = x(point.p.time), py = point.ys(point.p.y), key = Math.floor(px / 8);
      if (!markerBuckets.has(key)) markerBuckets.set(key, []);
      markerBuckets.get(key).push({...point, px, py});
    }
    for (const r of resets) if (r.time >= domain[0] && r.time <= domain[1]) g.append('line').attr('data-reset', `${r.id}-${r.w}`).attr('x1', x(r.time)).attr('x2', x(r.time)).attr('y1', top).attr('y2', bottom).attr('stroke', colors[r.id]).attr('stroke-dasharray', r.w === 'five' ? '3 4' : '9 5');
    const predictions = model.forecastEnabled === false ? [] : visible.flatMap(id => ['five', 'week'].map(w => ({id, w, ...forecasts.present(model.data[id]?.forecast?.[w], model.now)}))).filter(p => p.state === 'predicted' && p.eta >= domain[0] && p.eta <= domain[1]);
    const forecastTrendMap = new Map(forecastTrends.map(s => [s.id + '-' + s.w, s]));
    const predictionY = p => {
      const curve = forecastTrendMap.get(p.id + '-' + p.w);
      return curve ? scale(curve)(curve.points.at(-1).y) : Math.min(bottom - 6, top + 40 + (p.w === 'week' ? 14 : 0));
    };
    for (const s of forecastTrends) {
      const ys = scale(s), a = s.points[0], b = s.points.at(-1);
      if (s.range?.length > 1) {const points = [...s.range.map(p=>[x(p.time),ys(p.high)]), ...s.range.slice().reverse().map(p=>[x(p.time),ys(p.low)])]; g.append('path').datum(s.range).attr('data-forecast-range',s.id+'-'+s.w).attr('d','M'+points.map(p=>p.join(',')).join('L')+'Z').attr('fill',colors[s.id]).attr('opacity',.09).attr('stroke','none').attr('role','img').attr('aria-label',names[s.id]+' '+labels[s.w]+' 과거 예측 오차 범위. 신뢰구간이 아닙니다.');}

      g.append('path').datum(s).attr('data-forecast-trend', s.id + '-' + s.w).attr('data-start-time', a.time).attr('data-end-time', b.time).attr('data-start-value', a.y).attr('data-end-value', b.y).attr('data-end-kind', s.endKind).attr('d', d3.line().x(p => x(p.time)).y(p => ys(p.y))(s.points)).attr('fill', 'none').attr('stroke', colors[s.id]).attr('stroke-width', 1).attr('stroke-dasharray', s.w === 'week' ? '9 4 2 4' : '5 4').attr('opacity', .65).attr('vector-effect', 'non-scaling-stroke').attr('stroke-linecap', 'round').attr('tabindex', 0).attr('role', 'img').attr('aria-label', names[s.id] + ' ' + labels[s.w] + ' 구독 사용량 예측. ' + (s.endKind === 'exhaustion' ? '100% 소진 예상 ' : '초기화 전 예상 ') + fmt(b.time));
      if (s.endKind === 'reset' && b.time >= domain[0] && b.time <= domain[1]) marker(g, s.id, x(b.time), ys(b.y), 28).attr('data-forecast-boundary', s.id + '-' + s.w).attr('fill', 'var(--ua-bg)').attr('stroke', colors[s.id]).attr('stroke-width', 1);
    }
    for (const p of predictions) {
      const title = names[p.id] + ' / ' + labels[p.w] + ' / 100% 소진 예상 ' + fmt(p.eta);
      g.append('line').attr('data-forecast', p.id + '-' + p.w).attr('data-time', p.eta).attr('x1', x(p.eta)).attr('x2', x(p.eta)).attr('y1', top).attr('y2', bottom).attr('stroke', colors[p.id]).attr('stroke-width', .8).attr('stroke-dasharray', '1 6').attr('opacity', .7);
      marker(g, p.id, x(p.eta), predictionY(p), 28).datum(p).attr('data-forecast-marker', p.id + '-' + p.w).attr('fill', 'var(--ua-bg)').attr('stroke', colors[p.id]).attr('stroke-width', 1).attr('tabindex', 0).attr('role', 'img').attr('aria-label', title).append('title').text(title);
    }
    if (model.now >= domain[0] && model.now <= domain[1]) {g.append('line').attr('data-now', '').attr('x1', x(model.now)).attr('x2', x(model.now)).attr('y1', top).attr('y2', bottom).attr('stroke', 'var(--ua-focus)').attr('stroke-dasharray', '2 4'); text('현재', Math.max(left + 14, Math.min(right - 14, x(model.now))), state.credit && state.creditBasis === 'billing' && narrow ? Math.min(bottom - 8, top + 76) : units.length || state.credit && displayCreditMode() === 'estimate' ? top + 14 : top - 14, 'ua-inside-axis').attr('text-anchor', 'middle').attr('fill', 'var(--ua-focus)');}
    for (const [kind, ticks, length] of [['day', axis.dayTicks, 8], ['hour', axis.hourTicks, 4]]) {
      svg.append('path').attr(`data-${kind}-ticks`, ticks.length).attr('d', ticks.map(px => `M${left + px},${bottom}v${length}`).join('')).attr('stroke', 'var(--ua-muted)').attr('stroke-width', kind === 'day' ? 1 : .6).attr('opacity', kind === 'day' ? .8 : .5).attr('fill', 'none');
    }
    for (const tick of axis.hours) text(tick.text, left + tick.x, bottom + 19).attr('data-hour-label', '').attr('data-axis-time', tick.time).attr('data-axis-context', !!tick.context).attr('text-anchor', tick.anchor);
    for (const tick of axis.dates) text(tick.text, left + tick.x, bottom + (axis.hours.length ? 35 : 19) + tick.row * 16).attr('data-date-tick', '').attr('data-date-keys', tick.keys.join(',')).attr('data-axis-time', tick.time).attr('data-axis-context', !!tick.context).attr('text-anchor', tick.anchor);
    // 초기화 표시는 그래프의 선에 직접 연결한다. 별도 목록은 만들지 않는다.
    const placed = [];
    for (const r of resets.filter(r => r.time >= domain[0] && r.time <= domain[1]).sort((a, b) => a.time - b.time)) {
      const label = text(`${names[r.id]} ${labels[r.w]}`, 0, 0); const w = label.node().getComputedTextLength(); const px = Math.max(4, Math.min(width - w - 4, x(r.time) - w));
      let row = 0; while (placed.some(p => p.row === row && px < p.end + 8 && px + w > p.start - 8)) row++;
      placed.push({row, start: px, end: px + w}); const py = bottom + 23 + axisRows * 16 + row * 16;
      label.attr('x', px).attr('y', py).attr('fill', colors[r.id]).attr('data-reset-label', `${r.id}-${r.w}`).append('title').text(fmt(r.time));
      svg.append('line').attr('x1', x(r.time)).attr('x2', px + w).attr('y1', bottom + 3).attr('y2', py - 5).attr('stroke', colors[r.id]).attr('opacity', .5);
    }
    if (!all.length) text('사용량 수집 대기', (left + right) / 2, (top + bottom) / 2).attr('text-anchor', 'middle');
    const guide = g.append('line').attr('y1', top).attr('y2', bottom).attr('stroke', 'var(--ua-muted)').attr('visibility', 'hidden');
    const selection = g.append('rect').attr('y', top).attr('height', bottom - top).attr('width', 0).attr('fill', 'var(--ua-text)').attr('opacity', .12);
    const hit = svg.append('rect').attr('data-chart-hit', '').attr('tabindex', 0).attr('role', 'application').attr('aria-label', '사용량 그래프. 중간 버튼 드래그 수평 이동, 우클릭 드래그 중앙 기준 핀치 확대 축소, Ctrl 휠 마우스 위치 기준 확대 축소, Shift 휠 수평 이동. 좌우 방향키 탐색, 더하기 빼기 확대 축소, Home 설정한 기본 기간').attr('x', left).attr('y', top).attr('width', right - left).attr('height', bottom - top).attr('fill', 'transparent').style('touch-action', 'pan-y');
    let down = null, press = null, cursor = Math.min(model.now, domain[1]);
    const clear = () => {el('tooltip').hidden = true; delete el('tooltip').dataset.series; delete el('tooltip').dataset.detail; guide.attr('visibility', 'hidden');};
    const tipLine = (text, active = false) => {const div = document.createElement('div'); div.textContent = text; if (active) div.className = 'ua-tip-active'; el('tooltip').append(div);};
    const traces = [...data.map(s => ({...s, ys: scale(s), value: p => p.y})), ...nativeData.map(s => ({...s, ys: scale(s), value: p => p.y})), ...interpolated];
    const near = (s, px, py, time) => {
      if (s.interpolated) {
        const pair = s.bridges[d3.bisector(pair => pair[1].time).left(s.bridges, time)];
        if (!pair || time < pair[0].time || pair[1].time > model.now) return;
        const value = gaps.at(pair, s.field, time);
        return {s, p:{time, value, amount: s.w === 'credit' && pair.every(p => number(p.amount)) ? gaps.at(pair, 'amount', time) : null}, distance:Math.abs(py - s.ys(value))};
      }
      const index = d3.bisector(p => p.time).left(s.points, time), a = s.points[index - 1], b = s.points[index];
      const valid = p => p && p.time <= model.now && number(s.value(p));
      const candidates = [a, b].filter(valid).map(p => ({s, p, distance: Math.hypot(px - x(p.time), py - s.ys(s.value(p)))}));
      if (valid(a) && valid(b) && b.continuous) {
        const ax = x(a.time), ay = s.ys(s.value(a)), dx = x(b.time) - ax, dy = s.ys(s.value(b)) - ay;
        const ratio = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        candidates.push({s, p: ratio < .5 ? a : b, distance: Math.hypot(px - ax - ratio * dx, py - ay - ratio * dy)});
      }
      return candidates.sort((a, b) => a.distance - b.distance)[0];
    };
    const openDetails = (s, time, target) => {
      details?.open({provider: s.id, window: s.creditWindow || s.w, time, start: domain[0], end: domain[1]}, target);
    };
    // The hit layer keeps pointer gestures; rendered lines are separate keyboard targets.
    const lineTargets = new Set();
    svg.selectAll('[data-series], [data-interpolated]').each(function() {
      const key = this.dataset.series || this.dataset.interpolated;
      if (!details || lineTargets.has(key)) return;
      const trace = traces.find(s => seriesKey(s) === key && Boolean(s.interpolated) === Boolean(this.dataset.interpolated) && (this.dataset.seriesKnown == null || String(s.known) === this.dataset.seriesKnown));
      if (!trace) return;
      const segments = trace.interpolated ? trace.bridges : [this.__data__ || []];
      const points = segments.find(segment => segment.length && segment[0].time <= Math.min(model.now, domain[1]) && segment.at(-1).time >= domain[0]);
      if (!points) return;
      lineTargets.add(key);
      const time = Math.max(domain[0], Math.min(model.now, domain[1], points.at(-1).time));
      d3.select(this).attr('data-details-line', key).attr('tabindex', 0).attr('role', 'button').attr('aria-haspopup', 'dialog').attr('aria-label', `${names[trace.id]} ${trace.w === 'credit' ? trace.billing ? '금액' : labels[trace.creditWindow] + ' 환산 ' + (creditUnit(trace.id) === 'credits' ? '크레딧' : 'USD') : labels[trace.w]} 선 상세 분석. Enter 또는 Space로 열기`).on('keydown.details', function(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); event.stopPropagation(); openDetails(trace, time, this);
      });
    });
    const usageText = (s, value, estimated = false) => {
      const credit = s.w === 'credit';
      const unit = credit ? ` ${creditUnit(s.id) === 'credits' ? '크레딧' : 'USD'}` : state.mode === 'delta' || state.mode === 'total' && !s.known ? 'pp' : '%';
      return number(value) ? `${estimated ? '≈' : ''}${credit ? creditNumber(value, s.id) : round(value)}${unit}` : '-';
    };
    const periodText = s => s.billing ? '금액' : s.w === 'credit' ? labels[s.creditWindow] + ' 환산' : labels[s.w];
    const seriesTip = (s, value, estimated = false, normalized) => tipLine(`${names[s.id]} / ${periodText(s)} / ${s.w === 'credit' && number(normalized) ? '≈' + (s.billing ? feeNumber(normalized) : round(normalized)) + (s.billing ? '% (구독료)' : state.mode === 'delta' || state.mode === 'total' && !s.known ? 'pp' : '%') + ' · ' : ''}${usageText(s, value, s.w === 'credit' ? s.interpolated : estimated)}`, true);
    const timeRange = (a, b) => {
      if (!number(a)) return number(b) ? fmt(b) : '-';
      if (!number(b) || a === b) return fmt(a);
      const end = new Date(a).toDateString() === new Date(b).toDateString() ? new Date(b).toLocaleTimeString('ko-KR', {hour: '2-digit', minute: '2-digit', hour12: false}) : fmt(b);
      return `${fmt(a)} → ${end}`;
    };
    const detailTips = items => {
      const groups = new Map();
      for (const {s, p, event} of items) {
        const e = event || p?.event, rows = [], notes = [], credit = s.w === 'credit';
        const transition = e ? `${round(e.before)}% → ${round(e.after)}%` : '';
        const merged = e && (!p || state.mode === 'usage' && !p.estimated && p.y === p.value && [e.before, e.after].includes(p.value));
        let header = `${periodText(s)} / ${merged ? transition : s.billing ? feeNumber(p.y) + '% (구독료) · ' + usageText(s, p.amount) : usageText(s, credit ? p.amount : p.y, !credit && p?.estimated)}`;
        if (e) {
          header += ` · ${eventLabels[e.kind]}${e.count > 1 ? ' · ' + e.count + '건' : ''}`;
          rows.push(`${merged ? '' : transition + ' · '}관측 ${timeRange(e.fromTime, e.time)}`);
          if (p && ![e.fromTime, e.time].includes(p.time)) rows.push(`마커 ${fmt(p.time)}`);
          if (number(e.previousReset) && number(e.reset) && e.previousReset !== e.reset) rows.push(`예정 ${timeRange(e.previousReset, e.reset)}`);
          else if (number(e.reset)) rows.push(`초기화 ${fmt(e.reset)}`);
          if (['early-reset', 'scheduled-reset'].includes(e.kind)) {
            if (e.after > 0) notes.push(`0% 가정 · 첫 ${round(e.after)}% 포함`);
            if (s.w === 'week') notes.push('크레딧 재시작(누적 유지)');
          } else if (e.kind === 'decrease') notes.push('사유 미확인 · 최고값까지 회복 제외 · 크레딧 주기 유지');
        } else {
          rows.push(`관측 ${fmt(p.time)}${credit && state.mode !== 'delta' ? ' · 변화 ' + usageText(s, p.delta) : ''}`);
          if (number(p.reset)) rows.push(`초기화 ${fmt(p.reset)}`);
          if (p.resetEstimated) notes.push('초기화 0% 가정 포함');
        }
        if (!credit && p) {
          if (!e && (state.mode !== 'usage' || p.y !== p.value)) header += ` · 원본 ${round(p.value)}%`;
          if (number(p.mult) && p.mult !== 1) header += ` · ×${p.mult}`;
          if (p.estimated) header += ' · 크레딧 포함';
          if (p.recoveryExcluded > 0) notes.push(`회복 ${round(p.recoveryExcluded)}pp 제외(최고 ${round(p.recoveryPeak)}%)`);
        }
        if (notes.length) rows.push(notes.join(' · '));
        const key = JSON.stringify([header, rows]);
        if (!groups.has(key)) groups.set(key, {ids: new Set(), header, rows});
        groups.get(key).ids.add(s.id);
      }
      for (const group of groups.values()) {tipLine(`${[...group.ids].map(id => names[id]).join(' · ')} / ${group.header}`, true); for (const row of group.rows) tipLine(row);}
    };
    const nearForecast = (s, px, py, time) => {
      if (!number(py) || time < s.points[0].time || time > s.points.at(-1).time) return null;
      const index = Math.max(1, Math.min(s.points.length - 1, d3.bisector(p => p.time).left(s.points, +time)));
      const a = s.points[index - 1], b = s.points[index];
      const ys = scale(s), ax = x(a.time), ay = ys(a.y), dx = x(b.time) - ax, dy = ys(b.y) - ay;
      const ratio = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
      return {s, value: gaps.at([a, b], 'y', time), distance: Math.hypot(px - ax - ratio * dx, py - ay - ratio * dy)};
    };
    const show = (px, py) => {
      const time = x.invert(px); cursor = time; guide.attr('x1', px).attr('x2', px).attr('visibility', 'visible');
      const matches = number(py) ? traces.map(s => near(s, px, py, time)).filter(p => p && p.distance <= 8).sort((a, b) => a.distance - b.distance) : [];
      const selectedBySeries = new Map();
      for (const match of matches.filter(p => p.distance <= matches[0].distance + .75)) {
        const key = seriesKey(match.s), previous = selectedBySeries.get(key);
        if (!previous || previous.s.interpolated && !match.s.interpolated) selectedBySeries.set(key, match);
      }
      const selected = [...selectedBySeries.values()];
      el('tooltip').replaceChildren(); delete el('tooltip').dataset.series; delete el('tooltip').dataset.detail;
      tipLine(fmt(time));
      const eventHit = number(py) ? eventMarks.filter(e => Math.hypot(px - x(e.time), py - top - 12 - (e.w === 'week' ? 12 : 0)) <= 9 || e.kind === 'early-reset' && Math.abs(px - x(e.time)) < 4) : [];
      const pointHit = [];
      if (number(py)) for (let key = Math.floor((px - 6) / 8); key <= Math.floor((px + 6) / 8); key++) for (const point of markerBuckets.get(key) || []) {
        const distance = Math.hypot(px - point.px, py - point.py);
        if (distance <= 6) pointHit.push({...point, distance});
      }
      pointHit.sort((a, b) => a.distance - b.distance);
      const forecastHit = number(py) ? predictions.filter(p => Math.abs(x(p.eta) - px) < 4 && (time >= model.now || Math.hypot(px - x(p.eta), py - predictionY(p)) <= 8)) : [];
      const trendHits = forecastTrends.map(s => nearForecast(s, px, py, time)).filter(p => p && p.distance <= 8).sort((a, b) => a.distance - b.distance);
      const resetHit = number(py) ? resets.filter(r => r.time >= domain[0] && r.time <= domain[1] && Math.abs(x(r.time) - px) < 4) : [];
      if (eventHit.length) {
        el('tooltip').dataset.series = 'event'; el('tooltip').dataset.detail = 'event';
        detailTips(eventHit.map(e => ({s: {id: e.id, w: e.w}, event: e})));
      } else if (pointHit.length) {
        el('tooltip').dataset.series = seriesKey(pointHit[0].s); el('tooltip').dataset.detail = 'marker';
        const uniquePoints = new Map();
        for (const point of pointHit) if (!uniquePoints.has(seriesKey(point.s))) uniquePoints.set(seriesKey(point.s), point);
        detailTips(uniquePoints.values());
      } else if (forecastHit.length) {
        el('tooltip').dataset.series = 'forecast'; el('tooltip').dataset.detail = 'forecast';
        const groups = new Map();
        for (const p of forecastHit) {const key = p.id + '-' + p.eta; if (!groups.has(key)) groups.set(key, {...p, windows: []}); groups.get(key).windows.push(labels[p.w]);}
        for (const p of groups.values()) tipLine(names[p.id] + ' / ' + p.windows.join('·') + ' / 100% 소진 예상 ≈' + fmt(p.eta), true);
      } else if (trendHits.length && (!selected.length || trendHits[0].distance <= matches[0].distance + .75)) {
        el('tooltip').dataset.series = 'forecast-trend'; el('tooltip').dataset.detail = 'forecast-trend';
        for (const {s, value} of trendHits.filter(p => p.distance <= trendHits[0].distance + .75)) {
          const unit = state.mode === 'total' && !s.known ? 'pp' : '%'; let range = '';
          const band = s.range || [];
          if (band.length > 1 && time >= band[0].time && time <= band.at(-1).time) {const index=Math.max(1,d3.bisector(p=>p.time).left(band,time)),pair=[band[index-1],band[index]];range=' · 과거 오차 '+round(gaps.at(pair,'low',time))+'–'+round(gaps.at(pair,'high',time))+unit;}
          tipLine(names[s.id] + ' / ' + labels[s.w] + ' 구독 예측 / ≈' + round(value) + unit + range, true);
        }
      } else if (resetHit.length) {
        el('tooltip').dataset.series = 'reset'; el('tooltip').dataset.detail = 'reset';
        const resetGroups = new Map();
        for (const r of resetHit) {const key = `${r.id}-${r.time}`; if (!resetGroups.has(key)) resetGroups.set(key, {id: r.id, time: r.time, windows: []}); resetGroups.get(key).windows.push(labels[r.w]);}
        for (const r of resetGroups.values()) tipLine(`${names[r.id]} / ${r.windows.join('·')} / 초기화 ${fmt(r.time)}`, true);
      } else if (selected.length) {
        el('tooltip').dataset.series = seriesKey(selected[0].s);
        for (const {s, p} of selected) seriesTip(s, s.w === 'credit' ? p.amount : s.interpolated ? p.value : s.value(p), s.interpolated || p.estimated, s.interpolated ? p.value : s.value(p));
      }
      el('tooltip').hidden = false; const tw = el('tooltip').offsetWidth, th = el('tooltip').offsetHeight;
      el('tooltip').style.left = Math.max(4, Math.min(width - tw - 4, px + tw + 12 > width ? px - tw - 12 : px + 12)) + 'px';
      el('tooltip').style.top = Math.max(top, Math.min(bottom - th, number(py) ? py + 12 : top + 12)) + 'px';
    };
    svg.selectAll('[data-forecast-trend]').on('focus.forecast', function() {
      const s = this.__data__, time = (Math.max(domain[0], s.points[0].time) + Math.min(domain[1], s.points.at(-1).time)) / 2;
      const index = Math.max(1, Math.min(s.points.length - 1, d3.bisector(p => p.time).left(s.points, time)));
      show(x(time), scale(s)(gaps.at([s.points[index - 1], s.points[index]], 'y', time)));
    }).on('blur.forecast', clear).on('keydown.forecast', event => {if (event.key === 'Escape') clear();});
    svg.selectAll('[data-forecast-marker]').on('focus.forecast', function() {const p = this.__data__; show(x(p.eta), predictionY(p));}).on('blur.forecast', clear).on('keydown.forecast', event => {if (event.key === 'Escape') clear();});
    const px = e => Math.max(left, Math.min(right, d3.pointer(e, svg.node())[0]));
    hit.on('pointerdown', function(e) {
      if (e.button !== 0 || chartDrag) {if (e.button === 1 || e.button === 2) clear(); return;}
      if (press) return;
      down = px(e); press = {id: e.pointerId, x: e.clientX, y: e.clientY, movement: 0}; this.setPointerCapture(e.pointerId); show(down, d3.pointer(e, svg.node())[1]);
    });
    hit.on('pointermove', e => {
      if (chartDrag) return;
      const p = px(e); show(p, d3.pointer(e, svg.node())[1]);
      if (press && e.pointerId === press.id) press.movement = Math.max(press.movement, Math.hypot(e.clientX - press.x, e.clientY - press.y));
      if (down !== null) selection.attr('x', Math.min(p, down)).attr('width', Math.abs(p - down));
    });
    hit.on('pointerup', e => {
      if (!press || e.pointerId !== press.id || e.button !== 0) return;
      const p = px(e), py = d3.pointer(e, svg.node())[1], movement = Math.max(press.movement, Math.hypot(e.clientX - press.x, e.clientY - press.y));
      if (down !== null && Math.abs(p - down) > 12) setRange([x.invert(Math.min(p, down)), x.invert(Math.max(p, down))]);
      else if (movement <= 6 && !chartDrag) {
        const match = traces.map(s => near(s, p, py, x.invert(p))).filter(value => value && value.distance <= 8).sort((a, b) => a.distance - b.distance)[0];
        const predicted = forecastTrends.map(s => nearForecast(s, p, py, x.invert(p))).filter(value => value && value.distance <= 8).sort((a, b) => a.distance - b.distance)[0];
        if (match && (!predicted || match.distance <= predicted.distance + .01)) {
          const target = svg.node().querySelector(`[data-details-line="${seriesKey(match.s)}"]`) || hit.node();
          target.focus({preventScroll: true}); clear(); openDetails(match.s, match.p.time, target);
        }
      }
      down = null; press = null; selection.attr('width', 0);
      if (hit.node().hasPointerCapture(e.pointerId)) hit.node().releasePointerCapture(e.pointerId);
    });
    const cancelPress = () => {down = null; press = null; selection.attr('width', 0); clear();};
    hit.on('pointercancel', cancelPress); hit.on('lostpointercapture', () => {if (press) cancelPress();});
    hit.on('pointerleave', () => {if (down === null) clear();});
    hit.on('dblclick', e => {if (e.button === 0) resetRange();});
    hit.on('focus', () => frame.classed('ua-focus', true)); hit.on('blur', () => {frame.classed('ua-focus', false); clear();});
    hit.on('keydown', e => {
      const span = domain[1] - domain[0];
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') show(x(Math.max(domain[0], Math.min(domain[1], cursor + span / 100 * (e.key === 'ArrowLeft' ? -1 : 1)))));
      else if (['+', '=', '-', '_', 'Home'].includes(e.key)) {
        const next = Math.min(full[1] - full[0], Math.max(60000, span * (['+', '='].includes(e.key) ? .5 : 2)));
        const lo = Math.max(full[0], Math.min(full[1] - next, cursor - next / 2));
        state.range = e.key === 'Home' ? null : [lo, lo + next]; save(); draw(); el('chart').querySelector('[data-chart-hit]')?.focus();
      } else if (e.key === 'Escape') clear(); else return; e.preventDefault();
    });
    const note = `${fmt(domain[0])} – ${fmt(domain[1])}`;
    el('range').textContent = note; el('range').title = note; el('range').setAttribute('aria-label', note);
    svg.selectAll('[data-inside-axis]').raise(); emphasize(hoveredProvider);
    if (focusedForecastTrend) (svg.node().querySelector('[data-forecast-trend="' + focusedForecastTrend + '"]') || hit.node()).focus({preventScroll: true});
    else if (focusedForecast) svg.node().querySelector('[data-forecast-marker="' + focusedForecast + '"]')?.focus({preventScroll: true});
    else if (chartFocused) hit.node().focus({preventScroll: true});
    else if (focusedLine && !details?.isOpen()) svg.node().querySelector(`[data-details-line="${focusedLine}"]`)?.focus({preventScroll: true});
  }
  for (const key of ['mode', 'basis']) el(key).addEventListener('change', () => {state[key] = el(key).value; save(); requestDraw();});
  for (const key of ['credit', 'refs']) el(key).addEventListener('change', () => {state[key] = el(key).checked; save(); requestDraw();});
  for (const basis of ['subscription', 'billing']) el('credit-' + basis).addEventListener('change', event => {if (!event.target.checked) return; state.creditBasis = basis; basisPending = basis; save(); api.postMessage({type: 'creditBasis', value: basis}); requestDraw();});
  el('credit-mode').addEventListener('change', () => {state.creditMode = el('credit-mode').value; save(); requestDraw();});
  for (const id of ids) {
    el(id).addEventListener('click', () => {state.focusedProvider = providerFocus.toggle(ids, state.focusedProvider, id); hoveredProvider = null; save(); requestDraw();});
    for (const event of ['pointerenter', 'focus']) el(id).addEventListener(event, () => {hoveredProvider = id; emphasize(id);});
    for (const event of ['pointerleave', 'blur']) el(id).addEventListener(event, () => {hoveredProvider = null; emphasize(null);});
  }
  el('settings').addEventListener('click', () => command('settings'));
  const chart = el('chart');
  chart.addEventListener('pointerdown', e => {
    if (![1, 2].includes(e.button) || !view || gesture || chartDrag || !e.target.closest('[data-chart-hit]')) return;
    const box = chart.getBoundingClientRect(), range = [...view.domain];
    const center = {x: box.left + (view.left + view.right) / 2 * box.width / view.width, y: box.top + (view.top + view.bottom) / 2 * box.height / view.height};
    const radius = Math.hypot(e.clientX - center.x, e.clientY - center.y), span = range[1] - range[0], maxSpan = view.extent[1] - view.extent[0];
    chartDrag = {type: e.button === 1 ? 'pan' : 'zoom', pointerId: e.pointerId, x: e.clientX, range, original: state.range && [...state.range], width: (view.right - view.left) * box.width / view.width, center, radius, anchor: (range[0] + range[1]) / 2, maxSpan, rate: radius < 16 ? Math.LN2 / 80 : Math.max(Math.log(maxSpan / span), Math.LN2) / radius};
    if (chartDrag.type === 'pan') chart.dataset.pan = 'true'; else chart.dataset.zoom = 'in';
    chart.setPointerCapture(e.pointerId); e.preventDefault();
  });
  chart.addEventListener('pointermove', e => {
    if (!chartDrag || e.pointerId !== chartDrag.pointerId) return;
    const {type, x, range, width, center, radius, anchor, maxSpan, rate} = chartDrag;
    if (type === 'pan') {
      const offset = (e.clientX - x) / width * (range[1] - range[0]);
      setRange(range.map(t => t - offset), false);
    } else {
      const distance = Math.hypot(e.clientX - center.x, e.clientY - center.y);
      const span = Math.exp(Math.max(Math.log(minSpan), Math.min(Math.log(maxSpan), Math.log(range[1] - range[0]) + (radius - distance) * rate)));
      chart.dataset.zoom = span > view.domain[1] - view.domain[0] ? 'out' : 'in';
      setRange([anchor - span / 2, anchor + span / 2], false);
    }
    e.preventDefault();
  });
  const finishChartDrag = e => {
    if (!chartDrag || e.pointerId !== chartDrag.pointerId) return;
    if (e.type === 'pointercancel') state.range = chartDrag.original;
    chartDrag = null; delete chart.dataset.pan; delete chart.dataset.zoom; save(); requestDraw();
    if (chart.hasPointerCapture(e.pointerId)) chart.releasePointerCapture(e.pointerId);
  };
  chart.addEventListener('pointerup', finishChartDrag); chart.addEventListener('pointercancel', finishChartDrag); chart.addEventListener('lostpointercapture', finishChartDrag);
  chart.addEventListener('auxclick', e => {if (e.button === 1 || e.button === 2) e.preventDefault();});
  chart.addEventListener('contextmenu', e => e.preventDefault());
  el('chart').addEventListener('wheel', e => {
    if (!view || (!e.ctrlKey && !e.shiftKey)) return;
    e.preventDefault();
    if (gesture || chartDrag || e.buttons) return;
    const {domain, extent, left, right, width} = view, span = domain[1] - domain[0];
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (e.ctrlKey ? el('chart').clientHeight : right - left) : 1;
    const delta = (e.ctrlKey ? e.deltaY || e.deltaX : e.deltaX || e.deltaY) * unit;
    if (!Number.isFinite(delta) || delta === 0) return;
    if (e.ctrlKey) {
      const box = el('chart').getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, ((e.clientX - box.left) * width / box.width - left) / (right - left)));
      const anchor = domain[0] + ratio * span;
      const next = Math.min(extent[1] - extent[0], Math.max(minSpan, span * Math.exp(Math.max(-500, Math.min(500, delta)) * .002)));
      setRange([anchor - ratio * next, anchor + (1 - ratio) * next]);
    } else {
      const offset = span * Math.max(-1, Math.min(1, delta / (right - left)));
      setRange(domain.map(t => t + offset));
    }
  }, {passive: false});
  const nav = el('navigator');
  nav.addEventListener('dblclick', resetRange);
  nav.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !view || gesture) return;
    const part = e.target.closest('[role=slider]')?.id.replace('ua-nav-', '') || 'pan';
    const box = nav.getBoundingClientRect(), range = [...view.domain], original = state.range && [...state.range];
    if (!e.target.closest('#ua-nav-thumb')) {
      const middle = view.extent[0] + (e.clientX - box.left) / box.width * (view.extent[1] - view.extent[0]);
      const span = range[1] - range[0]; range.splice(0, 2, ...bounded([middle - span / 2, middle + span / 2], view.extent));
      setRange(range, false);
    }
    gesture = {part, pointerId: e.pointerId, x: e.clientX, range, original, extent: [...view.extent], width: box.width};
    nav.dataset.drag = part; nav.setPointerCapture(e.pointerId); el('nav-' + part).focus(); e.preventDefault();
  });
  nav.addEventListener('pointermove', e => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const {part, x, range, extent, width} = gesture, delta = (e.clientX - x) / width * (extent[1] - extent[0]);
    const next = part === 'start' ? [Math.max(extent[0], Math.min(range[1] - minSpan, range[0] + delta)), range[1]] : part === 'end' ? [range[0], Math.min(extent[1], Math.max(range[0] + minSpan, range[1] + delta))] : bounded(range.map(t => t + delta), extent);
    setRange(next, false);
  });
  const finish = e => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    if (e.type === 'pointercancel') state.range = gesture.original;
    gesture = null; delete nav.dataset.drag; save(); requestDraw();
  };
  nav.addEventListener('pointerup', finish); nav.addEventListener('pointercancel', finish); nav.addEventListener('lostpointercapture', finish);
  nav.addEventListener('keydown', e => {
    const part = e.target.id.replace('ua-nav-', ''), {domain, extent} = view, span = domain[1] - domain[0], step = Math.max(minSpan, span / 20);
    if (e.key === 'Home') resetRange();
    else if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.key)) {
      const delta = (['ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 1) * (e.key.startsWith('Page') ? span : step);
      setRange(part === 'start' ? [Math.max(extent[0], Math.min(domain[1] - minSpan, domain[0] + delta)), domain[1]] : part === 'end' ? [domain[0], Math.min(extent[1], Math.max(domain[0] + minSpan, domain[1] + delta))] : domain.map(t => t + delta));
    } else if (['+', '=', '-', '_'].includes(e.key)) {
      const next = Math.max(minSpan, span * (['+', '='].includes(e.key) ? .5 : 2)), center = (domain[0] + domain[1]) / 2;
      setRange([center - next / 2, center + next / 2]);
    } else return;
    e.preventDefault();
  });
  nav.addEventListener('wheel', e => {
    const delta = e.deltaX || (e.shiftKey ? e.deltaY : 0);
    if (!delta || !view) return;
    const span = view.domain[1] - view.domain[0];
    setRange(view.domain.map(t => t + Math.sign(delta) * span / 10)); e.preventDefault();
  }, {passive: false});
  window.addEventListener('message', e => {
    if (e.data?.type === 'data' && e.data.data && number(e.data.now)) {
      const changed = historyDays(model.chartHistoryDays) !== historyDays(e.data.chartHistoryDays);
      if (changed) {
        if (chartDrag) finishChartDrag({type: 'pointercancel', pointerId: chartDrag.pointerId});
        if (gesture) {const pointerId = gesture.pointerId; finish({type: 'pointercancel', pointerId}); if (nav.hasPointerCapture(pointerId)) nav.releasePointerCapture(pointerId);}
      }
      model = e.data;
      if (['subscription', 'billing'].includes(model.creditBasis) && (!basisPending || model.creditBasis === basisPending)) {state.creditBasis = model.creditBasis; basisPending = null;}
      if (changed) {state.range = null; save();}
      requestDraw();
    } else if (e.data?.type === 'creditBasisRejected') {state.creditBasis = e.data.value === 'billing' ? 'billing' : 'subscription'; basisPending = null; save(); requestDraw();}
    else if (e.data?.type === 'resetView') resetRange();
  });
  let lastWidth, lastHeight;
  const resize = new ResizeObserver(entries => {const {width, height} = entries[0].contentRect; if (width !== lastWidth || height !== lastHeight) {lastWidth = width; lastHeight = height; requestDraw();}}); resize.observe(el('chart'));
  window.addEventListener('pagehide', () => {save(); resize.disconnect(); cancelAnimationFrame(raf);});
  const ready = () => api.postMessage({type: 'ready', revision: model.revision});
  document.addEventListener('visibilitychange', () => {if (document.hidden) save(); else ready();});
  draw(); ready();
})();

