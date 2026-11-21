/* Copyright (c) 2026 jisoq. Analysis concepts adapted from https://github.com/jisoq/Codexon.
 * Usage Atlas modal implementation; see licenses/Codexon-LICENSE.txt. */
(() => {
  'use strict';
  const providerName = (id, label) => globalThis.usageAtlasProviderVisibility?.name(id, label) || ({codex: 'Codex', claude: 'Claude Code'}[id] || 'Antigravity');
  const labels = {
    provider: '제공자'
  , account: '계정'
  , window: '기간'
  , sourceCallCount: '색인된 호출'
  , eligibleCallCount: '범위 내 호출'
  , callCount: '호출'
  , pricedCallCount: '가격 확인 호출'
  , knownCostUsd: '가격 확인 소계 (USD)'
  , costUsd: '전체 환산액 (USD)'
  , input: '입력 토큰'
  , cached: '캐시 입력 토큰'
  , output: '출력 토큰'
  , cacheRatio: '캐시 비율'
  , ratio: '캐시 비율'
  , sessionCount: '세션'
  , requestCount: '요청'
  , matchedCallCount: '구간 일치 호출'
  , unmatchedCallCount: '구간 불일치 호출'
  , provisionalCallCount: '잠정 호출'
  , validSampleCount: '유효 표본'
  , quotaDelta: '사용률 변화 (pp)'
  , valueUsdPer100Pct: '사용률 100%당 환산액 (USD)'
  , removedCallCount: '제외 호출'
  , removedKnownCostUsd: '제외 소계 (USD)'
  , catalogVersion: '가격표 버전'
  , durationMs: '처리 시간 (ms)'
  , elapsedMs: '소요 시간 (ms)'
  , collectMs: '수집 시간 (ms)'
  , parseMs: '해석 시간 (ms)'
  , analyzeMs: '분석 시간 (ms)'
  , memoryBytes: '메모리 (바이트)'
  , fileCount: '파일 수'
  , errorCount: '오류 수'
  , cacheHits: '캐시 적중'
  , cacheMisses: '캐시 미적중'
  , samples: '조회 표본'
  , lastMs: '최근 조회 (ms)'
  , meanMs: '평균 조회 (ms)'
  , p95Ms: '조회 P95 (ms)'
  , cpuMs: 'CPU 시간 (ms)'
  , rssMiB: '프로세스 메모리 (MiB)'
  , heapMiB: '힙 메모리 (MiB)'
  , roots: '색인 경로'
  , files: '색인 파일'
  , calls: '색인 호출'
  , partial: '부분 수집'
  , pendingFiles: '수집 대기 파일'
  , malformedLines: '해석 실패 줄'
  , oversizedLines: '크기 초과 줄'
  , unavailableFiles: '접근 불가 파일'
  , unknownAccountFiles: '계정 미확인 파일'
  , unknownTimeCalls: '시각 미확인 호출'
  , limited: '수집 제한 적용'
  , cacheRecovered: '색인 캐시 복구'
  , cacheWriteFailed: '색인 캐시 저장 실패'
  , last: '최근 수집'
  , next: '다음 수집'
  , errors: '수집 오류 횟수'
  , message: '수집 상태'
  , effectiveIntervalSeconds: '현재 수집 주기 (초)'
  , baseIntervalSeconds: '기본 수집 주기 (초)'
  , adaptive: '활동 기반 주기 조절'
  , pending: '저장 대기'
  , memory: '메모리 대기 기록'
  , bytes: '대기 크기 (바이트)'
  , issue: '저장 상태'
  , recovered: '대기 기록 복구'
  , cacheHit: '조회 캐시 적중'
  , fetchMs: '어댑터 조회 (ms)'
  , currentCount: '진행 중 주기'
  , partialCount: '부분 주기'
  , completeCount: '완료 주기'
  , rawQuotaDelta: '원본 사용률 증가 (pp)'
  , observedQuotaDelta: '연속 관측 증가 (pp)'
  , assumedCallCount: 'Standard 가정 호출'
  , unpricedCallCount: '가격 미확인 호출'
  , missingModeCallCount: '모드 미확인 호출'
  , matchedPricedCallCount: '일치·가격 확인 호출'
  };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = value => value == null || value === '' ? '-' : finite(value) ? value.toLocaleString('ko-KR', {maximumFractionDigits: 6}) : typeof value === 'string' ? value : typeof value === 'boolean' ? value ? '예' : '아니요' : '-';
  const enumLabels = {
    mode: {Standard: '표준', Fast: '빠름', Ultrafast: '매우 빠름'}
  , effort: {none: '없음', minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', auto: '자동'}
  , inputBand: {'0-10k': '1만 미만', '10k-100k': '1만~10만 미만', '100k-200k': '10만~20만 미만', '200k+': '20만 이상'}
  , cacheBand: {'0%': '0%', '0-50%': '0% 초과~50% 미만', '50-90%': '50%~90% 미만', '90-100%': '90%~100%'}
  };
  const display = (key, value) => {
    if (value == null || value === '' || value === 'unknown') return '-';
    return enumLabels[key] ? Object.hasOwn(enumLabels[key], value) ? enumLabels[key][value] : '-' : text(value);
  };
  const sourceNotes = {
    'account-assumed-at-first-file-observation': '이 로컬 경로의 계정은 첫 색인 시 로그인 계정으로 가정합니다.'
  , 'account-switch-existing-file-bindings-preserved': '기존 파일의 계정 연결은 전환 후에도 보존합니다.'
  , 'unknown-account-binding-preserved': '계정을 확인하지 못한 파일은 미확인으로 유지합니다.'
  , 'legacy-cumulative-deltas-completion-unknown': '누적 기록의 차이로 복원한 호출은 완료 여부를 확인하지 못했습니다.'
  , 'modern-records-supersede-session-token-count': '같은 세션의 기존 누적 토큰 기록보다 새 호출별 사용량 기록을 우선합니다.'
  };
  const sourceLabels = {
    'openai-api': 'OpenAI API'
  , 'openai-speed': 'OpenAI 속도'
  , 'openai-subscription': 'OpenAI 구독'
  , 'openai-sol': 'GPT-6 Sol'
  , 'anthropic-api': 'Claude API'
  , 'claude-code': 'Claude Code'
  , 'anthropic-models': 'Claude 모델'
  };
  const priceIssueLabels = {
    'unsupported-provider': '제공자 미지원'
  , 'unsupported-model': '모델 미지원'
  , 'unknown-mode': '모드 미확인'
  , 'unsupported-mode': '모드 미지원'
  , 'conflicting-observation': '관측값 충돌'
  , 'unsupported-token-category': '토큰 유형 미지원'
  , 'unknown-token-category-or-cache-ttl': '토큰 유형 또는 캐시 쓰기 TTL 미확인'
  , 'unknown-or-invalid-input': '입력 토큰 미확인·오류'
  , 'unknown-or-invalid-cached': '캐시 입력 토큰 미확인·오류'
  , 'unknown-or-invalid-output': '출력 토큰 미확인·오류'
  , 'cache-exceeds-inclusive-input': '캐시 토큰이 입력보다 큼'
  , 'invalid-reasoning-subset': '추론 토큰 범위 오류'
  , 'unknown-or-invalid-cacheWrite5m': '5분 캐시 쓰기 미확인·오류'
  , 'unknown-or-invalid-cacheWrite1h': '1시간 캐시 쓰기 미확인·오류'
  , 'unknown-or-invalid-cacheWrite30m': '30분 캐시 쓰기 미확인·오류'
  , 'unknown-or-invalid-cacheWrite12h': '12시간 캐시 쓰기 미확인·오류'
  , 'unsupported-cache-write-ttl': '캐시 쓰기 TTL 미지원'
  , 'unclassified-cache-write': '캐시 쓰기 분류·TTL 미확인'
  , 'unclassified-or-conflicting-cache-write-total': '캐시 쓰기 합계 미확인·충돌'
  , 'unverified-long-context-rate': '긴 문맥 요율 미확인'
  , 'unsupported-mode-multiplier': '모드 배율 미지원'
  , 'cost-overflow': '환산액 계산 범위 초과'
  };
  const priceStatus = row => {
    const issues = [...new Set([
      ...(Array.isArray(row.priceIssues) ? row.priceIssues.filter(value => typeof value === 'string') : [])
    , ...(typeof row.priceIssue === 'string' ? row.priceIssue.split(';').map(value => value.trim()) : [])
    ].filter(Boolean))];
    const assumed = row.priceAssumed === true;
    if (issues.length) return (assumed ? '가정 · ' : '') + [...new Set(issues.map(issue => Object.hasOwn(priceIssueLabels, issue) ? priceIssueLabels[issue] : '환산 사유 미확인'))].join(' · ');
    if (finite(row.costUsd) && row.costUsd >= 0) return assumed ? '가정' : '확인';
    return assumed ? '가정 · 환산액 미확인' : '-';
  };
  const date = value => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const day = Date.parse(value);
      return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value ? value : '-';
    }
    const time = finite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(time)) return '-';
    const at = new Date(time), pad = value => String(value).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  };
  const shortStamp = (value, showTime = true) => {
    if (!finite(value)) return '-';
    const at = new Date(value), pad = part => String(part).padStart(2, '0');
    return showTime ? `${pad(at.getMonth() + 1)}.${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}` : `${pad(at.getMonth() + 1)}.${pad(at.getDate())}`;
  };
  const compactTokens = value => {
    if (!finite(value) || value < 0) return '-';
    if (value >= 100000000) return (value / 100000000).toLocaleString('ko-KR', {maximumFractionDigits: 1}) + '억';
    if (value >= 10000) return (value / 10000).toLocaleString('ko-KR', {maximumFractionDigits: 1}) + '만';
    return value.toLocaleString('ko-KR', {maximumFractionDigits: 0});
  };
  const shortIdentifier = value => typeof value === 'string' && value.length > 20 ? value.slice(0, 8) + '…' + value.slice(-6) : text(value);
  const percent = value => finite(value) ? (value * 100).toLocaleString('ko-KR', {maximumFractionDigits: 1}) + '%' : '-';
  const windowNames = {five: '5시간', week: '주간', credit: '크레딧'};
  const tabKeys = ['report', 'conversation', 'coverage', 'performance', 'history'];
  const reportViews = ['all', 'sessions', 'requests', 'calls', 'agents'];
  const heatmapMetrics = ['cost', 'calls', 'tokens'];
  const markerClass = id => 'ua-dot ua-dot-' + (['codex', 'claude'].includes(id) ? id : 'antigravity');
  const items = section => Array.isArray(section?.items) ? section.items : [];
  const node = (tag, content, className) => {const value = document.createElement(tag); if (content != null) value.textContent = content; if (className) value.className = className; return value;};
  const filterKeys = ['session', 'turnId', 'project', 'model', 'effort', 'mode', 'inputBand', 'cacheBand'];
  const projectName = value => typeof value === 'string' && value.trim() && value.length <= 80 && !/[\\/\x00-\x1f\x7f]/.test(value) && !['.', '..'].includes(value.trim()) ? value.trim() : null;
  const shortProjectId = value => typeof value === 'string' && value !== 'unknown' ? value.length > 16 ? value.slice(0, 8) + '…' + value.slice(-6) : value : '-';
  const heatmapStep = span => {
    const hour = 3600000, day = 86400000;
    if (span <= 6 * hour) return 900000;
    if (span <= 24 * hour) return hour;
    if (span <= 3 * day) return 3 * hour;
    if (span <= 10 * day) return 6 * hour;
    if (span <= 56 * day) return day;
    return Math.max(7 * day, Math.ceil(span / 52 / day) * day);
  };
  globalThis.usageAtlasDetails = ({api, root, getModel, onStateChange}) => {
    const el = id => document.getElementById('ua-' + id);
    const dialog = el('details'), form = el('details-filters'), scrollBox = el('details-scroll');
    if (!dialog) return null;
    let selection, report, latest = '', serial = 0, returnFocus, preview = null, range = null, reasonDraft = '';
    let activeTab = 'report', reportView = 'all', heatmapMetric = 'cost', showAllProjects = false;
    let conversationLatest = '', conversationRequestKey = '', conversationRequestCursor = null, conversationChunks = 0, activeConversationKey = null;
    let diagnosticsFlag = Boolean(getModel().diagnosticsEnabled), analysisFlag = getModel().analysisEnabled !== false;
    const filters = {}, pools = new Map(), endpointPool = new Set(), projectNames = new Map(), projectNameCounts = new Map();
    const conversationStore = new Map(), tabScrollTop = {report: 0, conversation: 0, coverage: 0, performance: 0, history: 0};
    const conversationKeyOf = (homeKey, sessionId) => `${homeKey}:${sessionId}`;
    const validConversationMeta = (sessionId, homeKey) => typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 512 && !/[\\/\x00-\x1f\x7f]/.test(sessionId) && typeof homeKey === 'string' && /^[a-f0-9]{64}$/.test(homeKey);
    const safeFilterValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
    const projectText = (id, provided) => {
      if (!id || id === 'unknown') return '미분류 프로젝트';
      const name = projectName(provided) || projectNames.get(id);
      return name ? projectNameCounts.get(name) > 1 ? `${name} · ${shortProjectId(id)}` : name : shortProjectId(id);
    };
    const isOpen = () => dialog.open;
    const serializedState = () => {
      if (!isOpen() || !selection) return null;
      if (activeTab && scrollBox) tabScrollTop[activeTab] = Math.max(0, Math.round(scrollBox.scrollTop || 0));
      return {
        open: true
      , selection: {provider: selection.provider, window: selection.window, time: selection.time, start: selection.start, end: selection.end}
      , tab: activeTab
      , reportView
      , heatmapMetric
      , scrollTop: Object.fromEntries(tabKeys.map(key => [key, Math.max(0, Math.min(1000000, Math.round(tabScrollTop[key] || 0)))]))
      , filters: Object.fromEntries(filterKeys.filter(key => safeFilterValue(filters[key])).map(key => [key, filters[key]]))
      , activeConversationKey: activeConversationKey && conversationStore.has(activeConversationKey) ? activeConversationKey : null
      , conversations: [...conversationStore.values()].slice(-12).filter(entry => validConversationMeta(entry.sessionId, entry.homeKey)).map(entry => ({
          key: entry.key
        , sessionId: entry.sessionId
        , homeKey: entry.homeKey
        , projectLabel: typeof entry.projectLabel === 'string' && entry.projectLabel.length <= 100 && !/[\\/\x00-\x1f\x7f]/.test(entry.projectLabel) ? entry.projectLabel : null
        , lastObservedAt: finite(entry.lastObservedAt) ? entry.lastObservedAt : null
        }))
      };
    };
    const persist = () => {onStateChange?.(serializedState());};
    const updateConversationTabLabel = () => {
      const tab = el('tab-conversation');
      if (!tab) return;
      const count = conversationStore.size;
      tab.replaceChildren(document.createTextNode('대화'));
      if (count > 0) {
        const badge = node('span', String(count), 'ua-tab-badge');
        badge.setAttribute('aria-label', `보존된 대화 ${count}건`);
        tab.append(badge);
      }
    };
    const syncHeader = () => {
      if (!selection) return;
      const legendColor = typeof selection.provider === 'string' ? document.getElementById('ua-' + selection.provider)?.style.getPropertyValue('--c') : '';
      dialog.style.setProperty('--c', legendColor || (selection.provider === 'claude' ? 'var(--ua-b)' : 'var(--ua-a)'));
      el('details-marker').className = markerClass(selection.provider);
      el('details-title-text').textContent = [providerName(selection.provider, getModel().data?.[selection.provider]?.last?.label), windowNames[selection.window], '사용량'].filter(Boolean).join(' ');
      if (!report?.summary || !finite(report.summary.start) || !finite(report.summary.end)) el('details-context').textContent = `${date(selection.start)} – ${date(selection.end)}`;
    };
    const syncFilterHighlights = () => {
      let activeCount = 0;
      for (const key of filterKeys) {
        const control = form.elements.namedItem(key);
        const active = Boolean(filters[key]);
        if (active) activeCount++;
        control?.closest('label')?.toggleAttribute('data-active', active);
      }
      form.dataset.filtered = String(activeCount > 0);
    };
    // 금액 표시 자릿수 설정(Claude USD·Codex 크레딧)을 모달에도 적용한다. 원본 값은 그대로 둔다.
    const amountPlaces = label => {
      const model = getModel() || {};
      if (/USD/.test(label || '') && selection?.provider === 'claude') return model.claudeUsdDecimals;
      if (label === '크레딧 차감 추정' && selection?.provider === 'codex') return model.codexCreditDecimals;
      return undefined;
    };
    const amountText = (label, value) => {const places = amountPlaces(label); return places !== undefined && finite(value) && globalThis.usageAtlasAmountFormat ? globalThis.usageAtlasAmountFormat.format(value, places) : text(value);};
    const focusables = () => [...dialog.querySelectorAll('button, select, input, textarea, summary, a[href], [tabindex="0"]')].filter(value => !value.disabled && !value.hidden && value.getClientRects().length);
    const section = (parent, title, extraClass = '') => {const block = node('section', null, 'ua-details-section' + (extraClass ? ' ' + extraClass : '')), head = node('div', null, 'ua-details-section-head'); head.append(node('h3', title)); block.append(head); parent.append(block); return block;};
    const metrics = (parent, data, keys, lead = []) => {
      const list = node('dl', null, 'ua-details-metrics');
      for (const key of keys) {
        const cell = node('div', null, 'ua-metric' + (lead.includes(key) ? ' ua-metric-lead' : '')), value = /ratio/i.test(key) && finite(data?.[key]) ? percent(data[key]) : amountText(labels[key], data?.[key]);
        const dd = node('dd', value); if (value === '-') dd.className = 'ua-empty';
        cell.append(node('dt', labels[key] || key), dd); list.append(cell);
      }
      parent.append(list);
      return list;
    };
    // 입력(캐시 포함)·출력 토큰 구성을 한 줄 막대로 보여 준다. 캐시가 입력보다 크면 정의가 다른 기록이므로 그리지 않는다.
    const tokenMix = (parent, data) => {
      const input = data?.input, cached = data?.cached, output = data?.output;
      if (![input, cached, output].every(value => finite(value) && value >= 0) || cached > input || input + output <= 0) return;
      const total = input + output, parts = [['fresh', '새 입력', input - cached], ['cached', '캐시 입력', cached], ['output', '출력', output]];
      const block = node('figure', null, 'ua-token-mix'), bar = node('div', null, 'ua-token-bar'), legend = node('figcaption', null, 'ua-token-legend');
      bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', '토큰 구성 · ' + parts.map(([, label, value]) => `${label} ${text(value)}`).join(' · '));
      for (const [key, label, value] of parts) {
        const piece = node('span', null, 'ua-token-' + key); piece.style.flexGrow = String(value); bar.append(piece);
        const item = node('span', null, 'ua-token-item'), swatch = node('i', null, 'ua-token-' + key); swatch.setAttribute('aria-hidden', 'true');
        item.append(swatch, node('span', label), node('strong', text(value)), node('span', percent(value / total), 'ua-token-share')); legend.append(item);
      }
      block.append(node('div', '토큰 구성', 'ua-token-title'), bar, legend); parent.append(block);
    };
    const notes = (parent, values) => {
      const entries = Array.isArray(values) ? values : values ? [values] : [];
      for (const entry of entries) if (typeof entry === 'string') parent.append(node('p', entry, 'ua-details-note'));
    };
    const table = (parent, title, source, columns, drill, options = {}) => {
      const rows = items(source), block = section(parent, title, options.sectionClass || '');
      if (options.reportSection) block.dataset.reportSection = options.reportSection;
      (block.querySelector('.ua-details-section-head') || block).append(node('p', `표본 ${rows.length} / ${text(source?.totalCount)} · 확인 ${text(source?.knownCount)}${source?.truncated ? ' · 일부 표시' : ''}`, 'ua-details-note ua-details-count'));
      if (!rows.length) {block.append(node('p', '표시할 기록이 없습니다', 'ua-details-empty')); return block;}
      const numeric = columns.map(([, read, format]) => format !== date && rows.some(item => finite(read(item))) && rows.every(item => {const value = read(item); return value == null || finite(value);}));
      const wrap = node('div', null, 'ua-details-table-scroll' + (options.bounded !== false ? ' ua-details-table-bounded' : '')), grid = node('table');
      wrap.id = 'ua-table-' + encodeURIComponent(title);
      grid.setAttribute('aria-label', title); wrap.tabIndex = 0; wrap.setAttribute('aria-label', title + ' 표 스크롤');
      const header = node('thead'), row = node('tr'), body = node('tbody');
      const timeColumn = columns.find(column => column[0] === '최근') || columns.find(column => column[0] === '시각') || columns.find(column => column[0] === '종료') || columns.find(column => column[2] === date);
      let sortKey = timeColumn?.[1] || null, ascending = !timeColumn, sortTime = !!timeColumn;
      const draw = () => {
        const sorted = [...rows].sort((a, b) => {
          if (!sortKey) return 0;
          let left = sortKey(a), right = sortKey(b);
          if (sortTime) {const stamp = value => finite(value) ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null; left = stamp(left); right = stamp(right);}
          if (left == null) return right == null ? 0 : 1;
          if (right == null) return -1;
          return (finite(left) && finite(right) ? left - right : String(left).localeCompare(String(right), 'ko')) * (ascending ? 1 : -1);
        });
        body.replaceChildren();
        for (const item of sorted) {
          const tr = node('tr');
          for (const [label, read, format] of columns) {
            const td = node('td'), value = read(item);
            if (numeric[columns.findIndex(column => column[0] === label)]) td.className = 'ua-num';
            if (drill && label === columns[0][0] && value != null && drill.enabled?.(item) !== false) {
              const displayLabel = ['세션', '요청'].includes(label) && typeof value === 'string' ? shortIdentifier(value) : text(value);
              const button = node('button', displayLabel, 'ua-link');
              button.type = 'button';
              if (typeof value === 'string' && displayLabel !== value) button.title = value;
              button.id = 'ua-drill-' + encodeURIComponent(title + '/' + String(value).slice(0, 200));
              button.addEventListener('click', () => drill(item));
              td.append(button);
            } else {
              const idColumn = ['세션', '요청', '상위 세션'].includes(label) && !format && typeof value === 'string' && value.length > 20;
              const formatted = format ? format(value) : idColumn ? shortIdentifier(value) : amountPlaces(label) !== undefined ? amountText(label, value) : display({'모드': 'mode', '추론 수준': 'effort', '모델': 'model'}[label], value);
              if (formatted instanceof Node) td.append(formatted);
              else {
                td.textContent = formatted;
                if (idColumn) td.title = value;
                if (formatted === '-') td.classList.add('ua-empty');
                else if (String(formatted).length > 24) td.classList.add('ua-wrap');
              }
            }
            tr.append(td);
          }
          body.append(tr);
        }
      };
      for (const [index, [label, read, format]] of columns.entries()) {
        const th = node('th', null, numeric[index] ? 'ua-num' : null), button = node('button', label); th.scope = 'col'; button.type = 'button'; button.setAttribute('aria-label', label + ' 정렬');
        button.id = 'ua-sort-' + encodeURIComponent(title) + '-' + index;
        if (label === '대화') {th.textContent = label; row.append(th); continue;}
        if (read === sortKey) th.setAttribute('aria-sort', 'descending');
        button.addEventListener('click', () => {ascending = sortKey === read ? !ascending : format !== date; sortKey = read; sortTime = format === date; for (const cell of row.children) cell.removeAttribute('aria-sort'); th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending'); draw();});
        th.append(button); row.append(th);
      }
      header.append(row); grid.append(header, body); wrap.append(grid); block.append(wrap); draw();
      return block;
    };
    const sensitivityTable = (parent, title, source) => table(parent, title, Array.isArray(source) ? {items: source, totalCount: source.length} : source, [
      ['가정', row => row.assumption || row.label || row.name]
    , ['100%당 환산액 (USD)', row => row.valueUsdPer100Pct]
    , ['표본', row => row.sampleCount ?? row.callCount]
    ]);
    const clearAllConversations = (notifyHost = true) => {
      if (notifyHost && (conversationStore.size || conversationLatest)) api.postMessage({type: 'conversationClosed'});
      conversationStore.clear();
      activeConversationKey = null;
      conversationLatest = '';
      conversationRequestKey = '';
      conversationRequestCursor = null;
      conversationChunks = 0;
      tabScrollTop.conversation = 0;
      updateConversationTabLabel();
      renderConversationPanel();
    };
    const removeConversation = key => {
      const wasActive = activeConversationKey === key;
      conversationStore.delete(key);
      if (conversationRequestKey === key) {conversationLatest = ''; conversationRequestKey = ''; conversationRequestCursor = null;}
      if (wasActive) activeConversationKey = [...conversationStore.keys()].at(-1) || null;
      if (!conversationStore.size) api.postMessage({type: 'conversationClosed'});
      updateConversationTabLabel();
      renderConversationPanel();
      if (wasActive && activeConversationKey) {
        const nextEntry = conversationStore.get(activeConversationKey);
        if (nextEntry && !nextEntry.data && !nextEntry.loading) loadConversation(null);
      }
      persist();
    };
    const selectConversation = key => {
      if (!conversationStore.has(key)) return;
      activeConversationKey = key;
      renderConversationPanel();
      const entry = conversationStore.get(key);
      if (entry && !entry.data && !entry.loading && analysisFlag !== false) loadConversation(null);
      persist();
    };
    const renderConversationPanel = () => {
      const parent = el('panel-conversation');
      if (!parent) return;
      parent.replaceChildren();
      if (!conversationStore.size || !activeConversationKey || !conversationStore.has(activeConversationKey)) {
        parent.removeAttribute('aria-busy');
        parent.append(node('p', '세션·호출의 대화 보기에서 선택하세요.', 'ua-details-empty'));
        return;
      }
      const entry = conversationStore.get(activeConversationKey);
      if (entry.loading) parent.setAttribute('aria-busy', 'true'); else parent.removeAttribute('aria-busy');
      const tray = node('div', null, 'ua-conversation-tray');
      const chips = node('div', null, 'ua-conversation-sessions');
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', '불러온 대화 세션');
      for (const item of conversationStore.values()) {
        const chipWrap = node('div', null, 'ua-conversation-chip' + (item.key === activeConversationKey ? ' ua-active' : ''));
        const labelParts = [item.projectLabel && item.projectLabel !== '미분류 프로젝트' ? item.projectLabel : null, shortIdentifier(item.sessionId)].filter(Boolean);
        const pick = node('button', labelParts.join(' · '), 'ua-conversation-pick');
        pick.type = 'button';
        pick.title = item.sessionId;
        pick.setAttribute('aria-pressed', String(item.key === activeConversationKey));
        pick.addEventListener('click', () => selectConversation(item.key));
        const dismiss = node('button', '×', 'ua-conversation-dismiss');
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', `${item.sessionId} 대화 닫기`);
        dismiss.title = '이 대화 닫기';
        dismiss.addEventListener('click', event => {event.stopPropagation(); removeConversation(item.key);});
        chipWrap.append(pick, dismiss);
        chips.append(chipWrap);
      }
      tray.append(chips);
      if (conversationStore.size > 1) {
        const clearBtn = node('button', '모두 비우기', 'ua-ghost ua-conversation-clear');
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', () => {clearAllConversations(true); persist();});
        tray.append(clearBtn);
      }
      parent.append(tray);
      const head = node('div', null, 'ua-details-section-head');
      const titleNode = node('h3', '대화 · ' + shortIdentifier(entry.sessionId));
      titleNode.title = entry.sessionId;
      head.append(titleNode, node('p', '최신순 · 선택 구간 이전 메시지는 따로 표시', 'ua-details-note ua-details-count'));
      parent.append(head);
      if (entry.error && !entry.data) {
        parent.append(node('p', entry.error, 'ua-details-note'));
        const retry = node('button', '다시 불러오기');
        retry.type = 'button';
        retry.addEventListener('click', () => loadConversation(null));
        parent.append(retry);
        return;
      }
      if (!entry.data) {
        const status = node('p', '대화를 불러오고 있습니다…', 'ua-details-note');
        status.setAttribute('role', 'status');
        parent.append(status);
        return;
      }
      const data = entry.data;
      const toolbar = node('div', null, 'ua-conversation-toolbar');
      const latestButton = node('button', '최신 대화'), older = node('button', data.loading ? '계속 읽기' : '이전 대화');
      latestButton.type = older.type = 'button';
      latestButton.disabled = Boolean(entry.loading);
      older.disabled = Boolean(entry.loading) || !data.next;
      latestButton.addEventListener('click', () => loadConversation(null));
      older.addEventListener('click', () => loadConversation(data.next));
      toolbar.append(latestButton, older);
      if (entry.loading) {
        const busyNote = node('span', '대화를 불러오고 있습니다…', 'ua-details-note');
        busyNote.setAttribute('role', 'status');
        toolbar.append(busyNote);
      }
      parent.append(toolbar);
      const list = node('div');
      list.id = 'ua-conversation-messages';
      for (const row of [...(Array.isArray(data.items) ? data.items : [])].sort((a, b) => b.time - a.time)) {
        if (!['user', 'assistant'].includes(row.role) || !finite(row.time) || typeof row.text !== 'string') continue;
        const article = node('article', null, 'ua-conversation-message ua-role-' + row.role), header = node('header');
        article.dataset.time = row.time;
        header.append(node('strong', row.role === 'user' ? '사용자' : 'AI'), node('time', date(row.time)));
        if (row.context) header.append(node('span', '선택 구간 이전', 'ua-tag'));
        if (row.clipped) header.append(node('span', '긴 메시지 일부 표시', 'ua-tag'));
        article.append(header, node('pre', row.text));
        list.append(article);
      }
      parent.append(list);
      if (!list.childElementCount) parent.append(node('p', data.loading ? '큰 기록을 읽는 중입니다. 계속 읽기로 이어서 확인하세요.' : '이 범위의 사용자·AI 텍스트 기록이 없습니다.'));
      if (data.limited || data.oversizedLines || data.malformedLines || data.incompleteTail) parent.append(node('p', '일부 파일·표시 한도·큰 줄·미완성 기록은 생략될 수 있습니다.', 'ua-details-note'));
    };
    const loadConversation = (cursor = null, continuing = false) => {
      if (!continuing) conversationChunks = 0;
      const entry = activeConversationKey ? conversationStore.get(activeConversationKey) : null;
      if (!entry || !isOpen() || !selection) return;
      entry.loading = true;
      entry.error = null;
      conversationLatest = 'conversation-' + Date.now() + '-' + ++serial;
      conversationRequestKey = entry.key;
      conversationRequestCursor = cursor;
      renderConversationPanel();
      api.postMessage({
        type: 'conversation'
      , requestId: conversationLatest
      , ...selection
      , filters: {}
      , conversationSessionId: entry.sessionId
      , conversationHomeKey: entry.homeKey
      , cursor
      });
    };
    const openConversationForRow = row => {
      if (!validConversationMeta(row?.sessionId, row?.homeKey)) return;
      const key = conversationKeyOf(row.homeKey, row.sessionId);
      const label = row.project ? projectText(row.project, row.projectName) : null;
      const existing = conversationStore.get(key);
      if (existing) {
        if (label) existing.projectLabel = label;
        if (finite(row.lastObservedAt ?? row.time)) existing.lastObservedAt = row.lastObservedAt ?? row.time;
        conversationStore.delete(key);
        conversationStore.set(key, existing);
      } else {
        if (conversationStore.size >= 12) {
          const oldest = conversationStore.keys().next().value;
          if (oldest) conversationStore.delete(oldest);
        }
        conversationStore.set(key, {
          key
        , sessionId: row.sessionId
        , homeKey: row.homeKey
        , projectLabel: label
        , lastObservedAt: row.lastObservedAt ?? row.time ?? null
        , data: null
        , loading: false
        , error: null
        });
      }
      activeConversationKey = key;
      tabScrollTop.conversation = 0;
      updateConversationTabLabel();
      activateTab('conversation');
      loadConversation(null);
      scrollBox.scrollTop = 0;
      persist();
    };
    const conversationColumn = ['대화', row => row, row => {
      const key = row?.homeKey && row?.sessionId ? conversationKeyOf(row.homeKey, row.sessionId) : '';
      const opened = Boolean(key && conversationStore.get(key)?.data);
      const button = node('button', '대화 보기', 'ua-ghost' + (opened ? ' ua-conversation-opened' : ''));
      button.type = 'button';
      if (opened) button.title = '이미 불러온 대화 보기';
      button.disabled = !row.sessionId || !row.homeKey || report.analysisEnabled === false;
      button.addEventListener('click', () => openConversationForRow(row));
      return button;
    }];
    const currentFilters = () => Object.fromEntries(filterKeys.filter(key => typeof filters[key] === 'string' && filters[key]).map(key => [key === 'session' ? 'sessionId' : key, filters[key]]));
    const request = (type = 'details', extra = {}) => {
      if (!isOpen()) return;
      latest = `details-${Date.now()}-${++serial}`;
      el('details-status').textContent = type === 'analysisPreviewExclude' ? '제외 범위를 검증하고 있습니다…' : '분석을 불러오고 있습니다…';
      el('details-retry').hidden = true; dialog.setAttribute('aria-busy', 'true');
      dialog.querySelectorAll('[data-analysis-action]').forEach(button => {button.disabled = true;});
      api.postMessage({type, requestId: latest, ...selection, filters: currentFilters(), ...extra});
    };
    const setFilter = (key, value) => {
      filters[key] = String(value || '');
      const control = form.elements.namedItem(key);
      if (control) control.value = filters[key];
      syncFilterHighlights();
      preview = null;
      persist();
      request();
    };
    const fillFilters = () => {
      const rows = [...items(report.sessions), ...items(report.requests), ...items(report.calls), ...items(report.agents), ...items(report.comparisons), ...items(report.projects)];
      for (const [id, name] of Object.entries(report.projectLabels || {})) if (projectName(name)) projectNames.set(id, projectName(name));
      for (const row of rows) if (typeof row.project === 'string' && projectName(row.projectName)) projectNames.set(row.project, projectName(row.projectName));
      for (const key of filterKeys) {
        const select = form.elements.namedItem(key), values = pools.get(key) || new Set();
        for (const value of key === 'inputBand' ? ['0-10k', '10k-100k', '100k-200k', '200k+', 'unknown'] : key === 'cacheBand' ? ['0%', '0-50%', '50-90%', '90-100%', 'unknown'] : []) values.add(value);
        for (const entry of rows) {
          const value = key === 'session' ? entry.sessionId : entry[key];
          if (typeof value === 'string' && value) values.add(value);
          const plural = {model: 'models', effort: 'efforts', mode: 'modes'}[key];
          if (plural && Array.isArray(entry[plural])) for (const v of entry[plural]) if (typeof v === 'string') values.add(v);
        }
        for (const option of report.filterOptions?.[key] || []) if (typeof option === 'string') values.add(option);
        if (filters[key]) values.add(filters[key]); pools.set(key, values);
        if (key === 'project') {
          projectNameCounts.clear();
          for (const id of values) {const name = projectNames.get(id); if (name) projectNameCounts.set(name, (projectNameCounts.get(name) || 0) + 1);}
        }
        const first = node('option', '전체'); first.value = ''; select.replaceChildren(first);
        for (const value of [...values].sort()) {const option = node('option', key === 'project' ? projectText(value) : display(key, value)); option.value = value; select.append(option);}
        select.value = filters[key] || '';
      }
      syncFilterHighlights();
    };
    const subset = source => ({...source, items: items(source).filter(row => filterKeys.every(key => {
      const value = filters[key]; if (!value) return true;
      if (key === 'session') return row.sessionId == null && !('sessionId' in row) || row.sessionId === value || row.id === value;
      const plural = {model: 'models', effort: 'efforts', mode: 'modes'}[key];
      return row[key] == null && !row[plural] || row[key] === value || Array.isArray(row[plural]) && row[plural].includes(value);
    }))});
    const fallbackProjectData = () => {
      const start = finite(report.summary?.start) ? report.summary.start : selection?.start ?? 0;
      const end = finite(report.summary?.end) ? report.summary.end : selection?.end ?? start + 3600000;
      const span = Math.max(1, end - start), stepMs = heatmapStep(span);
      const bucketCount = Math.max(1, Math.min(56, Math.ceil(span / stepMs)));
      const overall = Array.from({length: bucketCount}, (_, i) => ({start: start + i * stepMs, end: Math.min(end, start + (i + 1) * stepMs), callCount: 0, knownCostUsd: 0, tokens: 0}));
      const callItems = items(report.calls);
      const sourceRows = callItems.length ? callItems : items(report.sessions);
      const byProject = new Map();
      for (const row of sourceRows) {
        const id = typeof row.project === 'string' && row.project ? row.project : 'unknown';
        if (!byProject.has(id)) byProject.set(id, {project: id, projectName: projectName(row.projectName), callCount: 0, knownCostUsd: 0, tokens: 0, buckets: Array.from({length: bucketCount}, () => ({callCount: 0, knownCostUsd: 0, tokens: 0}))});
        const target = byProject.get(id);
        const rowCalls = callItems.length ? 1 : finite(row.callCount) ? row.callCount : 1;
        const rowCost = finite(row.knownCostUsd) ? row.knownCostUsd : finite(row.costUsd) ? row.costUsd : 0;
        const rowTokens = (finite(row.input) ? row.input : 0) + (finite(row.output) ? row.output : 0);
        target.callCount += rowCalls;
        target.knownCostUsd += rowCost;
        target.tokens += rowTokens;
        const rawTime = row.time ?? row.timestamp ?? row.lastObservedAt ?? row.completedAt ?? row.startedAt;
        const t = finite(rawTime) ? rawTime : start;
        if (t >= start && t < end) {
          const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - start) / stepMs)));
          target.buckets[idx].callCount += rowCalls;
          target.buckets[idx].knownCostUsd += rowCost;
          target.buckets[idx].tokens += rowTokens;
          overall[idx].callCount += rowCalls;
          overall[idx].knownCostUsd += rowCost;
          overall[idx].tokens += rowTokens;
        }
      }
      const sorted = [...byProject.values()].sort((a, b) => b.knownCostUsd - a.knownCostUsd || b.callCount - a.callCount);
      return {
        items: sorted
      , totalCount: sorted.length
      , start
      , end
      , bucketStepMs: stepMs
      , bucketCount
      , totals: {
          callCount: sorted.reduce((sum, item) => sum + item.callCount, 0)
        , knownCostUsd: sorted.reduce((sum, item) => sum + item.knownCostUsd, 0)
        , tokens: sorted.reduce((sum, item) => sum + item.tokens, 0)
        }
      , buckets: overall
      };
    };
    const renderProjectHeatmap = parent => {
      const data = report.projects && Array.isArray(report.projects.items) ? report.projects : fallbackProjectData();
      const projectRows = items(data);
      const card = node('section', null, 'ua-details-section ua-heatmap-card');
      card.id = 'ua-project-heatmap';
      card.setAttribute('aria-label', '프로젝트별 활동 히트맵');
      const head = node('div', null, 'ua-heatmap-head');
      const titleGroup = node('div', null, 'ua-heatmap-titles');
      titleGroup.append(
        node('h3', '프로젝트별 사용량 히트맵')
      , node('p', `프로젝트 ${text(data.totalCount ?? projectRows.length)}개 · 호출 ${text(data.totals?.callCount ?? report.summary?.callCount)}건`, 'ua-details-note ua-details-count')
      );
      const controls = node('div', null, 'ua-heatmap-controls');
      const metricGroup = node('div', null, 'ua-heatmap-metrics');
      metricGroup.setAttribute('role', 'group');
      metricGroup.setAttribute('aria-label', '히트맵 기준 지표');
      for (const [key, label] of [['cost', '환산액'], ['calls', '호출'], ['tokens', '토큰']]) {
        const btn = node('button', label, 'ua-heatmap-metric' + (heatmapMetric === key ? ' ua-active' : ''));
        btn.type = 'button';
        btn.dataset.heatmapMetric = key;
        btn.setAttribute('aria-pressed', String(heatmapMetric === key));
        btn.addEventListener('click', () => {
          if (heatmapMetric === key) return;
          heatmapMetric = key;
          persist();
          const holder = card.parentElement;
          if (holder) {const replacement = renderProjectHeatmap(null); card.replaceWith(replacement);}
        });
        metricGroup.append(btn);
      }
      const legend = node('div', null, 'ua-heatmap-legend');
      legend.setAttribute('aria-label', '사용 강도 범례');
      legend.append(node('span', '적음'));
      for (let level = 0; level <= 4; level++) {
        const swatch = node('i', null, 'ua-heat-cell');
        swatch.dataset.level = String(level);
        swatch.setAttribute('aria-hidden', 'true');
        legend.append(swatch);
      }
      legend.append(node('span', '많음'));
      controls.append(metricGroup, legend);
      head.append(titleGroup, controls);
      card.append(head);
      if (!projectRows.length || !data.bucketCount) {
        card.append(node('p', '표시할 프로젝트 활동 기록이 없습니다', 'ua-details-empty'));
        if (parent) parent.append(card);
        return card;
      }
      const metricValue = bucket => heatmapMetric === 'cost' ? (finite(bucket?.knownCostUsd) ? bucket.knownCostUsd : 0) : heatmapMetric === 'tokens' ? (finite(bucket?.tokens) ? bucket.tokens : 0) : (finite(bucket?.callCount) ? bucket.callCount : 0);
      const formatMetric = row => heatmapMetric === 'cost' ? '$' + amountText('전체 환산액 (USD)', row?.knownCostUsd ?? 0) : heatmapMetric === 'tokens' ? compactTokens(row?.tokens ?? 0) : text(row?.callCount ?? 0) + '건';
      const totalMetric = Math.max(0, metricValue(data.totals));
      const visibleProjects = showAllProjects ? projectRows : projectRows.slice(0, 6);
      let maxCell = 0;
      for (const item of visibleProjects) for (const bucket of item.buckets || []) maxCell = Math.max(maxCell, metricValue(bucket));
      let maxOverall = 0;
      for (const bucket of data.buckets || []) maxOverall = Math.max(maxOverall, metricValue(bucket));
      const levelOf = (value, ceiling) => {
        if (!finite(value) || value <= 0 || !finite(ceiling) || ceiling <= 0) return 0;
        const ratio = value / ceiling;
        return ratio <= .25 ? 1 : ratio <= .5 ? 2 : ratio <= .75 ? 3 : 4;
      };
      const showClock = (data.bucketStepMs || 0) < 86400000;
      const axisRow = node('div', null, 'ua-heatmap-axis');
      axisRow.append(node('span', '프로젝트', 'ua-heatmap-axis-label'));
      const ticks = node('div', null, 'ua-heatmap-ticks');
      const midTime = finite(data.start) && finite(data.end) ? Math.round((data.start + data.end) / 2) : null;
      ticks.append(node('span', shortStamp(data.start, showClock)), node('span', shortStamp(midTime, showClock)), node('span', shortStamp(data.end, showClock)));
      axisRow.append(ticks, node('span', {cost: '환산액 · 비중', calls: '호출 · 비중', tokens: '토큰 · 비중'}[heatmapMetric], 'ua-heatmap-axis-stat'));
      card.append(axisRow);
      const board = node('div', null, 'ua-heatmap-rows');
      board.style.setProperty('--buckets', String(data.bucketCount));
      const buildStrip = (buckets, ceiling, rowLabel) => {
        const strip = node('div', null, 'ua-heatmap-strip');
        strip.setAttribute('role', 'img');
        let activeBuckets = 0;
        for (let idx = 0; idx < data.bucketCount; idx++) if (metricValue(buckets?.[idx]) > 0) activeBuckets++;
        strip.setAttribute('aria-label', `${rowLabel} 시간대별 활동 히트맵 (${data.bucketCount}개 구간 중 ${activeBuckets}개 활동)`);
        for (let idx = 0; idx < data.bucketCount; idx++) {
          const bucket = buckets?.[idx] || {callCount: 0, knownCostUsd: 0, tokens: 0};
          const bStart = finite(data.start) && finite(data.bucketStepMs) ? data.start + idx * data.bucketStepMs : null;
          const bEnd = finite(bStart) && finite(data.bucketStepMs) ? Math.min(data.end, bStart + data.bucketStepMs) : null;
          const val = metricValue(bucket);
          const cell = node('span', null, 'ua-heat-cell');
          cell.dataset.level = String(levelOf(val, ceiling));
          cell.title = `${rowLabel} · ${shortStamp(bStart, true)}–${shortStamp(bEnd, true)} · 호출 ${text(bucket.callCount)}건 · $${amountText('전체 환산액 (USD)', bucket.knownCostUsd)} · 토큰 ${compactTokens(bucket.tokens)}`;
          strip.append(cell);
        }
        return strip;
      };
      if (projectRows.length > 1 && Array.isArray(data.buckets) && data.buckets.length) {
        const allRow = node('div', null, 'ua-heatmap-row ua-heatmap-overall' + (!filters.project ? ' ua-selected' : ''));
        const allBtn = node('button', '전체 합계', 'ua-heatmap-project');
        allBtn.type = 'button';
        allBtn.setAttribute('aria-pressed', String(!filters.project));
        allBtn.disabled = !filters.project;
        allBtn.addEventListener('click', () => {if (filters.project) setFilter('project', '');});
        const stat = node('div', null, 'ua-heatmap-stat');
        stat.append(node('strong', formatMetric(data.totals)), node('span', '100%', 'ua-heatmap-share'));
        allRow.append(allBtn, buildStrip(data.buckets, maxOverall, '전체 합계'), stat);
        board.append(allRow);
      }
      for (const item of visibleProjects) {
        const label = projectText(item.project, item.projectName);
        const isSelected = Boolean(filters.project && filters.project === item.project);
        const rowEl = node('div', null, 'ua-heatmap-row' + (isSelected ? ' ua-selected' : ''));
        const canFilter = typeof item.project === 'string' && item.project !== 'unknown';
        const btn = node('button', label, 'ua-heatmap-project');
        btn.type = 'button';
        btn.title = canFilter ? (isSelected ? `${label} 필터 해제` : `${label} 프로젝트만 보기`) : label;
        btn.disabled = !canFilter;
        if (canFilter) {
          btn.setAttribute('aria-pressed', String(isSelected));
          btn.dataset.projectFilter = label;
          btn.addEventListener('click', () => setFilter('project', isSelected ? '' : item.project));
        }
        const value = metricValue(item);
        const share = totalMetric > 0 ? value / totalMetric : 0;
        const stat = node('div', null, 'ua-heatmap-stat');
        stat.append(node('strong', formatMetric(item)), node('span', totalMetric > 0 ? percent(share) : '-', 'ua-heatmap-share'));
        rowEl.append(btn, buildStrip(item.buckets, maxCell || maxOverall, label), stat);
        board.append(rowEl);
      }
      card.append(board);
      if (projectRows.length > 6) {
        const toggle = node('button', showAllProjects ? '상위 6개만 보기' : `전체 ${projectRows.length}개 프로젝트 보기`, 'ua-ghost ua-heatmap-more');
        toggle.type = 'button';
        toggle.addEventListener('click', () => {
          showAllProjects = !showAllProjects;
          const replacement = renderProjectHeatmap(null);
          card.replaceWith(replacement);
        });
        card.append(toggle);
      }
      if (parent) parent.append(card);
      return card;
    };
    const applyReportView = container => {
      if (!container) return;
      container.dataset.reportView = reportView;
      for (const block of container.querySelectorAll('[data-report-section]')) {
        block.hidden = reportView !== 'all' && block.dataset.reportSection !== reportView;
      }
    };
    const renderDiagnostics = () => {
      const block = el('details-diagnostics');
      block.hidden = el('tab-conversation').getAttribute('aria-selected') === 'true' || !getModel().diagnosticsEnabled || report?.diagnostics?.enabled === false;
      block.replaceChildren();
      if (block.hidden) return;
      const head = node('div', null, 'ua-details-section-head');
      head.append(node('h3', 'Usage Atlas 수집기 진단'));
      block.append(head);
      const data = report?.diagnostics;
      metrics(block, {...(data?.summary || {}), ...(data?.adapter || {})}, ['samples', 'lastMs', 'meanMs', 'p95Ms', 'cpuMs', 'rssMiB', 'heapMiB', 'cacheHit', 'fetchMs']);
      notes(block, data?.note);
      notes(block, data?.notes);
      const events = data?.events || [];
      const fold = node('details', null, 'ua-details-fold');
      fold.append(node('summary', `수집 단계별 표본 (${events.length}건)`));
      table(fold, '수집 단계별 표본', {items: events, totalCount: events.length}, [
        ['시각', row => row.time, date]
      , ['단계', row => ({query: '조회', storage: '기록 저장', details: '상세 분석', 'session-index': '세션 색인', conversion: '자동 환산'}[row.stage] || '-')]
      , ['소요 시간 (ms)', row => row.elapsedMs]
      , ['CPU (ms)', row => row.cpuMs]
      , ['프로세스 메모리 (MiB)', row => row.rssMiB]
      , ['결과', row => row.outcome === 'success' ? '완료' : row.outcome === 'failed' ? '오류' : '-']
      ]);
      block.append(fold);
    };
    const renderHistory = () => {
      const parent = el('panel-history'); parent.replaceChildren();
      metrics(section(parent, '주기 요약'), report.cycles?.summary, ['currentCount', 'partialCount', 'completeCount', 'rawQuotaDelta', 'observedQuotaDelta']);
      const cycleColumns = [
        ['주기', row => row.id]
      , ['시작', row => row.start, date]
      , ['종료', row => row.end, date]
      , ['사용률 변화 (pp)', row => row.quotaDelta]
      , ['호출', row => row.callCount]
      , ['소계 (USD)', row => row.knownCostUsd]
      , ['부분 주기', row => row.partial]
      , ['공백', row => row.gapCount]
      ];
      table(parent, '초기화 주기', report.cycles, cycleColumns, cycle => {range = [cycle.start, cycle.end]; preview = null; renderHistory(); el('exclude-reason')?.focus();});
      const split = node('div', null, 'ua-history-grid');
      parent.append(split);
      const block = section(split, '분석에서 제외');
      block.append(node('p', '원본 그래프와 공식 한도는 유지됩니다. 실제 관측 시각을 선택하고 사유를 입력한 뒤 미리보기를 확인하세요.', 'ua-details-note'));
      const times = [
        ...items(report.cycles).flatMap(cycle => [cycle.observedStart, cycle.observedEnd, cycle.start, cycle.end, ...(cycle.observedTimes || [])])
      , ...(report.coverage?.observedTimes || [])
      , ...(report.observedTimes || [])
      ].filter(finite);
      for (const time of times) endpointPool.add(time);
      if (!range) range = [selection.start, selection.end];
      const observed = [...endpointPool].filter(time => time >= selection.start && time <= selection.end).sort((a, b) => a - b);
      if (observed.length >= 2) {
        const closest = value => observed.reduce((best, next) => Math.abs(next - value) < Math.abs(best - value) ? next : best, observed[0]);
        range = range.map(closest);
        for (const [index, label] of [[0, '제외 시작'], [1, '제외 종료']]) {
          const field = node('label', label + ' · ' + date(range[index]), 'ua-details-range'), input = node('input');
          input.type = 'range'; input.id = 'ua-exclude-' + (index ? 'end' : 'start'); input.min = 0; input.max = observed.length - 1; input.step = 1; input.value = observed.indexOf(range[index]); input.setAttribute('aria-label', label); input.setAttribute('aria-valuetext', date(range[index]));
          input.addEventListener('input', () => {range[index] = observed[Number(input.value)]; field.firstChild.textContent = label + ' · ' + date(range[index]); input.setAttribute('aria-valuetext', date(range[index])); preview = null; previewText.textContent = '범위가 변경되었습니다. 미리보기를 다시 확인하세요.'; commit.disabled = true;});
          field.append(input); block.append(field);
        }
      } else block.append(node('p', '제외할 관측 경계가 부족합니다. 다른 주기 또는 범위를 선택하세요.', 'ua-details-note'));
      const reasonLabel = node('label', '제외 사유', 'ua-details-reason'), reason = node('input');
      reason.type = 'text'; reason.id = 'ua-exclude-reason'; reason.maxLength = 160; reason.autocomplete = 'off'; reason.setAttribute('aria-label', '제외 사유'); reason.value = preview?.reason || reasonDraft;
      reasonLabel.append(reason); block.append(reasonLabel);
      const previewText = node('p', '', 'ua-details-note'); previewText.id = 'ua-exclude-preview'; previewText.setAttribute('role', 'status'); block.append(previewText);
      const actions = node('div', null, 'ua-details-actions'), check = node('button', '제외 미리보기'), commit = node('button', '확인한 범위 제외');
      for (const button of [check, commit]) {button.type = 'button'; button.dataset.analysisAction = ''; actions.append(button);}
      check.id = 'ua-exclude-check'; commit.id = 'ua-exclude-commit'; commit.disabled = true;
      reason.addEventListener('input', () => {reasonDraft = reason.value; preview = null; previewText.textContent = ''; commit.disabled = true;});
      check.disabled = observed.length < 2;
      check.addEventListener('click', () => {
        if (!reason.value.trim()) {previewText.textContent = '제외 사유를 입력하세요.'; reason.focus(); return;}
        if (!(range[0] < range[1])) {previewText.textContent = '종료 시각은 시작 시각보다 뒤여야 합니다.'; return;}
        preview = {start: range[0], end: range[1], reason: reason.value.trim(), validated: false};
        request('analysisPreviewExclude', {excludeStart: preview.start, excludeEnd: preview.end, reason: preview.reason});
      });
      if (preview?.validated) {
        const value = report.exclusionPreview;
        previewText.textContent = `${date(preview.start)} – ${date(preview.end)} · 사유: ${preview.reason} · 호출 ${text(value?.before?.callCount)} → ${text(value?.after?.callCount)} · 소계 (USD) ${text(value?.before?.knownCostUsd)} → ${text(value?.after?.knownCostUsd)}`;
        commit.disabled = false;
      }
      commit.addEventListener('click', () => {if (preview?.validated) {const value = {...preview}; preview = null; request('analysisExclude', {excludeStart: value.start, excludeEnd: value.end, reason: value.reason});}});
      block.append(actions);
      const effect = section(split, '제외 적용 차이');
      for (const [key, title] of [['before', '적용 전'], ['after', '적용 후']]) {effect.append(node('h4', title)); metrics(effect, report.exclusions?.effects?.[key], ['callCount', 'pricedCallCount', 'knownCostUsd']);}
      metrics(effect, report.exclusions?.effects, ['removedCallCount', 'removedKnownCostUsd']);
      table(parent, '제외 이력', report.exclusions, [
        ['제외 ID', row => row.exclusionId || row.id]
      , ['시작', row => row.start, date]
      , ['종료', row => row.end, date]
      , ['사유', row => row.reason]
      , ['적용 중', row => row.active]
      ], item => {
        if (item.active === false) return;
        block.querySelector('.ua-details-restore')?.remove(); const box = node('div', null, 'ua-details-restore'); box.append(node('p', `${date(item.start)} – ${date(item.end)} · ${text(item.reason)} · 제외를 복원할까요?`));
        const button = node('button', '제외 복원'); button.type = 'button'; button.dataset.analysisAction = ''; button.addEventListener('click', () => request('analysisRestore', {exclusionId: item.exclusionId || item.id})); box.append(button); block.append(box); button.focus();
      });
      notes(parent, report.exclusions?.notes);
    };
    const render = () => {
      fillFilters();
      if (report.analysisEnabled === false && conversationStore.size) clearAllConversations(true);
      const usage = el('panel-report'); usage.replaceChildren();
      if (finite(report.summary?.start) && finite(report.summary?.end)) el('details-context').textContent = `${date(report.summary.start)} – ${date(report.summary.end)} · 종료 시각 제외`;
      if (report.analysisEnabled === false) usage.append(node('p', '세션 분석이 설정에서 꺼져 있습니다. 사용률 기록과 수집 범위는 계속 확인할 수 있습니다.', 'ua-details-note'));
      el('details-filters').hidden = activeTab === 'conversation' || report.quotaOnly === true;
      el('tab-conversation').hidden = report.quotaOnly === true;
      if (report.quotaOnly) {
        if (activeTab === 'conversation') activateTab('report');
        usage.append(node('p', '그룹별 한도 관측입니다. 호출·토큰·대화 및 추가 크레딧 소비는 제공되지 않습니다.', 'ua-details-note'));
        table(usage, '사용률 관측', subset(report.observations), [['시각', row => row.time, date], ['사용률', row => finite(row.used) ? text(row.used) + '%' : '-'], ['초기화', row => row.reset, date]]);
      } else {
        const overview = node('div', null, 'ua-report-overview');
        usage.append(overview);
        const summary = section(overview, '선택 구간 요약', 'ua-summary-card');
        metrics(summary, report.summary, ['knownCostUsd', 'costUsd', 'callCount', 'sessionCount', 'requestCount', 'cacheRatio'], ['knownCostUsd']);
        tokenMix(summary, report.summary);
        const extraFold = node('details', null, 'ua-details-fold ua-summary-more');
        extraFold.append(node('summary', '세부 집계 (토큰·색인 범위)'));
        metrics(extraFold, report.summary, ['pricedCallCount', 'sourceCallCount', 'eligibleCallCount', 'input', 'cached', 'output']);
        summary.append(extraFold);
        renderProjectHeatmap(overview);
        const viewBar = node('div', null, 'ua-report-viewbar');
        viewBar.setAttribute('role', 'group');
        viewBar.setAttribute('aria-label', '표 보기 선택');
        const sessionsSub = subset(report.sessions), requestsSub = subset(report.requests), callsSub = subset(report.calls), agentsSub = subset(report.agents);
        const viewItems = [
          ['all', '전체 표']
        , ['sessions', `세션 (${items(sessionsSub).length})`]
        , ['requests', `요청 (${items(requestsSub).length})`]
        , ['calls', `호출 (${items(callsSub).length})`]
        , ['agents', `에이전트 (${items(agentsSub).length})`]
        ];
        const reportGrid = node('div', null, 'ua-report-grid');
        for (const [key, label] of viewItems) {
          const btn = node('button', label, 'ua-view-pill' + (reportView === key ? ' ua-active' : ''));
          btn.type = 'button';
          btn.dataset.reportViewTarget = key;
          btn.setAttribute('aria-pressed', String(reportView === key));
          btn.addEventListener('click', () => {
            reportView = key;
            for (const sibling of viewBar.querySelectorAll('button')) {
              const active = sibling.dataset.reportViewTarget === key;
              sibling.classList.toggle('ua-active', active);
              sibling.setAttribute('aria-pressed', String(active));
            }
            applyReportView(reportGrid);
            persist();
          });
          viewBar.append(btn);
        }
        usage.append(viewBar, reportGrid);
        const aggregate = [
          ['세션', row => row.sessionId || row.id]
        , ['최근', row => row.lastObservedAt ?? row.completedAt ?? row.startedAt, date]
        , ['프로젝트', row => projectText(row.project, row.projectName)]
        , ['호출', row => row.callCount]
        , ['전체 환산액 (USD)', row => row.costUsd]
        , ['가격 확인 소계 (USD)', row => row.knownCostUsd]
        , ['자체 소계 (USD)', row => row.ownCostUsd]
        , ['하위 소계 (USD)', row => row.descendantCostUsd]
        , ['상위 세션', row => row.parentSessionId]
        ];
        table(reportGrid, '세션 → 요청 → 호출', sessionsSub, [...aggregate, conversationColumn], row => setFilter('session', row.sessionId || row.id), {reportSection: 'sessions', sectionClass: 'ua-grid-half'});
        table(reportGrid, '요청', requestsSub, [['요청', row => row.turnId ?? row.requestId ?? null], ...aggregate.slice(0, 6), conversationColumn], Object.assign(row => setFilter('turnId', row.turnId), {enabled: row => row.turnId != null}), {reportSection: 'requests', sectionClass: 'ua-grid-half'});
        table(reportGrid, '호출', callsSub, [
          ['모델', row => row.model]
        , conversationColumn
        , ['세션', row => row.sessionId]
        , ['요청', row => row.turnId]
        , ['시각', row => row.time ?? row.timestamp ?? row.startedAt, date]
        , ['추론 수준', row => row.effort]
        , ['모드', row => row.mode]
        , ['입력', row => row.input]
        , ['캐시', row => row.cached]
        , ['출력', row => row.output]
        , ['API 비교액 (USD)', row => row.costUsd]
        , ...(selection.provider === 'codex' ? [['크레딧 차감 추정', row => row.purchasedCredits], ['구독 환산 단위', row => row.subscriptionCredits]] : [])
        , ['구독 환산 사용률 (%)', row => row.quotaPercent]
        , ...(selection.provider === 'codex' ? [['차감 상태', row => row.creditAssumed ? '추정 · Standard 가정' : row.creditIssue === 'unknown-or-unsupported-credit-mode' ? '모드 미지원' : row.creditIssue ? '차감 근거 부족' : finite(row.purchasedCredits) ? '추정' : '-']] : [])
        , ['구독 환산 상태', row => row.quotaConversionIssue === 'unverified-call-interval' ? '호출 구간 미확인' : row.quotaConversionIssue ? '관측 근거 부족' : finite(row.quotaPercent) ? row.quotaTimingAssumed || row.quotaCalibrationTimingAssumed ? '추정 · 관측 시각' : '추정' : '-']
        , ['환산 상태', row => priceStatus(row)]
        , ['구간 일치', row => ({matched: '일치', unmatched: '불일치', provisional: '잠정'}[row.matchState] || '-')]
        ], null, {reportSection: 'calls', sectionClass: 'ua-grid-full'});
        table(reportGrid, '에이전트 계층 (자체·하위 분리)', agentsSub, aggregate, null, {reportSection: 'agents', sectionClass: 'ua-grid-full'});
        applyReportView(reportGrid);
      }
      const coverage = el('panel-coverage'); coverage.replaceChildren();
      const coverageGrid = node('div', null, 'ua-two-col-sections');
      coverage.append(coverageGrid);
      metrics(section(coverageGrid, '수집·가격 확인 범위'), report.coverage, ['sourceCallCount', 'eligibleCallCount', 'pricedCallCount', 'matchedCallCount', 'unmatchedCallCount', 'provisionalCallCount']);
      const collection = section(coverageGrid, 'Usage Atlas 수집 상태');
      collection.append(node('p', `최근 ${date(report.collection?.last)} · 다음 ${date(report.collection?.next)}`, 'ua-details-note'));
      metrics(collection, report.collection, ['message', 'errors', 'baseIntervalSeconds', 'effectiveIntervalSeconds', 'adaptive']);
      const connection = {onDemand: '필요할 때 연결', persistent: '연결 유지', 'https-keep-alive': 'HTTPS 연결 재사용', 'local-rpc': '로컬 사용량 조회'}[report.collection?.connection];
      collection.append(node('p', '수집 연결 · ' + (connection || '-'), 'ua-details-note'));
      const sourceCoverage = section(coverage, '로컬 색인 범위');
      metrics(sourceCoverage, report.coverage?.source, ['roots', 'files', 'calls', 'partial', 'pendingFiles', 'malformedLines', 'oversizedLines', 'unavailableFiles', 'unknownAccountFiles', 'unknownTimeCalls', 'limited', 'cacheRecovered', 'cacheWriteFailed']);
      if (report.coverage?.source?.partial === true) notes(sourceCoverage, '일부 기록만 색인된 상태입니다. 아래 집계는 확인된 범위에 한정됩니다.');
      const sourceCodes = report.coverage?.source?.notes;
      notes(sourceCoverage, (Array.isArray(sourceCodes) ? sourceCodes : typeof sourceCodes === 'string' ? [sourceCodes] : []).map(code => Object.hasOwn(sourceNotes, code) ? sourceNotes[code] : /[가-힣]/.test(code) ? code : null).filter(Boolean));
      const storageGrid = node('div', null, 'ua-two-col-sections');
      coverage.append(storageGrid);
      metrics(section(storageGrid, '기록 저장 상태'), report.storage, ['pending', 'memory', 'bytes', 'issue', 'recovered']);
      const missing = report.coverage?.missingFields;
      if (Array.isArray(missing)) notes(section(storageGrid, '누락 필드'), missing.map(entry => {
        const key = typeof entry === 'string' ? entry : entry?.field;
        return `${labels[key] || ({model: '모델', effort: '추론 수준', mode: '모드', latencyMs: '지연 시간'}[key] || '일부 필드')}${typeof entry === 'object' ? ' · ' + text(entry?.callCount) + '건' : ''}`;
      }));
      else if (missing && typeof missing === 'object') {const block = section(storageGrid, '누락 필드'); for (const [key, value] of Object.entries(missing)) block.append(node('p', `${labels[key] || ({model: '모델', effort: '추론 수준', mode: '모드', latencyMs: '지연 시간'}[key] || '일부 필드')} · ${text(value)}`));}
      notes(coverage, report.coverage?.notes);
      const performance = el('panel-performance'); performance.replaceChildren();
      const compared = subset(report.comparisons);
      table(performance, '모델·추론 수준·모드 비교', compared, [
        ['모델', row => row.model]
      , ['추론 수준', row => row.effort]
      , ['모드', row => row.mode]
      , ['표본', row => row.sampleCount]
      , ['가격 표본', row => row.pricedSampleCount]
      , ['환산액 평균 (USD)', row => row.cost?.mean]
      , ['환산액 중앙값 (USD)', row => row.cost?.median]
      , ['환산액 P90 (USD)', row => row.cost?.p90]
      , ['지연 표본', row => row.latencySampleCount]
      , ['지연 미확인 표본', row => row.latencyUnknownSampleCount]
      , ['지연 확인', row => row.latencyLabel]
      , ['지연 평균 (ms)', row => row.latencyMs?.mean]
      , ['지연 중앙값 (ms)', row => row.latencyMs?.median]
      , ['지연 P90 (ms)', row => row.latencyMs?.p90]
      , ['캐시 표본', row => row.cacheSampleCount]
      , ['적은 표본', row => row.smallSample]
      ]);
      notes(performance, [...new Set(items(compared).flatMap(row => [row.label, ...[row.latencyNotes].flat()]).filter(value => typeof value === 'string' && value))]);
      const cache = section(performance, '캐시'); metrics(cache, report.cache, ['input', 'cached', 'ratio', 'validSampleCount']); notes(cache, report.cache?.notes);
      table(cache, '캐시 비율 저하 의심 (장애 확정 아님)', {items: Array.isArray(report.cache?.suspicions) ? report.cache.suspicions : [], totalCount: report.cache?.suspicions?.length}, [
        ['세션', row => row.sessionId]
      , ['모델', row => row.model]
      , ['추론 수준', row => row.effort]
      , ['모드', row => row.mode]
      , ['시작', row => row.start, date]
      , ['종료', row => row.end, date]
      , ['이전 비율', row => row.beforeRatio, percent]
      , ['이후 비율', row => row.afterRatio, percent]
      , ['표본', row => row.sampleCount]
      ]);
      const conversion = section(performance, '구독 사용률 자동 환산');
      table(conversion, '구독 100%당 관측 환산 기준', report.conversion?.cohorts || [], [
        ['요금제', row => row.plan]
      , ['배율', row => row.mult]
      , [report.conversion?.unit === 'credits' ? '구독 환산 단위 / 100%' : 'USD / 100%', row => row.unitsPerPercent * 100]
      , ['관측 증가 (pp)', row => row.quotaDelta]
      , ['호출', row => row.callCount]
      , ['Standard 가정', row => row.assumedCallCount]
      , ['관측 시각 대응', row => row.eventCallCount]
      ]);
      notes(conversion, [...(report.conversion?.notes || []), ...(report.conversion?.assumedDebitCount > 0 ? ['호출 근거가 없는 차감 ' + text(report.conversion.assumedDebitCount) + '개 구간에 Standard를 가정했습니다.'] : [])]);
      const estimate = section(performance, 'API 비교 비용 / 사용률 100%');
      metrics(estimate, report.estimate, ['valueUsdPer100Pct', 'knownCostUsd', 'quotaDelta', 'matchedCallCount', 'unmatchedCallCount', 'provisionalCallCount', 'pricedCallCount', 'assumedCallCount'], ['valueUsdPer100Pct']);
      notes(estimate, report.estimate?.notes);
      sensitivityTable(estimate, '조건별 민감도', report.estimate?.sensitivity);
      renderHistory(); renderDiagnostics(); renderConversationPanel();
      const source = report.provenance || {}, provenance = el('details-provenance'), links = node('span', null, 'ua-provenance-sources'), seen = new Set();
      links.append(node('span', '출처'));
      for (const entry of Array.isArray(source.sources) ? source.sources : source.sources ? [source.sources] : []) {
        if (typeof entry?.url !== 'string') continue;
        let url;
        try {url = new URL(entry.url);} catch {continue;}
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || seen.has(url.href)) continue;
        seen.add(url.href);
        const host = url.hostname.replace(/^www\./, ''), label = Object.hasOwn(sourceLabels, entry.id) ? sourceLabels[entry.id] : host.length > 24 ? host.slice(0, 21) + '…' : host;
        const link = node('a', label), title = typeof entry.title === 'string' && entry.title.trim() ? entry.title : host;
        link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = title;
        link.setAttribute('aria-label', `${label} · ${title} (새 탭)`); links.append(link);
      }
      if (!seen.size) links.append(node('span', '-'));
      const catalog = node('span', '가격표 ' + text(source.catalogVersion), 'ua-provenance-meta'), verified = node('span', '기준 ' + date(source.priceVerifiedAt ?? source.asOf), 'ua-provenance-meta');
      catalog.id = 'ua-details-price-catalog'; verified.id = 'ua-details-price-date'; provenance.replaceChildren(links, catalog, verified);
      notes(coverage, source.notes);
    };
    const activateTab = (key, options = {}) => {
      if (!tabKeys.includes(key)) key = 'report';
      if (isOpen() && activeTab && scrollBox) tabScrollTop[activeTab] = scrollBox.scrollTop;
      activeTab = key;
      form.hidden = key === 'conversation' || report?.quotaOnly === true;
      el('details-status').hidden = key === 'conversation';
      el('details-diagnostics').hidden = key === 'conversation' || !getModel().diagnosticsEnabled || report?.diagnostics?.enabled === false;
      for (const button of el('details-tabs').querySelectorAll('[role="tab"]')) {
        const selected = button.dataset.detailsTab === key;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        el('panel-' + button.dataset.detailsTab).hidden = !selected;
      }
      if (scrollBox && options.preserveScroll !== false) scrollBox.scrollTop = tabScrollTop[key] || 0;
      if (!options.skipPersist && isOpen()) persist();
    };
    const close = () => {
      if (!isOpen()) return;
      clearAllConversations(true);
      api.postMessage({type: 'detailsClosed', requestId: latest || 'closed'});
      latest = ''; preview = null; selection = null; report = null;
      dialog.close(); dialog.removeAttribute('aria-busy');
      persist();
      const target = returnFocus?.isConnected ? returnFocus : typeof returnFocus === 'string' ? [...root.querySelectorAll('[data-details-line]')].find(item => item.dataset.detailsLine === returnFocus) : null;
      (target || root.querySelector('[data-chart-hit]'))?.focus({preventScroll: true});
    };
    el('details-close').addEventListener('click', close);
    dialog.addEventListener('cancel', event => {event.preventDefault(); close();});
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.preventDefault(); close(); return;}
      if (event.key !== 'Tab') return;
      const targets = focusables(), first = targets[0], last = targets.at(-1);
      if (event.shiftKey && (document.activeElement === first || !targets.includes(document.activeElement))) {event.preventDefault(); last?.focus();}
      else if (!event.shiftKey && (document.activeElement === last || !targets.includes(document.activeElement))) {event.preventDefault(); first?.focus();}
    });
    el('details-tabs').addEventListener('click', event => {const button = event.target.closest('[data-details-tab]'); if (button) activateTab(button.dataset.detailsTab);});
    el('details-tabs').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...el('details-tabs').querySelectorAll('[role="tab"]')], index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
      activateTab(buttons[next].dataset.detailsTab); buttons[next].focus(); event.preventDefault();
    });
    form.addEventListener('submit', event => event.preventDefault());
    form.addEventListener('change', event => {
      if (filterKeys.includes(event.target.name)) {
        filters[event.target.name] = event.target.value;
        syncFilterHighlights();
        preview = null;
        persist();
        request();
      }
    });
    el('details-filter-reset').addEventListener('click', () => {
      for (const key of filterKeys) {delete filters[key]; form.elements.namedItem(key).value = '';}
      syncFilterHighlights();
      preview = null;
      persist();
      request();
    });
    el('details-retry').addEventListener('click', () => {preview = null; request();});
    window.addEventListener('message', event => {
      const message = event.data;
      if (['conversation', 'conversationError'].includes(message?.type)) {
        if (!isOpen() || !conversationLatest || message.requestId !== conversationLatest || !conversationRequestKey) return;
        const targetKey = conversationRequestKey, triedCursor = conversationRequestCursor;
        const entry = conversationStore.get(targetKey);
        conversationLatest = '';
        conversationRequestKey = '';
        conversationRequestCursor = null;
        if (!entry) return;
        entry.loading = false;
        if (message.type === 'conversation' && message.data) {
          entry.data = message.data;
          entry.error = null;
          renderConversationPanel();
          if (activeTab === 'conversation' && activeConversationKey === targetKey && scrollBox && !triedCursor) scrollBox.scrollTop = tabScrollTop.conversation || 0;
          if (message.data.loading && message.data.next && conversationChunks++ < 8) {
            requestAnimationFrame(() => {
              if (isOpen() && activeConversationKey === targetKey && conversationStore.get(targetKey) === entry && !conversationLatest) loadConversation(message.data.next, true);
            });
          }
        } else if (triedCursor != null) {
          // 탭 전환 등으로 이전 페이지 커서가 만료된 경우 최신 페이지부터 다시 연다.
          loadConversation(null);
        } else {
          entry.error = '로컬 대화를 불러오지 못했습니다.';
          renderConversationPanel();
        }
        return;
      }
      if (message?.type === 'data') {
        const nextDiagnostics = Boolean(message.diagnosticsEnabled), nextAnalysis = message.analysisEnabled !== false;
        const changed = nextDiagnostics !== diagnosticsFlag || nextAnalysis !== analysisFlag;
        diagnosticsFlag = nextDiagnostics; analysisFlag = nextAnalysis;
        if (!nextAnalysis && conversationStore.size) {clearAllConversations(true); if (isOpen()) persist();}
        if (isOpen()) {
          syncHeader();
          el('details-diagnostics').hidden = el('tab-conversation').getAttribute('aria-selected') === 'true' || !nextDiagnostics || report?.diagnostics?.enabled === false;
          if (changed && report && !latest) {preview = null; request();}
        }
        return;
      }
      if (!isOpen() || !latest || message?.requestId !== latest || !['details', 'detailsError'].includes(message.type)) return;
      dialog.removeAttribute('aria-busy'); latest = '';
      if (message.type === 'detailsError' || !message.data || typeof message.data !== 'object') {
        preview = null; dialog.querySelectorAll('[data-analysis-action]').forEach(button => {button.disabled = button.id === 'ua-exclude-commit';});
        const reason = typeof message.error === 'string' && /[가-힣]/.test(message.error) ? message.error : '';
        el('details-status').textContent = reason || '분석을 불러오지 못했습니다. 다시 시도하세요.'; el('details-retry').hidden = false; return;
      }
      report = message.data;
      if (preview) preview.validated = !!report.exclusionPreview && report.exclusionPreview.start === preview.start && report.exclusionPreview.end === preview.end && report.exclusionPreview.reason === preview.reason;
      const activeElement = document.activeElement, activeId = activeElement?.id;
      render();
      if (activeElement && !activeElement.isConnected) (document.getElementById(activeId) || el('details-tabs').querySelector('[aria-selected="true"]'))?.focus({preventScroll: true});
      el('details-status').textContent = preview && !preview.validated ? '제외 범위를 확인하지 못했습니다. 범위와 사유를 다시 확인하세요.' : '분석 완료';
    });
    const resetModalContainers = () => {
      for (const key of ['report', 'coverage', 'performance', 'history']) {el('panel-' + key).replaceChildren(); tabScrollTop[key] = 0;}
      tabScrollTop.conversation = 0;
      el('details-provenance').textContent = '';
      el('details-diagnostics').replaceChildren();
    };
    return {
      open(value, target) {
        selection = {provider: value.provider, window: value.window, time: value.time, start: value.start, end: value.end};
        clearAllConversations(true);
        report = null; preview = null; range = null; reasonDraft = ''; reportView = 'all'; showAllProjects = false;
        pools.clear(); endpointPool.clear(); projectNames.clear(); projectNameCounts.clear();
        for (const key of filterKeys) {delete filters[key]; form.elements.namedItem(key).value = '';}
        syncFilterHighlights();
        returnFocus = target?.dataset?.detailsLine || target || document.activeElement;
        syncHeader();
        el('details-context').textContent = `${date(value.start)} – ${date(value.end)}`;
        resetModalContainers();
        renderConversationPanel();
        if (!dialog.open) dialog.showModal();
        activateTab('report', {preserveScroll: false, skipPersist: true});
        el('details-close').focus({preventScroll: true});
        persist();
        request();
      }
    , restore(saved) {
        const sel = saved?.selection;
        if (!sel || typeof sel.provider !== 'string' || !/^[a-z0-9.:_-]{1,64}$/i.test(sel.provider) || !['five', 'week', 'credit'].includes(sel.window) || ![sel.time, sel.start, sel.end].every(finite) || sel.start >= sel.end) {
          persist();
          return;
        }
        selection = {provider: sel.provider, window: sel.window, time: sel.time, start: sel.start, end: sel.end};
        clearAllConversations(false);
        report = null; preview = null; range = null; reasonDraft = ''; showAllProjects = false;
        reportView = reportViews.includes(saved.reportView) ? saved.reportView : 'all';
        heatmapMetric = heatmapMetrics.includes(saved.heatmapMetric) ? saved.heatmapMetric : 'cost';
        pools.clear(); endpointPool.clear(); projectNames.clear(); projectNameCounts.clear();
        for (const key of filterKeys) {
          const val = saved.filters?.[key];
          if (safeFilterValue(val)) filters[key] = val;
          else delete filters[key];
          const control = form.elements.namedItem(key);
          if (control) control.value = filters[key] || '';
        }
        syncFilterHighlights();
        if (Array.isArray(saved.conversations) && analysisFlag !== false) {
          for (const item of saved.conversations.slice(0, 12)) {
            if (!validConversationMeta(item?.sessionId, item?.homeKey)) continue;
            const key = conversationKeyOf(item.homeKey, item.sessionId);
            conversationStore.set(key, {
              key
            , sessionId: item.sessionId
            , homeKey: item.homeKey
            , projectLabel: typeof item.projectLabel === 'string' && item.projectLabel.length <= 100 && !/[\\/\x00-\x1f\x7f]/.test(item.projectLabel) ? item.projectLabel : null
            , lastObservedAt: finite(item.lastObservedAt) ? item.lastObservedAt : null
            , data: null
            , loading: false
            , error: null
            });
          }
        }
        if (typeof saved.activeConversationKey === 'string' && conversationStore.has(saved.activeConversationKey)) activeConversationKey = saved.activeConversationKey;
        else if (conversationStore.size) activeConversationKey = [...conversationStore.keys()].at(-1);
        updateConversationTabLabel();
        returnFocus = `${selection.provider}-${selection.window}`;
        syncHeader();
        el('details-context').textContent = `${date(selection.start)} – ${date(selection.end)}`;
        resetModalContainers();
        for (const key of tabKeys) {
          const savedScroll = saved.scrollTop?.[key];
          if (finite(savedScroll) && savedScroll >= 0) tabScrollTop[key] = Math.min(1000000, Math.round(savedScroll));
        }
        renderConversationPanel();
        if (!dialog.open) dialog.showModal();
        const nextTab = tabKeys.includes(saved.tab) ? saved.tab : 'report';
        activateTab(nextTab, {preserveScroll: true, skipPersist: true});
        el('details-close').focus({preventScroll: true});
        persist();
        request();
        if (activeConversationKey && analysisFlag !== false) loadConversation(null);
      }
    , close
    , isOpen
    };
  };
})();
