'use strict';
const {thin, project} = require('./core.cjs');
const gaps = require('../media/gaps.js');
const timeAxis = require('../media/time-axis.js');
const amounts = require('../media/amount-format.js');
const creditGraphs = require('../media/credit-series.js');
const chartGraphs = require('../media/chart-series.js');
const forecasts = require('../media/forecast.js');
const {converter} = require('./credit-conversion.cjs');
const billing = require('./billing.cjs');
const providerCatalog = require('../media/provider-visibility.js');
const duration = 5 * 3600000;
const clock = new Intl.DateTimeFormat('ko-KR', {hour: '2-digit', minute: '2-digit', hour12: false});
const date = new Intl.DateTimeFormat('ko-KR', {month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false});
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]));
const percent = value => `${Math.round(value * 10) / 10}%`;
const number = value => typeof value === 'number' && Number.isFinite(value);
function windowPoints(points, value, start) {
  const first = points.findIndex(p => p.time >= start);
  if (first < 0) return [];
  let previous = first - 1;
  while (previous >= 0 && !number(value(points[previous]))) previous--;
  return points.slice(Math.max(0, previous));
}
function resetRemaining(reset, now) {
  if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= now) return '-';
  const minutes = Math.ceil((reset - now) / 60000);
  if (reset - now >= 86400000) {const hours = Math.floor((reset - now) / 3600000); return `${Math.floor(hours / 24)}d ${hours % 24}h`;}
  return `${Math.floor(Math.min(1439, minutes) / 60)}h ${Math.min(1439, minutes) % 60}m`;
}
function preview(records, {now = Date.now(), dark = false, capacities = [], collectors = {}, maxGap = 1800000, staleAfterMs = 900000, codexCreditDecimals = 4, claudeUsdDecimals = 4, projection, visibility = {}, conversion = null, forecastEnabled = true, creditBasis = 'subscription'} = {}) {
  const start = now - duration, width = 360, right = width - 10;
  // SVG 이미지 생성은 DOM 없이 수행하므로 11px 글자 폭을 보수적으로 계산한다.
  const measure = text => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 127 ? 11 : char === ' ' ? 3.5 : 7), 0);
  const history = records.filter(r => r.time <= now);
  const convert = converter(conversion), bill = billing.enricher();
  const projected = projection || project(history, capacities, maxGap, (...args) => {convert(...args); bill(...args);});
  const providers = Object.keys(projected).filter(id => providerCatalog.enabled(id, projected[id], visibility)), names = Object.fromEntries(providers.map(id => [id, providerCatalog.name(id, projected[id]?.last?.label)]));
  const legendRows = providers.length > 2 ? providers.length : 1, top = 28 + (legendRows - 1) * 16, height = 192 + (legendRows - 1) * 16;
  const quotas = providers.flatMap(id => ['five', 'week'].flatMap(w => chartGraphs.quota(projected[id], id, w))).map(s => ({...s, points: s.points.filter(p => p.time <= now)}));
  const credits = providers.flatMap(id => creditGraphs.series(projected[id], id, {creditBasis})).map(s => ({...s, points: s.points.filter(p => p.time <= now)}));
  const allSeries = [...quotas, ...credits].map(s => ({...s, bridges: gaps.bridges(s.points, 'y')}));
  const {maximum} = chartGraphs.limits(allSeries.filter(series => !series.billing), [start, now]);
  const limit = maximum / 1.08;
  const ticks = [0, limit / 2, limit];
  const left = Math.max(34, Math.ceil(Math.max(...ticks.map(value => measure(percent(value))))) + 5);
  const axis = timeAxis.layout([start, now], right - left, measure);
  const dateRows = Math.max(1, ...axis.dates.map(tick => tick.row + 1)), bottom = height - 38 - (dateRows - 1) * 14;
  const palette = dark ? {text: '#cbd5e1', grid: '#3a414c', codex: '#62d0d8', claude: '#eeb18c'} : {text: '#46546a', grid: '#d3dae3', codex: '#087a86', claude: '#b05428'};
  for (const id of providers) palette[id] = providerCatalog.color(id, dark);
  const x = time => left + (time - start) / duration * (right - left);
  const y = value => bottom - value / maximum * (bottom - top);
  const feeMaximum = chartGraphs.billingMaximum(allSeries, [start, now]);
  const by = value => bottom - value / feeMaximum * (bottom - top);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="최근 5시간 사용률" data-y-max="${maximum}"${creditBasis === 'billing' ? ' data-y-billing-max="' + feeMaximum + '"' : ''} data-domain-start="${start}" data-domain-end="${now}">`, `<style>text{font:11px 'Segoe UI',sans-serif;fill:${palette.text}}path,line{fill:none;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}</style>`, `<defs><clipPath id="plot"><rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}"/></clipPath></defs>`];
  const text = (value, px, py, anchor = 'start', attributes = '') => parts.push(`<text x="${px}" y="${py}" text-anchor="${anchor}"${attributes}>${escape(value)}</text>`);
  const estimated = (segments, field, scale, key, color) => {
    const selected = thin(segments.filter(pair => pair[1].time > start && pair[0].time < now).map(pair => ({time: pair[0].time, value: Math.max(pair[0][field], pair[1][field]), pair})), 120);
    const path = selected.map(({pair}) => {
      const a = Math.max(start, pair[0].time), b = Math.min(now, pair[1].time);
      return `M${x(a).toFixed(1)},${scale(gaps.at(pair, field, a)).toFixed(1)}L${x(b).toFixed(1)},${scale(gaps.at(pair, field, b)).toFixed(1)}`;
    }).join('');
    if (path) parts.push(`<path clip-path="url(#plot)" data-interpolated="${key}" d="${path}" stroke="${color}" stroke-width=".75" stroke-dasharray="3 4" opacity=".5"/>`);
  };
  for (const value of ticks) {parts.push(`<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="${palette.grid}"/>`); text(percent(value), left - 5, y(value) + 4, 'end', ' data-y-label=""');}
  for (const [i, id] of providers.entries()) {const px = providers.length > 2 ? left : left + i * 155, py = providers.length > 2 ? i * 16 : 0; parts.push(id === 'codex' ? `<circle cx="${px + 4}" cy="${12 + py}" r="3" fill="${palette[id]}"/>` : `<path d="M${px + 4} ${8 + py}l4 4-4 4-4-4Z" style="fill:${palette[id]}"/>`); text(names[id], px + 13, 16 + py);}
  if (creditBasis === 'billing') {text('금액 %', right, top - 5, 'end', ' data-billing-axis=""'); for (const value of [0, feeMaximum / 2, feeMaximum]) text(percent(value), right - 2, by(value) + 4, 'end', ' data-billing-tick=""');}
  const summaries = []; let visible = 0;
  for (const id of providers) {
    const provider = projected[id], last = provider?.last?.time <= now ? provider.last : history.findLast(r => r.provider === id);
    const summary = {name: names[id], five: '-', week: '-', resets: {five: '-', week: '-'}, status: collectors[id]?.message || '수집 대기', observed: last ? date.format(last.time) : '-'};
    if (last && now - last.time > staleAfterMs) summary.status += ' · 기록 지연';
    for (const w of ['five', 'week']) {
      const value = last?.windows[w]?.used;
      if (typeof value === 'number' && Number.isFinite(value)) summary[w] = percent(value);
      summary.resets[w] = resetRemaining(last?.windows[w]?.reset, now);
      const source = allSeries.find(s => s.id === id && s.w === w), segments = source?.bridges || [];
      const points = thin(windowPoints(source?.points || [], p => p.y, start), 240);
      let path = '', prev;
      const dots = [];
      const resetLines = new Map();
      for (const [i, p] of points.entries()) {
        if (!number(p.y)) {prev = undefined; continue;}
        if (p.time < start && !points[i + 1]?.continuous) {prev = undefined; continue;}
        const px = x(p.time).toFixed(1), py = y(p.y).toFixed(1);
        path += `${prev && p.continuous ? 'L' : 'M'}${px},${py}`;
        if (p.time >= start && !(prev && p.continuous) && !(number(points[i + 1]?.y) && points[i + 1].continuous)) dots.push(`<circle cx="${px}" cy="${py}" r="1.65" fill="${palette[id]}"/>`);
        if (p.time >= start) visible++;
        prev = p;
      }
      for (const event of provider?.events || []) {
        if (event.time > now || event.window !== w || !['scheduled-reset', 'early-reset'].includes(event.kind)) continue;
        const time = event.kind === 'scheduled-reset' ? event.previousReset : event.time;
        if (w === 'five' && time >= start && time <= now) resetLines.set(x(time).toFixed(1), {time, kind: event.kind});
        if (event.kind === 'early-reset' && event.time >= start && event.time <= now) {
          const px = x(event.time).toFixed(1);
          if (w === 'week') parts.push(`<g clip-path="url(#plot)" data-event="${id}-${w}"><line x1="${px}" x2="${px}" y1="${top}" y2="${bottom}" stroke="${palette[id]}" stroke-width=".7" stroke-dasharray="2 5" opacity=".35"/><path d="M${px} ${top + 2}l3 5h-6Z" style="fill:${palette[id]}"/></g>`);
          summary.event = (w === 'five' ? '5시간' : '주간') + ' · 예정 전 초기화 관측 ' + clock.format(event.time);
        }
      }
      for (const [px, event] of resetLines) parts.push(`<line clip-path="url(#plot)" data-reset-history="${id}-five" data-event="${id}-five" data-reset-kind="${event.kind}" data-time="${event.time}" x1="${px}" x2="${px}" y1="${top}" y2="${bottom}" stroke="${palette[id]}" stroke-width=".7" stroke-dasharray="2 4" opacity=".4"/>`);
      parts.push(`<g clip-path="url(#plot)" data-series="${id}-${w}"><path d="${path}" stroke="${palette[id]}" stroke-width="${w === 'week' ? 1 : .85}" opacity="${w === 'week' ? .95 : .85}"${w === 'week' ? ' stroke-dasharray="5 3"' : ''}/>${dots.join('')}</g>`);
      estimated(segments, 'y', y, `${id}-${w}`, palette[id]);
    }
    const value = provider?.ledger?.findLast(p => p.time <= now)?.credit.usage;
    summary.credit = number(value) ? amounts.format(value, id === 'codex' ? codexCreditDecimals : claudeUsdDecimals) + ' ' + (id === 'codex' ? '크레딧' : 'USD') : '-';
    for (const s of allSeries.filter(s => s.id === id && s.w === 'credit')) {
      const segments = s.bridges, points = thin(windowPoints(s.points, p => p.y, start), 240), cy = s.billing ? by : y;
      let path = '', prev; const dots = [];
      for (const [i, p] of points.entries()) {
        if (!number(p.y)) {prev = undefined; continue;}
        if (p.time < start && !points[i + 1]?.continuous) {prev = undefined; continue;}
        const px = x(p.time).toFixed(1), py = cy(p.y).toFixed(1);
        path += (prev && p.continuous ? 'L' : 'M') + px + ',' + py;
        if (p.time >= start && !(prev && p.continuous) && !(number(points[i + 1]?.y) && points[i + 1].continuous)) dots.push('<circle cx="' + px + '" cy="' + py + '" r="1.4" fill="' + palette[id] + '"/>');
        if (p.time >= start) visible++; prev = p;
      }
      if (path) parts.push('<g clip-path="url(#plot)" data-series="' + s.key + '" data-credit-window="' + s.creditWindow + '"><path d="' + path + '" stroke="' + palette[id] + '" stroke-width=".75" stroke-dasharray="' + (s.creditWindow === 'week' ? '5 3 1 3' : '1 4') + '" opacity=".65"/>' + dots.join('') + '</g>');
      estimated(segments, 'y', cy, s.key, palette[id]);
    }
    if (forecastEnabled) summary.forecasts = Object.fromEntries(['five', 'week'].map(w => [w, forecasts.summary(provider?.forecast?.[w], now)]));
    summaries.push(summary);
  }
  if (!visible) text('-', (left + right) / 2, (top + bottom) / 2, 'middle');
  for (const [kind, ticks, length] of [['day', axis.dayTicks, 8], ['hour', axis.hourTicks, 4]]) {
    parts.push(`<path data-${kind}-ticks="${ticks.length}" d="${ticks.map(px => `M${left + px},${bottom}v${length}`).join('')}" stroke="${palette.text}" stroke-width="${kind === 'day' ? 1 : .6}" opacity="${kind === 'day' ? .8 : .5}"/>`);
  }
  for (const tick of axis.hours) text(tick.text, left + tick.x, bottom + 19, tick.anchor, ` data-hour-label="" data-axis-time="${tick.time}" data-axis-context="${!!tick.context}"`);
  for (const tick of axis.dates) text(tick.text, left + tick.x, bottom + 33 + tick.row * 14, tick.anchor, ` data-date-tick="" data-date-keys="${tick.keys.join(',')}" data-axis-time="${tick.time}" data-axis-context="${!!tick.context}"`);
  parts.push('</svg>');
  return {svg: parts.join(''), start, end: now, range: `${date.format(start)} – ${date.format(now)}`, summaries};
}
module.exports = {preview, resetRemaining};
