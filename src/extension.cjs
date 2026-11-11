'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {converter, validConversion, scopeKey, sourceKey} = require('./credit-conversion.cjs');
const {Store, project, sanitize} = require('./core.cjs');
const {preview} = require('./hover.cjs');
const forecasts = require('../media/forecast.js');
const billing = require('./billing.cjs');
const {PatternBook} = require('./pattern-book.cjs');
const forecastLearning = require('./forecast-learning.cjs');
const adapters = require('./adapters.cjs');
const antigravity = require('./antigravity.cjs');
const providerCatalog = require('../media/provider-focus.js');
const {intervalSeconds, wakeDelay, retime, adaptiveInterval, advanceOnWake} = require('./schedule.cjs');
const {Diagnostics} = require('./diagnostics.cjs');
const {ObservationQueue} = require('./observation-queue.cjs');
const {SessionIndex} = require('./session-index.cjs');
const {ConversationReader} = require('./conversations.cjs');
const {queryAnalysis} = require('./analysis-worker.cjs');
const {selection, createExclusion, validateExclusions} = require('./details-selection.cjs');
let stop;
async function activate(context) {
  const cfg = () => vscode.workspace.getConfiguration('usageAtlas');
// 적응형 수집의 유휴 간격까지 포함한 최대 예상 조회 간격(초). 연속성·기록 지연 판정의 기준이다.
const maxIntervalSeconds = () => {
  const base = intervalSeconds(cfg().get('intervalSeconds'));
  return cfg().get('adaptiveCollection', true) ? Math.min(3600, base * Math.max(1, Math.min(20, Number(cfg().get('idleIntervalMultiplier', 4)) || 4))) : base;
};
// 예측 설정은 forecast.js와 같은 규칙으로 정규화해 확장·학습·패턴 보관이 같은 값을 쓰게 한다.
const forecastConfig = (interval = maxIntervalSeconds()) => {
  const raw = {fiveMinutes: cfg().get('forecastFiveLookbackMinutes', 60), weekHours: cfg().get('forecastWeekLookbackHours', 72), patternDays: cfg().get('forecastPatternDays', 21), timeZone: cfg().get('forecastPatternTimeZone', 'Asia/Seoul'), intervalSeconds: interval};
  const normalized = forecasts.settings(raw);
  return {...raw, fiveMinutes: normalized.fiveMinutes, weekHours: normalized.weekHours, patternDays: normalized.patternDays, timeZone: normalized.timeZone};
};
const staleAfterMs = () => Math.max(900000, maxIntervalSeconds() * 3000);
  const store = new Store(context.globalStorageUri.fsPath, cfg().get('retentionDays'));
  const metadataFile = path.join(store.dir, 'metadata.json');
  const output = vscode.window.createOutputChannel('Usage Atlas');
  const controller = new AbortController();
  const diagnostics = new Diagnostics(store.dir, cfg().get('diagnosticsEnabled', true));
  const pending = new ObservationQueue(store.dir);
  const patternBook = new PatternBook(store.dir);
  let learnedForecast, learnedStamp, forecastInput, forecastRunning;
  const learnedFile = path.join(store.dir, 'forecast-learning.json');
  const sessionIndex = new SessionIndex({dir: store.dir, retentionDays: cfg().get('retentionDays')});
  let analysisData = {calls: [], activity: {}, coverage: {}, revision: 0}, maintenanceTimer, maintenanceRunning, detailSerial = 0, detailController;
  const conversationReader = new ConversationReader();
  let conversationController, conversationSerial = 0, conversationScope;
  const closeConversations = () => {conversationSerial++; conversationController?.abort(); conversationScope = null; return conversationReader.close();};
  let creditBasisQueue = Promise.resolve();
  let panel, timer, disposed = false, running = null, uiReady = false, intervalChanged = false, timerVersion = 0, revision = 0, sentRevision = -1, viewRefreshPending = false;
  let bodyCache, automatic, automaticStamp, conversionInput, usableConversion;
  const automaticFile = path.join(store.dir, 'automatic-conversion.json');
  const bodyHtml = () => bodyCache ||= fs.readFile(path.join(context.extensionPath, 'media', 'body.html'), 'utf8').catch(e => {bodyCache = null; throw e;});
  let records = await store.read().catch(() => []);
  let metadata = {capacities: [], goals: {}, collectors: {}, exclusions: []};
  let metaStamp, projectionCache;
  const loadMeta = async () => {try {const stat = await fs.stat(metadataFile), stamp = `${stat.ino}/${stat.mtimeMs}/${stat.ctimeMs}/${stat.size}`; if (stamp === metaStamp) return; const saved = JSON.parse(await fs.readFile(metadataFile, 'utf8')); delete saved.creditConversions; metadata = {...metadata, ...saved}; metaStamp = stamp;} catch {}};
  const saveMeta = async () => {const temp = metadataFile + `.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(metadata), {mode: 0o600}); await fs.rename(temp, metadataFile); metaStamp = null;};
  async function loadAutomatic() {
    try {
      const stat = await fs.stat(automaticFile), stamp = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join('/');
      if (stamp === automaticStamp) return;
      if (stat.size > 16 * 1024 * 1024) throw new Error('automatic conversion size');
      const value = JSON.parse(await fs.readFile(automaticFile, 'utf8'));
      automatic = validConversion(value, scopeKey(metadata.capacities, metadata.exclusions || [])) ? value : null; automaticStamp = stamp;
    } catch {automatic = null; automaticStamp = null;}
  }
  function inputKey() {
    const key = scopeKey(metadata.capacities, metadata.exclusions || []);
    if (!conversionInput || conversionInput.records !== records || conversionInput.key !== key) conversionInput = {records, key, value: sourceKey(records, metadata.capacities, metadata.exclusions || [])};
    return conversionInput.value;
  }
  function currentConversion() {
    const enabled = cfg().get('analysisEnabled', true), key = scopeKey(metadata.capacities, metadata.exclusions || []);
    if (usableConversion?.records === records && usableConversion.model === automatic && usableConversion.key === key && usableConversion.enabled === enabled) return usableConversion.value;
    let value = null;
    if (enabled && validConversion(automatic, key) && Number.isInteger(automatic.recordCount) && automatic.recordCount >= 0 && automatic.recordCount <= records.length) {
      const sameFile = typeof store.cachedStamp === 'string' && automatic.historyStamp === store.cachedStamp && automatic.recordCount === records.length;
      const prefix = sameFile ? automatic.inputKey : automatic.recordCount === records.length ? inputKey() : sourceKey(records.slice(0, automatic.recordCount), metadata.capacities, metadata.exclusions || []);
      if (prefix === automatic.inputKey) value = automatic;
    }
    usableConversion = {records, model: automatic, key, enabled, value}; return value;
  }
  async function loadLearnedForecast() {
    try {
      const stat = await fs.stat(learnedFile), stamp = [stat.ino, stat.size, stat.mtimeMs].join('/');
      if (stamp === learnedStamp || stat.size > 524288) return;
      const value = JSON.parse(await fs.readFile(learnedFile, 'utf8'));
      if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.key) || !Number.isFinite(value.observedAt) || value.observedAt > Date.now() + 300000 || !value.providers) return;
      for (const provider of Object.values(value.providers)) for (const model of Object.values(provider)) {
        if (!['seasonal', 'recent', 'historical', 'activity'].includes(model.method) || !Array.isArray(model.errors) || model.errors.length > 4 || model.errors.some(row => ![1,3,6,24].includes(row.hours) || ![row.low,row.high].every(Number.isFinite) || row.low > 0 || row.high < 0 || Math.abs(row.low)>100 || row.high>100)) return;
      }
      learnedForecast = value; learnedStamp = stamp;
    } catch {}
  }
  await loadMeta(); await loadAutomatic(); await patternBook.load(); await loadLearnedForecast();
  let antigravityAvailable = false;
  async function detectAntigravity() {
    antigravityAvailable = Boolean(vscode.extensions.getExtension('google.google-antigravity'));
    if (!antigravityAvailable && cfg().get('antigravityDataDir')) {try {antigravityAvailable = (await fs.stat(path.join(antigravity.dataDir(cfg().get('antigravityDataDir')), 'daemon'))).isDirectory();} catch {}}
  }
  await detectAntigravity();
  const collectorIds = () => ['codex', 'claude', ...(antigravityAvailable ? ['antigravity'] : [])];
  const collectorId = id => providerCatalog.isAntigravity(id) ? 'antigravity' : id;
  const latest = id => records.findLast(s => id === 'antigravity' ? providerCatalog.isAntigravity(s.provider) : s.provider === id);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  let hoverCache;
  function updateStatus() {
    const key = {records, metadata, projection: projected(), forecastEnabled: cfg().get('forecastEnabled', true), creditBasis: cfg().get('creditBasis', 'subscription'), colorMode: cfg().get('colorMode', 'system'), minute: Math.floor(Date.now() / 60000), theme: vscode.window.activeColorTheme.kind, interval: maxIntervalSeconds(), enabled: cfg().get('enabled'), trusted: vscode.workspace.isTrusted, codexCreditDecimals: cfg().get('codexCreditDecimals', 4), claudeUsdDecimals: cfg().get('claudeUsdDecimals', 4)};
    if (hoverCache && Object.keys(key).every(k => key[k] === hoverCache[k])) return;
    const message = !key.enabled ? '수집 중지' : !key.trusted ? '작업 영역 신뢰 필요' : null;
    const collectors = message ? Object.fromEntries(Object.keys(key.projection).map(id => [id, {message}])) : Object.fromEntries(Object.keys(key.projection).map(id => [id, metadata.collectors[collectorId(id)]]));
    const dark = key.colorMode === 'dark' || key.colorMode !== 'light' && [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(key.theme);
    const p = preview(records, {projection: key.projection, creditBasis: key.creditBasis, forecastEnabled: key.forecastEnabled, dark, capacities: metadata.capacities, collectors, codexCreditDecimals: key.codexCreditDecimals, claudeUsdDecimals: key.claudeUsdDecimals, maxGap: Math.max(1800000, key.interval * 3000), staleAfterMs: Math.max(900000, key.interval * 3000)});
    const md = new vscode.MarkdownString('', true);
    md.supportHtml = true;
    md.isTrusted = {enabledCommands: ['usageAtlas.settings']};
    const color = dark ? '#cbd5e1' : '#46546a';
    const title = `<svg xmlns="http://www.w3.org/2000/svg" width="332" height="24"><text x="0" y="22" fill="${color}" font-family="Segoe UI,sans-serif" font-size="13" font-weight="600">Usage Atlas · 최근 5시간</text></svg>`;
    md.appendMarkdown(`![Usage Atlas · 최근 5시간](data:image/svg+xml;base64,${Buffer.from(title).toString('base64')}) [$(gear)](command:usageAtlas.settings "Usage Atlas 설정")\n\n`);
    md.appendMarkdown(`![AI 서비스별 최근 5시간 사용률](data:image/svg+xml;base64,${Buffer.from(p.svg).toString('base64')})\n\n`);
    md.appendMarkdown('<table width="360"><thead><tr><th width="100" align="left"></th><th width="130" align="right">5시간</th><th width="130" align="right">주간</th></tr></thead><tbody>');
    // 수집 중지·오류·기록 지연처럼 정상이 아닌 상태는 이름 아래에 함께 표시해 이전 값이 최신처럼 보이지 않게 한다.
    const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const s of p.summaries) md.appendMarkdown(`<tr><td>${escapeHtml(s.name)}${s.status && s.status !== '정상' ? '<br/><small>' + escapeHtml(s.status) + '</small>' : ''}</td>${['five', 'week'].map(w => `<td align="right">${s[w] === '-' ? '-' : `${s[w]} (${s.resets[w]})${key.forecastEnabled ? '<br/>' + (s.forecasts?.[w]?.label || '예상') + ' ' + (s.forecasts?.[w]?.text || '-') : ''}`}</td>`).join('')}</tr>`);
    md.appendMarkdown('</tbody></table>\n\n');
    status.tooltip = md;
    status.accessibilityInformation = {label: `Usage Atlas. 최근 5시간 사용량. ${p.summaries.map(s => `${s.name}${s.status && s.status !== '정상' ? ' (' + s.status + ')' : ''} 5시간 ${s.five}, 주간 ${s.week}`).join('. ')}. 클릭하여 상세 차트 열기`};
    hoverCache = key;
  }
  async function executable() {
    const setting = cfg().get('codexPath'); if (setting) return setting;
    const ext = vscode.extensions.getExtension('openai.chatgpt');
    if (ext) {
      const dir = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'linux' ? `linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `macos-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
      const p = path.join(ext.extensionPath, 'bin', dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
      try {await fs.access(p); return p;} catch {}
    }
    return process.platform === 'win32' ? 'codex.exe' : 'codex';
  }
  function projected() {
    const interval = maxIntervalSeconds(), gap = Math.max(1800000, interval * 3000);
    const enabled = cfg().get('forecastEnabled', true);
    const forecastOptions = forecastConfig(interval);
    const forecastKey = JSON.stringify([enabled, forecasts.settings(forecastOptions)]);
    const billingKey = billing.catalog.version;
    patternBook.configure(metadata.capacities, cfg().get('retentionDays'), metadata.forecastPatternEpoch);
    if (!projectionCache || projectionCache.records !== records || projectionCache.capacities !== metadata.capacities || projectionCache.gap !== gap || projectionCache.conversion !== currentConversion() || projectionCache.forecastKey !== forecastKey || projectionCache.learned !== learnedForecast || projectionCache.bookRevision !== patternBook.revision || projectionCache.billingKey !== billingKey) {
      const providers = {}, convert = converter(currentConversion()), bill = billing.enricher();
      const data = project(records, metadata.capacities, gap, (...args) => {convert(...args); bill(...args);}, enabled ? (id, mine, windows, source) => {
        const since = forecasts.accountStart(source, id, mine.at(-1)?.account, mine.at(-1)?.time), archiveCells = {}, learning = {}, training = {};
        if (forecastOptions.patternDays > 0) patternBook.update(id, mine, windows, since);
        for (const window of ['five','week']) {
          const points = windows[window], last = points.at(-1);
          const scopeKey = crypto.createHash('sha256').update(JSON.stringify([forecastKey, patternBook.capacityKey, id, window, mine.at(-1)?.account, last?.plan, last?.mult, since])).digest('hex');
          archiveCells[window] = patternBook.older(id, mine.at(-1)?.account, window, last, mine[0]?.time, Math.max((last?.time || Date.now()) - forecastOptions.patternDays * 86400000, since ?? -Infinity));
          const model = learnedForecast?.providers?.[id]?.[window]; if (model?.scopeKey === scopeKey) learning[window] = model;
          if (forecastOptions.patternDays > 0) {const needsTraining = !forecastRunning && (!model || model.scopeKey !== scopeKey || (records.at(-1)?.time || 0) - (learnedForecast?.observedAt || 0) >= 3600000); training[window] = {...(needsTraining ? forecastLearning.pack(points) : {data: new Float64Array(0), plans: []}), archiveCells: archiveCells[window], scopeKey, sourceTime: mine.at(-1)?.time || 0, priorModel: !needsTraining && model?.scopeKey === scopeKey ? model : undefined};}
        }
        providers[id] = {windows: training, since};
        return forecasts.provider(windows, {...forecastOptions, since, archiveCells, learning});
      } : undefined);
      if (antigravityAvailable && !Object.keys(data).some(providerCatalog.isAntigravity)) data.antigravity = {windows: {five: [], week: []}, ledger: [], ledgerAvailable: false};
      const key = crypto.createHash('sha256').update(JSON.stringify([forecastKey, patternBook.capacityKey, Object.values(providers).map(p=>Object.values(p.windows).map(w=>w.scopeKey))])).digest('hex');
      forecastInput = enabled && forecastOptions.patternDays > 0 ? {key, observedAt: records.at(-1)?.time || 0, providers, config: forecastOptions} : null;
      projectionCache = {records, capacities: metadata.capacities, gap, forecastKey, learned: learnedForecast, bookRevision: patternBook.revision, billingKey, conversion: currentConversion(), data};
    }
    return projectionCache.data;
  }
  function payload() {
    const now = Date.now(), data = {}; let firstObserved = now;
    const projection = projected();
    for (const id of Object.keys(projection)) {
      const p = projection[id], last = p.last;
      if (p.first !== undefined) firstObserved = Math.min(firstObserved, p.first);
      data[id] = {...p, status: metadata.collectors[collectorId(id)]};

    }
    return {type: 'data', now, firstObserved, data, creditBasis: cfg().get('creditBasis', 'subscription'), forecastEnabled: cfg().get('forecastEnabled', true), colorMode: cfg().get('colorMode', 'system'), tooltipTransparency: cfg().get('tooltipTransparency', 14), pageWidth: cfg().get('pageWidth', 1440), pageHeight: cfg().get('pageHeight', 0), chartHistoryDays: cfg().get('chartHistoryDays', 7), codexCreditDecimals: cfg().get('codexCreditDecimals', 4), claudeUsdDecimals: cfg().get('claudeUsdDecimals', 4), intervalSeconds: cfg().get('intervalSeconds'), staleAfterMs: staleAfterMs(), diagnosticsEnabled: cfg().get('diagnosticsEnabled', true), analysisEnabled: cfg().get('analysisEnabled', true), detailsEnabled: true, host: vscode.env.remoteName || process.platform, storagePath: store.dir, theme: vscode.window.activeColorTheme.kind, count: records.length};
  }
  async function sendView() {
    if (!panel?.visible || !uiReady || sentRevision === revision && !viewRefreshPending) return;
    const current = panel, version = revision; viewRefreshPending = false; sentRevision = version;
    const delivered = await current.webview.postMessage({...payload(), revision: version});
    if (!delivered && panel === current && sentRevision === version) {sentRevision = -1; viewRefreshPending = true;}
  }
  async function publish() {revision++; updateStatus(); await sendView();}
  async function refreshStored() {
    const previousRecords = records, previousMetadata = metadata, previousAutomatic = automatic, previousLearned = learnedForecast, previousBook = patternBook.revision;
    const [, currentRecords] = await Promise.all([loadMeta(), store.read()]);
    await loadAutomatic(); await patternBook.load(); await loadLearnedForecast();
    if (records === previousRecords) records = currentRecords;
    if (records !== previousRecords || metadata !== previousMetadata || automatic !== previousAutomatic || learnedForecast !== previousLearned || patternBook.revision !== previousBook) {revision++; updateStatus();}
  }
  function effectiveInterval(id, now = Date.now()) {
    const base = intervalSeconds(cfg().get('intervalSeconds'));
    if (!cfg().get('adaptiveCollection', true)) return base;
    const activity = metadata.analysisActivity?.[id] || analysisData.activity?.[id], known = cfg().get('analysisEnabled', true) && activity && activity.complete !== false && Number.isFinite(activity.lastActivity);
    const factor = Math.max(1, Math.min(20, Number(cfg().get('idleIntervalMultiplier', 4)) || 4));
    return Math.max(5, Math.min(3600, adaptiveInterval(base, known ? {...activity, idleAfterMs: Math.max(60000, base * 2000)} : {active: true}, now, factor)));
  }
  function nextRead(id, last, snapshot) {
    const interval = effectiveInterval(id, last); let next = last + interval * 1000;
    const values = id === 'antigravity' && snapshot?.provider ? records.filter(row => providerCatalog.isAntigravity(row.provider) && row.account === snapshot.account && row.time === snapshot.time).flatMap(row => Object.values(row.windows)) : Object.values(snapshot?.windows || {});
    if (cfg().get('adaptiveCollection', true)) for (const value of values) if (value?.reset > last) next = Math.min(next, Math.max(last + 5000, value.reset + 1000));
    return {next, effectiveIntervalSeconds: interval};
  }
  async function loadAnalysis() {
    const value = await sessionIndex.load();
    const snapshot = value?.calls ? value : sessionIndex.snapshot?.();
    if (snapshot?.calls) analysisData = snapshot;
    return analysisData;
  }
  async function maintainAnalysis(force = false) {
    if (maintenanceRunning || disposed || !vscode.workspace.isTrusted || !cfg().get('enabled') || !cfg().get('analysisEnabled', true)) return;
    maintenanceRunning = (async () => {
      const result = await store.withLock(async () => {
        await loadMeta();
        const owner = metadata.analysisOwnerPid;
        if (!force && Number.isInteger(owner) && owner > 0 && owner !== process.pid && Date.now() - (metadata.analysisScanAt || 0) < 45000) {
          let alive = true;
          try {process.kill(owner, 0);} catch (error) {alive = error.code !== 'ESRCH';}
          if (alive) return false;
        }
        if (!force && Date.now() - (metadata.analysisScanAt || 0) < 14000) return false;
        await loadAnalysis();
        store.retentionDays = cfg().get('retentionDays'); sessionIndex.retentionDays = store.retentionDays;
        records = await store.read();
        const previous = analysisData.activity || {};
        analysisData = await diagnostics.measure('shared', 'session-index', () => sessionIndex.scan({codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), claudeDir: cfg().get('claudeConfigDir') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), accounts: Object.fromEntries(['codex', 'claude'].map(id => [id, latest(id)?.account])), signal: controller.signal}));
        const sameScope = validConversion(automatic, scopeKey(metadata.capacities, metadata.exclusions || []));
        const due = !sameScope || !currentConversion() || Date.now() - automatic.measuredAt >= 60000;
        if (due && (automatic?.inputKey !== inputKey() || automatic?.revision !== analysisData.revision || !sameScope)) {
          const value = await diagnostics.measure('shared', 'conversion', () => queryAnalysis({operation: 'conversion', records, calls: analysisData.calls, capacities: metadata.capacities, exclusions: metadata.exclusions || [], revision: analysisData.revision, now: Date.now()}, {signal: controller.signal}));
          value.historyStamp = typeof store.cachedStamp === 'string' ? store.cachedStamp : null;
          const temporary = automaticFile + '.' + process.pid + '.tmp';
          const text = JSON.stringify(value);
          if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('automatic conversion size');
          try {await fs.writeFile(temporary, text, {mode: 0o600}); await fs.rename(temporary, automaticFile);}
          finally {await fs.unlink(temporary).catch(() => {});}
          automatic = value; automaticStamp = null; projectionCache = null; await publish();
        }
        let changed = false;
        for (const id of ['codex', 'claude']) {
          const activity = analysisData.activity?.[id], collector = metadata.collectors[id];
          if (!cfg().get('adaptiveCollection', true) || !activity || !collector?.last || collector.errors || activity.signature === previous[id]?.signature || Date.now() - activity.lastActivity > 120000) continue;
          changed = advanceOnWake({[id]: collector}) || changed;
        }
        metadata.analysisScanAt = Date.now();
        metadata.analysisOwnerPid = process.pid;
        metadata.analysisActivity = Object.fromEntries(['codex', 'claude'].map(id => [id, {active: analysisData.activity?.[id]?.active === true, lastActivity: Number.isFinite(analysisData.activity?.[id]?.lastActivity) ? analysisData.activity[id].lastActivity : null, complete: analysisData.coverage?.[id]?.partial !== true && analysisData.coverage?.[id]?.cacheWriteFailed !== true}]));
        await saveMeta();
        if (cfg().get('forecastEnabled', true) && forecastConfig().patternDays > 0) {projected(); await patternBook.save().catch(() => {});}
        await diagnostics.save().catch(() => {});
        return changed;
      });
      if (result) schedule(0);
    })().catch(error => {if (!disposed) output.appendLine(`로컬 분석: ${error.code || error.name || '처리 오류'}`);}).finally(() => {maintenanceRunning = null;});
    return maintenanceRunning;
  }
  async function maintainForecast() {
    if (forecastRunning) return forecastRunning;
    if (disposed || !vscode.workspace.isTrusted || !cfg().get('enabled') || !cfg().get('forecastEnabled', true) || !forecastConfig().patternDays) return;
    forecastRunning = (async () => {
      await refreshStored(); projected(); const input = forecastInput;
      if (!input || !Object.values(input.providers).some(provider => Object.values(provider.windows).some(window => window.data.byteLength > 0))) return;
      if (learnedForecast?.key === input.key && input.observedAt - learnedForecast.observedAt < 3600000) return;
      const claimed = await store.withLock(async () => {
        await loadMeta();
        if (metadata.forecastFitKey === input.key && Date.now() - (metadata.forecastFitAt || 0) < 300000) return false;
        metadata.forecastFitKey = input.key; metadata.forecastFitAt = Date.now(); await saveMeta(); return true;
      });
      if (!claimed) return;
      try {
        const model = await forecastLearning.fitWorker(input, {signal: controller.signal});
        await refreshStored(); projected();
        if (disposed || input.key !== forecastInput?.key) return;
        const temp = learnedFile + '.' + process.pid + '.tmp'; await fs.writeFile(temp, JSON.stringify(model), {mode: 0o600});
        if (disposed || input.key !== forecastInput?.key) {await fs.unlink(temp).catch(() => {}); return;}
        await fs.rename(temp, learnedFile);
        learnedForecast = model; learnedStamp = null;
        await store.withLock(() => patternBook.save());
        projectionCache = null; await publish();
      } catch (error) {if (!disposed) output.appendLine('예측 검증: ' + (error.code || '재시도 대기'));}
    })().finally(() => {forecastRunning = null; projectionCache = null;});
    return forecastRunning;
  }
  async function detailReport(message, extra = {}, signal = controller.signal) {
    await refreshStored(); if (cfg().get('analysisEnabled', true)) await loadAnalysis(); await diagnostics.load();
    store.retentionDays = cfg().get('retentionDays');
    const scope = selection(message, records, store.retentionDays);
    const report = await diagnostics.measure(scope.provider, 'details', async () => queryAnalysis({...scope, ...scope.filters, calls: cfg().get('analysisEnabled', true) ? analysisData.calls : [], records, capacities: metadata.capacities, coverage: analysisData.coverage?.[scope.provider] || {}, conversionModel: currentConversion(), exclusions: metadata.exclusions || [], diagnostics: diagnostics.snapshot(collectorId(scope.provider)), now: Date.now(), ...extra}, {signal}));
    report.selection = {...scope, time: scope.cursorTime}; report.storage = pending.status();
    report.collection = {...metadata.collectors[collectorId(scope.provider)], baseIntervalSeconds: intervalSeconds(cfg().get('intervalSeconds')), adaptive: cfg().get('adaptiveCollection', true), connection: scope.provider === 'codex' ? cfg().get('codexConnectionMode', 'onDemand') : providerCatalog.isAntigravity(scope.provider) ? 'local-rpc' : 'https-keep-alive'};
    if (diagnostics.enabled) {
      const reference = require('./collection-cost.json').records.find(row => row.platform === process.platform);
      report.diagnostics = {...report.diagnostics, adapter: adapters.getDiagnostics?.(scope.provider) || null, reference: reference ? {measuredAt: reference.measuredAt, provider: scope.provider, values: reference[scope.provider], limitations: reference.limits} : null};
    }
    report.analysisEnabled = cfg().get('analysisEnabled', true);
    report.attribution = {project: 'Codexon', author: 'jisoq', copyright: 'Copyright (c) 2026 jisoq', url: 'https://github.com/jisoq/Codexon', license: 'Codexon Attribution License 1.0'};
    return report;
  }
  async function conversationReport(message, signal) {
    if (!cfg().get('analysisEnabled', true)) throw new Error('세션 분석이 꺼져 있습니다.');
    await refreshStored(); await loadAnalysis();
    const scope = selection(message, records, cfg().get('retentionDays'));
    const sessionId = message.conversationSessionId, homeKey = message.conversationHomeKey;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || !/^[a-f0-9]{64}$/.test(homeKey || '')) throw new Error('대화 세션이 올바르지 않습니다.');
    const report = await detailReport({...message, filters: {...message.filters, sessionId}}, {}, signal);
    if (!report.calls.items.some(row => row.sessionId === sessionId && row.homeKey === homeKey)) throw new Error('선택한 사용량 범위에 해당 세션이 없습니다.');
    const key = JSON.stringify([scope.provider, scope.account, homeKey, sessionId, message.start, message.end, scope.filters, cfg().get('retentionDays')]);
    if (message.cursor != null) {
      if (conversationScope !== key || typeof message.cursor !== 'string') throw new Error('대화를 다시 선택하세요.');
      conversationReader.signal = signal;
      return {...await conversationReader.page(message.cursor), sessionId};
    }
    const hints = await sessionIndex.conversationSources({provider: scope.provider, account: scope.account, homeKey, sessionId});
    const home = scope.provider === 'codex' ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : cfg().get('claudeConfigDir') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const roots = (scope.provider === 'codex' ? ['sessions', 'archived_sessions'] : ['projects']).map(name => path.join(home, name));
    const result = await conversationReader.open({hints, roots, start: scope.start, end: scope.end, earliest: Date.now() - (cfg().get('retentionDays') || 90) * 86400000, signal});
    conversationScope = key;
    return {...result, sessionId};
  }
  async function handleConversation(message, current) {
    const serial = ++conversationSerial;
    conversationController?.abort(); conversationController = new AbortController();
    try {
      const data = await conversationReport(message, conversationController.signal);
      if (!disposed && panel === current && serial === conversationSerial) await current.webview.postMessage({type: 'conversation', requestId: message.requestId, data});
    } catch {
      if (!disposed && panel === current && serial === conversationSerial) await current.webview.postMessage({type: 'conversationError', requestId: message.requestId, error: '로컬 대화를 불러오지 못했습니다. 세션·수집 범위 또는 파일 변경 여부를 확인하고 다시 선택하세요.'});
    }
  }
  async function handleDetails(message, current) {
    await closeConversations();
    const serial = ++detailSerial;
    detailController?.abort(); detailController = new AbortController();
    const signal = detailController.signal;
    try {
      await refreshStored();
      let preview;
      if (message.type === 'analysisPreviewExclude' || message.type === 'analysisExclude') preview = createExclusion(message, records, metadata.capacities);
      if (message.type === 'analysisExclude') {
        const changed = await changeMeta(async () => {records = await store.read(); const value = createExclusion(message, records, metadata.capacities); metadata.exclusions ||= []; if (metadata.exclusions.length >= 4096) throw new Error('분석 제외 기록 제한에 도달했습니다.'); metadata.exclusions.push(value);});
        if (!changed) throw new Error('수집 중입니다. 잠시 후 다시 시도하세요.');
      } else if (message.type === 'analysisRestore') {
        const changed = await changeMeta(async () => {
          records = await store.read();
          const scope = selection(message, records, store.retentionDays);
          const value = (metadata.exclusions || []).find(e => e.id === message.exclusionId && e.provider === scope.provider && e.account === scope.account && e.window === scope.window);
          if (!value) throw new Error('복원할 분석 제외 기록을 확인할 수 없습니다.');
          value.restoredAt ||= Date.now();
        });
        if (!changed) throw new Error('수집 중입니다. 잠시 후 다시 시도하세요.');
      }
      const report = await detailReport(message, {}, signal);
      if (message.type === 'analysisPreviewExclude') {
        const after = await detailReport(message, {exclusions: [...(metadata.exclusions || []), preview]}, signal);
        report.exclusionPreview = {start: preview.start, end: preview.end, reason: preview.reason, before: report.summary, after: after.summary, estimateBefore: report.estimate, estimateAfter: after.estimate};
      }
      if (!disposed && panel === current && serial === detailSerial) await current.webview.postMessage({type: 'details', requestId: message.requestId, data: report});
    } catch (error) {
      if (!disposed && panel === current && serial === detailSerial) await current.webview.postMessage({type: 'detailsError', requestId: message.requestId, error: error.message});
    }
  }
  async function collect() {
    store.retentionDays = cfg().get('retentionDays');
    if (disposed || !cfg().get('enabled') || !vscode.workspace.isTrusted) return;
    if (running) return running;
    running = (async () => {
      await loadMeta();
      if (!intervalChanged && collectorIds().every(id => (metadata.collectors[id]?.next || 0) > Date.now())) return;
      return store.withLock(async () => {
        await loadMeta();
        if (!await pending.ready(store)) {for (const id of collectorIds()) metadata.collectors[id] = {...metadata.collectors[id], message: pending.status().issue, next: Math.max(metadata.collectors[id]?.next || 0, Date.now() + 60000)}; await saveMeta(); return;}
        records = await store.read();
        const additions = [];
        let changed = intervalChanged && retime(metadata.collectors, cfg().get('intervalSeconds'));
        if (intervalChanged) for (const id of collectorIds()) {
          const previous = metadata.collectors[id];
          if (!previous?.last || previous.errors || previous.message !== '정상') continue;
          const timing = nextRead(id, previous.last, latest(id));
          if (previous.next !== timing.next) changed = true;
          Object.assign(previous, timing);
        }
        intervalChanged = false;
        await Promise.all(collectorIds().map(async id => {
          const old = metadata.collectors[id] || {};
          if ((old.next || 0) > Date.now()) return;
          changed = true;
          if (id === 'antigravity' && !cfg().get('antigravityEnabled', true)) {metadata.collectors[id] = {message: '수집 중지', next: Date.now() + 60000}; return;}
          if (id === 'claude' && !cfg().get('claudeCompatibilityApi')) {metadata.collectors[id] = {message: 'Claude 호환 조회 비활성', next: Date.now() + 300000}; return;}
          try {
            const options = {persistent: cfg().get('codexConnectionMode', 'onDemand') === 'persistent', cacheSeconds: cfg().get('adaptiveCollection', true) ? 5 : 0, idleTtlMs: Math.min(300000, effectiveInterval(id) * 1000 + 10000), metricsEnabled: cfg().get('diagnosticsEnabled', true)};
            const values = await diagnostics.measure(id, 'query', async () => {
              if (id === 'codex') return [await adapters.codex(await executable(), controller.signal, options)];
              if (id === 'claude') return [await adapters.claude(cfg().get('claudeConfigDir'), controller.signal, options)];
              const ext = vscode.extensions.getExtension('google.google-antigravity');
              return antigravity.collect(cfg().get('antigravityDataDir'), controller.signal, {...options, ...(ext?.isActive && ext.exports?.port ? {connection: () => ext.exports} : {})});
            });
            for (const s of values) if (latest(s.provider)?.time !== s.time || latest(s.provider)?.account !== s.account) additions.push(s);
            const s = {windows: Object.fromEntries(values.flatMap((value, i) => Object.entries(value.windows).map(([key, window]) => [i + key, window])))};
            const last = Date.now();
            metadata.collectors[id] = {last, ...nextRead(id, last, s), errors: 0, message: '정상'};
          } catch (e) {
            const errors = Math.min(6, (old.errors || 0) + 1);
            metadata.collectors[id] = {...old, errors, next: Date.now() + Math.max(e.retryAfter || 0, Math.min(3600000, 300000 * 2 ** (errors - 1))), message: e.message};
            output.appendLine(`${id}: ${e.message}`);
          }
        }));
        if (additions.length) records = await diagnostics.measure('shared', 'storage', () => pending.accept(additions, store));
        else records = await store.read();
        if (changed) await saveMeta();
        await diagnostics.save().catch(() => {});
      });
    })().catch(e => {
      if (pending.status().issue) for (const id of collectorIds()) metadata.collectors[id] = {...metadata.collectors[id], message: pending.status().issue, next: Math.max(metadata.collectors[id]?.next || 0, Date.now() + 60000)};
      output.appendLine(`저장 오류: ${e.message}`);
    }).finally(async () => {try {await loadMeta(); records = await store.read().catch(() => records); await publish();} finally {running = null;}});
    return running;
  }
  async function open() {
    const [body] = await Promise.all([bodyHtml(), refreshStored()]);
    if (disposed) return;
    if (panel) {viewRefreshPending = true; panel.reveal(); await sendView(); return;}
    panel = vscode.window.createWebviewPanel('usageAtlas', 'Usage Atlas', vscode.ViewColumn.Active, {enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]});
    const current = panel;
    uiReady = false; sentRevision = -1; viewRefreshPending = false;
    current.onDidDispose(() => {if (panel === current) {panel = undefined; uiReady = false; detailSerial++; detailController?.abort(); closeConversations();}});
    current.onDidChangeViewState(() => {if (panel !== current) return; if (!current.visible) {uiReady = false; viewRefreshPending = true; detailSerial++; detailController?.abort(); closeConversations();} else sendView().catch(e => output.appendLine(e.message));});
    current.webview.onDidReceiveMessage(async m => {
      if (panel !== current || !m || typeof m !== 'object') return;
      if (m.type === 'ready' && !uiReady) {uiReady = true; sentRevision = Number.isSafeInteger(m.revision) ? m.revision : -1; await sendView();}
      if (m.type === 'creditBasis' && ['subscription', 'billing'].includes(m.value)) {
        creditBasisQueue = creditBasisQueue.catch(() => {}).then(async () => {
          const config = cfg(), inspected = config.inspect?.('creditBasis');
          const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
          await config.update('creditBasis', m.value, target);
        });
        try {await creditBasisQueue;} catch {await current.webview.postMessage({type: 'creditBasisRejected', value: cfg().get('creditBasis', 'subscription')}); vscode.window.showErrorMessage('크레딧 표시 기준을 저장하지 못했습니다. VS Code 설정을 확인해주세요.');}
        return;
      }
      if (m.type === 'command' && m.command === 'settings') await vscode.commands.executeCommand('usageAtlas.settings');
      if (['details', 'analysisPreviewExclude', 'analysisExclude', 'analysisRestore'].includes(m.type)) await handleDetails(m, current);
      if (m.type === 'conversation') await handleConversation(m, current);
      if (m.type === 'conversationClosed') await closeConversations();
      if (m.type === 'detailsClosed') {detailSerial++; detailController?.abort(); await closeConversations();}
    });
    const nonce = crypto.randomBytes(18).toString('base64');
    const resource = file => current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', file)).toString();
    const initial = JSON.stringify({...payload(), revision}).replace(/</g, '\\u003c');
    current.webview.html = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${current.webview.cspSource}; style-src ${current.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none';"><link rel="stylesheet" href="${resource('style.css')}"><script defer nonce="${nonce}" src="${resource('d3.min.js')}"></script><script defer nonce="${nonce}" src="${resource('gaps.js')}"></script><script defer nonce="${nonce}" src="${resource('time-axis.js')}"></script><script defer nonce="${nonce}" src="${resource('amount-format.js')}"></script><script defer nonce="${nonce}" src="${resource('credit-series.js')}"></script><script defer nonce="${nonce}" src="${resource('chart-series.js')}"></script><script defer nonce="${nonce}" src="${resource('forecast.js')}"></script><script defer nonce="${nonce}" src="${resource('details.js')}"></script><script defer nonce="${nonce}" src="${resource('provider-focus.js')}"></script><script defer nonce="${nonce}" src="${resource('app.js')}"></script></head><body>${body}<script type="application/json" id="ua-initial-data" nonce="${nonce}">${initial}</script></body></html>`;
  }
  async function changeMeta(fn) {const r = await store.withLock(async () => {await loadMeta(); await fn(); projectionCache = null; await saveMeta(); return true;}); if (!r) vscode.window.showInformationMessage('수집 중입니다. 잠시 후 다시 시도하세요.'); await publish(); return Boolean(r);}
  async function selectWindow() {
    const p = await vscode.window.showQuickPick(providerCatalog.ids(records).map(id => ({label: providerCatalog.name(id, latest(id)?.label), id})), {title: '제공자'}); if (!p) return;
    if (!latest(p.id)) {vscode.window.showInformationMessage('먼저 실제 사용량을 수집해야 합니다.'); return;}
    const w = await vscode.window.showQuickPick([{label: '5시간', id: 'five'}, {label: '주간', id: 'week'}], {title: '사용량 창'}); return w ? {provider: p.id, window: w.id} : null;
  }
  const commands = {
    open
    , settings: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id)
    , about: async () => {
      const choice = await vscode.window.showInformationMessage('Usage Atlas ' + context.extension.packageJSON.version + '\nCodexon · jisoq · Copyright (c) 2026 jisoq\nCodexon Attribution License 1.0\nhttps://github.com/jisoq/Codexon', {modal: true, detail: '기존 Usage Atlas 소스는 MIT License를 유지합니다. Codexon에서 유래한 수집·분석 부분에는 동봉한 별도 라이선스가 적용됩니다. Usage Atlas 변경은 원저자의 보증·승인을 의미하지 않습니다.'}, '원본 저장소', '라이선스');
      if (choice === '원본 저장소') await vscode.env.openExternal(vscode.Uri.parse('https://github.com/jisoq/Codexon'));
      if (choice === '라이선스') await vscode.window.showTextDocument(vscode.Uri.joinPath(context.extensionUri, 'licenses', 'Codexon-LICENSE.txt'), {preview: true});
    }    , refresh: async () => {await collect(); if (panel) await publish(); else output.show(true);}
    , status: async () => {await loadMeta(); output.clear(); output.appendLine(`환경: ${vscode.env.remoteName || process.platform}\n저장소: ${store.dir}\n기록: ${records.length}`); for (const id of providerCatalog.ids(records)) {const s = latest(id); output.appendLine(`${id}: ${metadata.collectors[collectorId(id)]?.message || '대기'} · 최근 ${s ? new Date(s.time).toLocaleString() : '없음'} · ${s?.plan || '미확인'}\n  5시간 ${s?.windows.five?.used ?? '미제공'} / 주간 ${s?.windows.week?.used ?? '미제공'}`);} output.appendLine('Claude: 비공개 호환 API. 금액 단위가 확인된 지출만 표시. 금액 기준은 확인된 월 구독료·크레딧 구매 단가가 있을 때만 계산합니다.'); output.show(true);}
    , capacity: async () => {const choice = await selectWindow(); if (!choice) return; const s = latest(choice.provider); const input = await vscode.window.showInputBox({title: '현재 요금제의 기본 용량 대비 배율', prompt: `${s.plan} · 같은 계정·요금제·창의 과거 기록에도 적용. 공식 용량 또는 확인한 값 입력`, placeHolder: '1 / 5 / 20', validateInput: v => Number(v) > 0 && Number(v) <= 100 ? null : '0 초과 100 이하'}); if (input === undefined) return; await changeMeta(() => {if (latest(choice.provider)?.account !== s.account || latest(choice.provider)?.plan !== s.plan) throw new Error('계정 또는 요금제가 바뀌었습니다. 다시 설정하세요.'); metadata.capacities = metadata.capacities.filter(c => !(c.provider === choice.provider && c.account === s.account && c.plan === s.plan && c.window === choice.window)); metadata.capacities.push({...choice, account: s.account, plan: s.plan, time: Date.now(), mult: Number(input)});});}
    , export: async () => {const uri = await vscode.window.showSaveDialog({defaultUri: vscode.Uri.file(path.join(os.homedir(), 'usage-atlas.json')), filters: {JSON: ['json']}}); if (!uri) return; await loadMeta(); await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({version: 1, records: await store.read(), capacities: metadata.capacities, exclusions: metadata.exclusions || [], goals: metadata.goals}, null, 2)));}
    , import: async () => {
      const uris = await vscode.window.showOpenDialog({canSelectMany: false, filters: {JSON: ['json']}}); if (!uris) return;
      try {
        const stat = await vscode.workspace.fs.stat(uris[0]); if (stat.size > 32 * 1024 * 1024) throw new Error('32MB 이하 파일만 지원');
        const doc = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString());
        if (doc.version !== 1 || !Array.isArray(doc.records) || doc.records.length > 120000) throw new Error('지원하지 않는 기록');
        const values = doc.records.map(sanitize);
        const caps = (Array.isArray(doc.capacities) ? doc.capacities : []).map(c => {
          if (!providerCatalog.valid(c.provider) || !['five', 'week'].includes(c.window) || !/^[a-f0-9]{20}$/.test(c.account) || typeof c.plan !== 'string' || c.plan.length > 100 || !Number.isFinite(c.time) || !Number.isFinite(c.mult) || c.mult <= 0 || c.mult > 100) throw new Error('잘못된 용량 배율 기록');
          return {provider: c.provider, account: c.account, window: c.window, plan: c.plan, time: c.time, mult: c.mult};
        });
        const exclusions = validateExclusions(doc.exclusions || []);
        const result = await store.withLock(async () => {
          await loadMeta();
          const exclusionKeys = new Map((metadata.exclusions || []).map(e => [e.id, {...e}]));
          for (const value of exclusions) {
            const previous = exclusionKeys.get(value.id);
            if (!previous) exclusionKeys.set(value.id, value);
            else if (['provider', 'account', 'window', 'start', 'end', 'reason', 'createdAt'].some(key => previous[key] !== value[key])) throw new Error('분석 제외 기록 ID가 충돌합니다.');
            else if (value.restoredAt && (!previous.restoredAt || value.restoredAt > previous.restoredAt)) previous.restoredAt = value.restoredAt;
          }
          if (exclusionKeys.size > 4096) throw new Error('분석 제외 기록 제한에 도달했습니다.');
          records = await store.commit(values);
          const keys = new Set(metadata.capacities.map(c => JSON.stringify(c)));
          for (const c of caps) if (!keys.has(JSON.stringify(c))) {metadata.capacities.push(c); keys.add(JSON.stringify(c));}
          metadata.exclusions = [...exclusionKeys.values()];
          metadata.forecastPatternEpoch = crypto.randomUUID(); patternBook.clear();
          projectionCache = null;
          await saveMeta(); return true;
        });
        if (!result) throw new Error('수집 중입니다. 잠시 후 다시 시도하세요.');
        await publish(); vscode.window.showInformationMessage(`${values.length}개 기록 확인 및 병합 완료`);
      } catch (e) {vscode.window.showErrorMessage(`가져오기 실패: ${e.message}`);}
    }
  };
  for (const [name, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`usageAtlas.${name}`, fn));
  context.subscriptions.push(vscode.window.registerUriHandler({handleUri: uri => uri.path === '/open' ? open() : undefined}));
  status.name = 'Usage Atlas'; status.text = '$(graph-line) Usage'; status.command = 'usageAtlas.open'; updateStatus(); status.show();
  context.subscriptions.push(status, output, vscode.window.onDidChangeActiveColorTheme(() => publish()), vscode.workspace.onDidChangeConfiguration(async e => {if (e.affectsConfiguration('usageAtlas')) {if (['antigravityDataDir', 'antigravityEnabled'].some(key => e.affectsConfiguration('usageAtlas.' + key))) {await detectAntigravity(); antigravity.dispose(); projectionCache = null; const old = metadata.collectors.antigravity; if (old && !old.errors) old.next = Date.now();}if (['intervalSeconds', 'adaptiveCollection', 'idleIntervalMultiplier', 'analysisEnabled'].some(key => e.affectsConfiguration(`usageAtlas.${key}`))) intervalChanged = true; diagnostics.setEnabled(cfg().get('diagnosticsEnabled', true)); if (e.affectsConfiguration('usageAtlas.codexConnectionMode')) adapters.dispose(); schedule(0); publish();}}));
  // 한 창만 수집, 다른 창은 동일 저장소의 결과를 읽는다. UI는 숨기면 해제된다.
  const tick = async version => {try {await collect();} finally {if (!disposed && version === timerVersion) {updateStatus(); schedule(wakeDelay(metadata.collectors, Date.now(), cfg().get('enabled') && vscode.workspace.isTrusted, collectorIds()));}}};
  function schedule(delay) {clearTimeout(timer); const version = ++timerVersion; timer = setTimeout(() => tick(version).catch(e => {if (!disposed) output.appendLine(e.message);}), delay);}
  schedule(Math.min(5000, intervalSeconds(cfg().get('intervalSeconds')) * 1000));
  const maintenanceTick = async () => {try {await maintainAnalysis(); await maintainForecast();} finally {if (!disposed) maintenanceTimer = setTimeout(maintenanceTick, 15000);}};
  maintenanceTimer = setTimeout(maintenanceTick, 7000);
  stop = () => {disposed = true; clearTimeout(timer); clearTimeout(maintenanceTimer); detailSerial++; detailController?.abort(); closeConversations(); controller.abort(); adapters.dispose(); antigravity.dispose(); sessionIndex.dispose?.(); projectionCache = null; panel?.dispose();};
  context.subscriptions.push({dispose: stop});
  return {snapshot: () => payload(), refresh: collect, storagePath: store.dir, isUiReady: () => uiReady, forecastLearningStatus: () => ({model: learnedForecast, patternCells: [...patternBook.scopes.values()].reduce((sum,g)=>sum+g.cells.size,0)}), maintainForecast, details: detailReport, conversation: conversationReport, closeConversations, conversationStatus: () => ({sources: conversationReader.states.length}), maintainAnalysis, analysisSnapshot: () => analysisData, pendingStatus: () => pending.status()};
}
function deactivate() {stop?.();}
module.exports = {activate, deactivate};
