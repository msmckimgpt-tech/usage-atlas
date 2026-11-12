const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const core = require('../src/core.cjs');
const root = path.resolve(__dirname, '..');
async function harness(t, options = {}) {
  const optionsHarness = options;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-opening-'));
  const now = Date.now(), plan = '</script><script>throw "unsafe"</script>';
  let records = options.records || ['codex', 'claude'].map(provider => ({v: 1, provider, account: core.hash(provider), plan, time: now, windows: {five: null, week: {used: 30, reset: now + 604800000}}}));
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({capacities: [], creditConversions: [], goals: {}, collectors: {}, ...options.metadata}));
  if (options.automatic) await fs.writeFile(path.join(dir, 'automatic-conversion.json'), JSON.stringify(options.automatic));
  const commands = new Map(), panels = [], calls = [], changes = [], previewOptions = [], markdowns = [];
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const adapters = Object.fromEntries(['codex', 'claude'].map(provider => [provider, async () => {calls.push(provider); await gate; return {...records.find(r => r.provider === provider), time: now + 1, windows: {five: null, week: {used: 31, reset: now + 604800000}}};}]));
  adapters.dispose = () => {};
  const settings = {enabled: true, retentionDays: 90, intervalSeconds: 300, claudeCompatibilityApi: true, ...options.settings};
  const cfg = {get: (key, fallback) => settings[key] ?? fallback, update: async (key, value) => {settings[key] = value; await Promise.all(changes.map(change => change({affectsConfiguration: section => section === 'usageAtlas' || section === 'usageAtlas.' + key})));}};
  const disposable = () => ({dispose() {}});
  const vscode = {
    ConfigurationTarget: {Global: 1, Workspace: 2, WorkspaceFolder: 3},
    workspace: {getConfiguration: () => cfg, isTrusted: true, onDidChangeConfiguration: fn => {changes.push(fn); return disposable();}}
    , env: {}, extensions: {getExtension: id => id === 'google.google-antigravity' && options.antigravity ? {isActive: true, exports: {port: 12345, csrfToken: 'fixture-token-1234567890'}} : null}, StatusBarAlignment: {Right: 1}, ViewColumn: {Active: 1}, ColorThemeKind: {Dark: 2, HighContrast: 3}
    , Uri: {joinPath: (uri, ...parts) => ({toString: () => path.join(uri.fsPath, ...parts)})}
    , MarkdownString: class {constructor() {this.value = ""; markdowns.push(this);} appendMarkdown(value) {this.value += value; return this;}}
    , commands: {registerCommand: (name, fn) => {commands.set(name, fn); return disposable();}, executeCommand: async () => {}}
    , window: {
      activeColorTheme: {kind: 2}, createOutputChannel: () => ({appendLine() {}, dispose() {}}), createStatusBarItem: () => ({show() {}, dispose() {}})
      , registerUriHandler: disposable, onDidChangeActiveColorTheme: disposable
      , createWebviewPanel: () => {
        const panel = {visible: true, messages: [], reveal() {this.visible = true; this.view();}, dispose() {this.disposed();}, onDidDispose(fn) {this.disposed = fn;}, onDidChangeViewState(fn) {this.view = fn;}};
        panel.webview = {cspSource: 'test-resource:', asWebviewUri: uri => uri, onDidReceiveMessage(fn) {panel.receive = fn;}, postMessage: async m => {panel.messages.push(m); return true;}};
        panels.push(panel); return panel;
      }
    }
  };
  class Store {constructor() {this.dir = dir;} async read() {return records;} async withLock(fn) {return fn();} async commit(additions) {records = [...records, ...additions].sort((a, b) => a.time - b.time); return records;}}
  const localRequire = createRequire(path.join(root, 'src', 'extension.cjs'));
  const requireMock = name => name === 'vscode' ? vscode : name === './core.cjs' ? {...core, Store} : name === './adapters.cjs' ? adapters : name === './antigravity.cjs' && options.antigravity ? {dataDir: value => value, dispose() {}, collect: async (...args) => {calls.push('antigravity'); return options.antigravity(...args);}} : name === './hover.cjs' ? {preview: (records, options) => {previewOptions.push(options); return optionsHarness.realPreview ? localRequire('./hover.cjs').preview(records, options) : {svg: '<svg/>', summaries: []};}} : localRequire(name);
  const mod = {exports: {}};
  vm.runInNewContext(`(function(require,module,exports){${await fs.readFile(path.join(root, 'src', 'extension.cjs'), 'utf8')}\n})`, {AbortController, process, Buffer, setTimeout: () => 1, clearTimeout() {}})(requireMock, mod, mod.exports);
  const api = await mod.exports.activate({globalStorageUri: {fsPath: dir}, extensionUri: {fsPath: root}, extensionPath: root, extension: {id: 'local-tools.usage-atlas', packageJSON: require('../package.json')}, subscriptions: []});
  t.after(async () => {
    release(); mod.exports.deactivate();
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('usage-atlas-opening-')) throw Error('Unsafe cleanup');
    await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});
  });
  const bootstrap = panel => JSON.parse(panel.webview.html.match(/id="ua-initial-data"[^>]*>(.*?)<\/script>/s)[1]);
  return {api, theme: vscode.window.activeColorTheme, commands, replaceStored(value) {records = value;}, open: commands.get('usageAtlas.open'), panels, calls, release, bootstrap, plan, changes, settings, previewOptions, markdowns, appendStored() {records = [...records, {...records[0], time: now + 2, windows: {five: null, week: {used: 33, reset: now + 604800000}}}];}};
}
test('independent decimal settings enter the snapshot and invalidate the preview cache immediately', async t => {
  const h = await harness(t);
  h.settings.codexCreditDecimals = 2; h.settings.claudeUsdDecimals = 6;
  await h.open();
  const panel = h.panels[0], initial = h.bootstrap(panel);
  assert.equal(initial.codexCreditDecimals, 2); assert.equal(initial.claudeUsdDecimals, 6);
  await panel.receive({type: 'ready', revision: initial.revision});
  const count = h.previewOptions.length;
  h.settings.codexCreditDecimals = 0; h.settings.claudeUsdDecimals = 8;
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.previewOptions.length > count);
  assert.equal(h.previewOptions.at(-1).codexCreditDecimals, 0); assert.equal(h.previewOptions.at(-1).claudeUsdDecimals, 8);
  assert.equal(panel.messages.at(-1).codexCreditDecimals, 0); assert.equal(panel.messages.at(-1).claudeUsdDecimals, 8);
  assert.equal(h.calls.length, 0);
});
test('page size settings enter the first snapshot and update the open page without provider requests', async t => {
  const h = await harness(t);
  h.settings.pageWidth = 1200; h.settings.pageHeight = 800;
  await h.open();
  const panel = h.panels[0], initial = h.bootstrap(panel);
  assert.equal(initial.pageWidth, 1200); assert.equal(initial.pageHeight, 800);
  await panel.receive({type: 'ready', revision: initial.revision});
  h.settings.pageWidth = 0; h.settings.pageHeight = 600;
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.messages.at(-1).pageWidth, 0); assert.equal(panel.messages.at(-1).pageHeight, 600);
  assert.equal(h.calls.length, 0);
});
test('first open never waits for provider collection and updates made before ready are not lost', async t => {
  const h = await harness(t), collecting = h.api.refresh();
  while (!h.calls.length) await new Promise(resolve => setImmediate(resolve));
  let timeout;
  try {await Promise.race([h.open(), new Promise((_, reject) => {timeout = setTimeout(() => reject(Error('Open waited for collection')), 1000);})]);} finally {clearTimeout(timeout);}
  const panel = h.panels[0], initial = h.bootstrap(panel);
  assert.equal(initial.data.codex.last.windows.week.used, 30);
  h.release(); await collecting;
  await panel.receive({type: 'ready', revision: initial.revision});
  assert.equal(panel.messages.length, 1);
  assert.equal(panel.messages[0].data.codex.last.windows.week.used, 31);
});
test('bootstrap preserves CSP escaping and ready acknowledgement skips duplicate data', async t => {
  const h = await harness(t); await h.open();
  assert.equal(h.calls.length, 0, 'opening does not start an extra network request');
  const panel = h.panels[0], initial = h.bootstrap(panel);
  assert.equal(initial.data.codex.last.plan, h.plan);
  assert.ok(!panel.webview.html.includes(h.plan), 'untrusted values cannot close the JSON script element');
  assert.match(panel.webview.html, /script-src 'nonce-/);
  await panel.receive({type: 'ready', revision: initial.revision});
  await panel.receive({type: 'ready', revision: initial.revision});
  panel.view();
  assert.equal(panel.messages.length, 0);
});
test('hidden and existing views refresh data without a range reset', async t => {
  const h = await harness(t); await h.open();
  const panel = h.panels[0], initial = h.bootstrap(panel);
  await panel.receive({type: 'ready', revision: initial.revision});
  panel.visible = false; panel.view(); assert.equal(h.api.isUiReady(), false);
  panel.visible = true; panel.view();
  await panel.receive({type: 'ready', revision: initial.revision});
  assert.equal(panel.messages.length, 1); assert.equal(panel.messages[0].resetView, undefined);
  await h.open(); assert.equal(panel.messages.length, 2); assert.equal(panel.messages[1].resetView, undefined);
  panel.dispose(); await h.open();
  await panel.receive({type: 'ready', revision: -1});
  assert.equal(h.panels[1].messages.length, 0, 'a disposed view cannot publish into the new one');
});
test('a message rejected during view teardown is retried without changing the range', async t => {
  const h = await harness(t); await h.open();
  const panel = h.panels[0]; await panel.receive({type: 'ready', revision: h.bootstrap(panel).revision});
  const post = panel.webview.postMessage;
  panel.webview.postMessage = async () => false;
  await h.open(); await new Promise(resolve => setImmediate(resolve));
  panel.webview.postMessage = post;
  panel.view(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.messages.length, 1); assert.equal(panel.messages[0].resetView, undefined);
});
test('opening follows records saved by another window without starting provider requests', async t => {
  const h = await harness(t); assert.equal(h.api.snapshot().data.codex.last.windows.week.used, 30);
  h.appendStored(); await h.open();
  assert.equal(h.bootstrap(h.panels[0]).data.codex.last.windows.week.used, 33);
  assert.equal(h.calls.length, 0);
});
test('graph detail messages read local reports without provider requests and diagnostics respond to settings', async t => {
  const h = await harness(t); await h.open();
  const panel = h.panels[0], now = Date.now();
  const message = {type: 'details', requestId: 'details-codex', provider: 'codex', window: 'week', time: now, start: now - 3600000, end: now + 1000};
  await panel.receive(message);
  let reply = panel.messages.at(-1);
  assert.equal(reply.type, 'details'); assert.equal(reply.requestId, message.requestId);
  assert.equal(reply.data.summary.provider, 'codex'); assert.equal(reply.data.diagnostics.enabled, true);
  assert.equal(reply.data.attribution.author, 'jisoq'); assert.equal(h.calls.length, 0);
  h.settings.diagnosticsEnabled = false;
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  await panel.receive({...message, provider: 'claude', requestId: 'details-claude'});
  reply = panel.messages.at(-1);
  assert.equal(reply.type, 'details'); assert.equal(reply.data.summary.provider, 'claude');
  assert.deepEqual(reply.data.diagnostics, {enabled: false}); assert.equal(h.calls.length, 0);
  await panel.receive({...message, requestId: 'invalid-request', provider: 'external'});
  assert.equal(panel.messages.at(-1).type, 'detailsError'); assert.equal(h.calls.length, 0);
});
test('analysis exclusion preview is read-only, then commit and restoration preserve official quota observations', async t => {
  const h = await harness(t); await h.open();
  const panel = h.panels[0], first = h.api.snapshot().data.codex.last.time;
  h.appendStored();
  const deadline = Date.now() + 1000;
  while (Date.now() < first + 3 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  const base = {provider: 'codex', window: 'week', time: first + 1, start: first - 1, end: Date.now(), excludeStart: first, excludeEnd: first + 2, reason: 'test workload'};
  await panel.receive({...base, type: 'analysisPreviewExclude', requestId: 'preview-1'});
  assert.equal(panel.messages.at(-1).type, 'details'); assert.ok(panel.messages.at(-1).data.exclusionPreview);
  const file = path.join(h.api.storagePath, 'metadata.json');
  assert.equal((JSON.parse(await fs.readFile(file, 'utf8')).exclusions || []).length, 0);
  await panel.receive({...base, type: 'analysisExclude', requestId: 'exclude-1'});
  assert.equal(panel.messages.at(-1).type, 'details');
  let exclusions = JSON.parse(await fs.readFile(file, 'utf8')).exclusions;
  assert.equal(exclusions.length, 1); assert.equal(exclusions[0].restoredAt, null);
  assert.equal(h.api.snapshot().data.codex.last.windows.week.used, 33);
  await panel.receive({...base, type: 'analysisRestore', requestId: 'restore-1', exclusionId: exclusions[0].id});
  assert.equal(panel.messages.at(-1).type, 'details');
  exclusions = JSON.parse(await fs.readFile(file, 'utf8')).exclusions;
  assert.ok(exclusions[0].restoredAt); assert.equal(h.api.snapshot().data.codex.last.windows.week.used, 33);
  assert.equal(h.calls.length, 0);
});

test('storage recovery failure preserves a longer server backoff and starts no provider read', async t => {
  const now = Date.now(), next = now + 900000;
  const collectors = Object.fromEntries(['codex', 'claude'].map(id => [id, {last: now, next, errors: 1, message: 'limited'}]));
  const h = await harness(t, {metadata: {collectors}, settings: {intervalSeconds: 60}});
  await fs.mkdir(path.join(h.api.storagePath, 'pending-observations.jsonl'));
  for (const change of h.changes) change({affectsConfiguration: section => ['usageAtlas', 'usageAtlas.intervalSeconds'].includes(section)});
  await h.api.refresh();
  const metadata = JSON.parse(await fs.readFile(path.join(h.api.storagePath, 'metadata.json'), 'utf8'));
  for (const id of ['codex', 'claude']) assert.equal(metadata.collectors[id].next, next);
  assert.equal(h.calls.length, 0); assert.match(h.api.pendingStatus().issue, /복구 대기/);
});
test('disabling analysis immediately retimes an idle reservation to the configured base interval', async t => {
  const now = Date.now();
  const collectors = Object.fromEntries(['codex', 'claude'].map(id => [id, {last: now, next: now + 240000, errors: 0, message: '정상'}]));
  const h = await harness(t, {metadata: {collectors}, settings: {intervalSeconds: 60, analysisEnabled: true}});
  h.settings.analysisEnabled = false;
  for (const change of h.changes) change({affectsConfiguration: section => ['usageAtlas', 'usageAtlas.analysisEnabled'].includes(section)});
  await h.api.refresh();
  const metadata = JSON.parse(await fs.readFile(path.join(h.api.storagePath, 'metadata.json'), 'utf8'));
  for (const id of ['codex', 'claude']) assert.equal(metadata.collectors[id].next, now + 60000);
  assert.equal(h.calls.length, 0);
});

test('automatic cache powers first open, ignores legacy arbitrary rates and rejects changed observation contents', async t => {
  const {buildConversion} = require('../src/credit-conversion.cjs');
  const base = Date.now() - 180000, account = core.hash('cache-fixture');
  const records = [0, 1, 2].map(i => ({v: 1, provider: 'codex', account, plan: 'pro', time: base + i * 60000, creditBalance: i < 2 ? 1000 : 900, windows: {five: {used: i ? 10 : 0, reset: base + 18000000}, week: {used: i ? 2 : 0, reset: base + 604800000}}}));
  const capacities = ['five', 'week'].map(window => ({provider: 'codex', account, plan: 'pro', window, mult: 5, time: base}));
  const calls = [1, 2].map(i => ({id: 'call-' + i, provider: 'codex', account, homeKey: 'fixture', startedAt: base + (i - 1) * 60000 + 1000, completedAt: base + i * 60000 - 1000, time: base + i * 60000 - 1000, completionState: 'completed', model: 'gpt-6.1-sol', mode: i === 1 ? 'unknown' : 'Fast', input: 1000000, cached: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0}));
  const automatic = buildConversion({records, calls, capacities});
  const h = await harness(t, {records, automatic, metadata: {capacities, creditConversions: [{provider: 'codex', rate: 999999}]}, settings: {codexCreditPercentPerCredit: 999999, creditPercentPerUsd: 999999}});
  await h.open();
  const payload = h.bootstrap(h.panels[0]);
  assert.equal(payload.data.codex.windows.five.at(-1).creditEstimate.usage, 125);
  assert.equal(payload.data.codex.creditRate, undefined); assert.equal(payload.codexCreditPercentPerCredit, undefined); assert.equal(payload.creditPercentPerUsd, undefined); assert.equal(h.commands.has('usageAtlas.creditSetup'), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.previewOptions.at(-1).projection.codex.windows.five.at(-1).creditEstimate.nativeUsage, 25);
  const nextAutomatic = structuredClone(automatic); for (const cohort of nextAutomatic.cohorts) cohort.unitsPerPercent *= 2;
  const file = path.join(h.api.storagePath, 'automatic-conversion.json');
  await fs.writeFile(file + '.next', JSON.stringify(nextAutomatic)); await fs.rename(file + '.next', file);
  const beforePreviewCount = h.previewOptions.length;
  await h.open();
  assert.ok(h.previewOptions.length > beforePreviewCount, 'conversion-only updates invalidate the status preview without waiting for a minute');
  assert.equal(h.previewOptions.at(-1).projection.codex.windows.five.at(-1).creditEstimate.nativeUsage, 12.5);
  assert.equal(h.api.snapshot().data.codex.windows.five.at(-1).creditEstimate.nativeUsage, 12.5);
  assert.equal(h.calls.length, 0);
  h.replaceStored(records.map((r, i) => i === 2 ? {...r, creditBalance: 800} : r));
  await h.open(); assert.equal(h.api.snapshot().data.codex.windows.five.at(-1).creditEstimate.usage, null);
  assert.equal(h.calls.length, 0);
});

test('page color mode immediately controls preview image palette regardless of editor theme', async t => {
  const h = await harness(t, {settings: {colorMode: 'light'}}); await h.open();
  assert.equal(h.api.snapshot().colorMode, 'light'); assert.equal(h.previewOptions.at(-1).dark, false);
  const count = h.previewOptions.length;
  h.theme.kind = 1; h.settings.colorMode = 'dark';
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  assert.ok(h.previewOptions.length > count); assert.equal(h.previewOptions.at(-1).dark, true);
  assert.equal(h.api.snapshot().colorMode, 'dark');
  h.settings.colorMode = 'system';
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  assert.equal(h.previewOptions.at(-1).dark, false); assert.equal(h.calls.length, 0);
});

test('forecast settings share a cached unthinned estimate between page and preview without provider reads', async t => {
  const end = Date.now() - 1000;
  const records = Array.from({length: 61}, (_, i) => ({v: 1, provider: 'codex', account: core.hash('forecast-host'), plan: 'test', time: end - (60 - i) * 60000, windows: {five: {used: 20 + i / 2, reset: end + 18000000}, week: {used: 20 + i / 2, reset: end + 1800000}}, creditBalance: 1000}));
  const h = await harness(t, {records, realPreview: true}); await h.open();
  const payload = h.api.snapshot(), value = payload.data.codex.forecast.five;
  assert.equal(payload.forecastEnabled, true); assert.equal(value.state, 'predicted');
  assert.equal(value.eta, h.previewOptions.at(-1).projection.codex.forecast.five.eta);
  assert.match(h.markdowns.at(-1).value, /사용 가능 ≈1h 40m/);
  assert.match(h.markdowns.at(-1).value, /초기화 잔여 ≈35%/);
  assert.doesNotMatch(h.markdowns.at(-1).value, /초기화 우선|만료 우선/);
  assert.equal(h.api.snapshot().data.codex.forecast, payload.data.codex.forecast, 'unchanged observations reuse the forecast object');
  h.settings.forecastFiveLookbackMinutes = 30;
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  assert.equal(h.api.snapshot().data.codex.forecast.five.lookbackMs, 1800000);
  h.settings.forecastEnabled = false;
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  assert.equal(h.api.snapshot().data.codex.forecast, undefined); assert.equal(h.api.snapshot().forecastEnabled, false);
  assert.doesNotMatch(h.markdowns.at(-1).value, /사용 가능|초기화 잔여/); assert.equal(h.calls.length, 0);
});


test('pattern period and timezone settings invalidate the cached forecast without collecting providers', async t => {
  const records = require('./pattern-fixture.cjs').records(Date.now());
  const h = await harness(t, {records, realPreview: true}); await h.open();
  const first = h.api.snapshot().data.codex.forecast.five;
  assert.equal(first.pattern.days, 21); assert.equal(first.pattern.timeZone, 'Asia/Seoul');
  h.settings.forecastPatternDays = 0;
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  assert.equal(h.api.snapshot().data.codex.forecast.five.pattern, undefined);
  h.settings.forecastPatternDays = 28; h.settings.forecastPatternTimeZone = 'UTC';
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  const next = h.api.snapshot().data.codex.forecast.five;
  assert.equal(next.pattern.days, 28); assert.equal(next.pattern.timeZone, 'UTC');
  assert.equal(h.previewOptions.at(-1).projection.codex.forecast.five, next); assert.equal(h.calls.length, 0);
});


test('chart history period enters initial HTML and updates the page without querying providers', async t => {
  const h = await harness(t, {settings: {chartHistoryDays: 30}}); await h.open();
  const panel = h.panels[0], first = h.bootstrap(panel);
  assert.equal(first.chartHistoryDays, 30); await panel.receive({type: 'ready', revision: first.revision});
  const previewCount = h.previewOptions.length; h.settings.chartHistoryDays = 90;
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas' || section === 'usageAtlas.chartHistoryDays'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.messages.at(-1).chartHistoryDays, 90); assert.equal(h.previewOptions.length, previewCount); assert.equal(h.calls.length, 0);
});


test('weekly lookback defaults to 72 hours and preserves an explicitly configured 24-hour value', async t => {
  const h = await harness(t); await h.open();
  assert.equal(h.api.snapshot().data.codex.forecast.week.lookbackMs, 72 * 3600000);
  h.settings.forecastWeekLookbackHours = 24;
  for (const change of h.changes) change({affectsConfiguration: section => section === 'usageAtlas'});
  assert.equal(h.api.snapshot().data.codex.forecast.week.lookbackMs, 24 * 3600000);
  assert.equal(h.previewOptions.at(-1).projection.codex.forecast.week.lookbackMs, 24 * 3600000); assert.equal(h.calls.length, 0);
});


test('append-only observed credit debits update page and preview immediately while a changed prefix stays rejected', async t => {
  const {fixture} = require('./credit-gap-fixture.cjs'), engine = require('../src/credit-conversion.cjs');
  const input = fixture(), automatic = engine.buildConversion(input);
  const h = await harness(t, {records: input.records, automatic, metadata: {capacities: input.capacities}, realPreview: true});
  await h.open(); const initial = h.api.snapshot().data.codex.windows.week.at(-1).creditEstimate.nativeTotal;
  const last = input.records.findLast(row => row.provider === 'codex');
  const appended = [...input.records, {...last, time: last.time + 1000, creditBalance: last.creditBalance - 25}];
  h.replaceStored(appended); await h.open();
  const value = h.api.snapshot().data.codex.windows.week.at(-1).creditEstimate;
  assert.ok(value.nativeTotal > initial); assert.equal(value.standardPending, true);
  assert.equal(h.previewOptions.at(-1).projection.codex.windows.week.at(-1).creditEstimate.nativeTotal, value.nativeTotal);
  assert.equal(h.calls.length, 0);
  h.replaceStored(appended.map((row, i) => i === 0 ? {...row, creditBalance: row.creditBalance + 1} : row));
  await h.open(); assert.equal(h.api.snapshot().data.codex.windows.week.at(-1).creditEstimate.nativeTotal, null);
});


test('vertical credit basis persists immediately to the shared page/preview setting and rejects other settings', async t => {
  const h = await harness(t, {realPreview: true}); await h.open(); const panel = h.panels[0];
  const initial = h.bootstrap(panel); await panel.receive({type: 'ready', revision: initial.revision});
  const count = h.previewOptions.length; await panel.receive({type: 'creditBasis', value: 'billing'});
  assert.equal(h.api.snapshot().creditBasis, 'billing'); assert.ok(h.previewOptions.length > count); assert.equal(h.previewOptions.at(-1).creditBasis, 'billing');
  assert.match(h.markdowns.at(-1).value, /data:image/);
  await panel.receive({type: 'creditBasis', value: 'unexpected'}); assert.equal(h.settings.creditBasis, 'billing');
  await Promise.all([panel.receive({type: 'creditBasis', value: 'subscription'}), panel.receive({type: 'creditBasis', value: 'billing'})]);
  assert.equal(h.settings.creditBasis, 'billing'); assert.equal(h.calls.length, 0);
});


test('data updated while hidden reaches the resumed view without resetting its range', async t => {
  const h = await harness(t); await h.open();
  const panel = h.panels[0], initial = h.bootstrap(panel);
  await panel.receive({type: 'ready', revision: initial.revision});
  panel.visible = false; panel.view(); h.appendStored();
  await h.open(); assert.equal(panel.messages.length, 0, 'wait for the resumed document acknowledgement');
  await panel.receive({type: 'ready', revision: initial.revision});
  assert.equal(panel.messages.at(-1).data.codex.last.windows.week.used, 33);
  assert.equal(panel.messages.at(-1).resetView, undefined);
  const count = panel.messages.length;
  panel.visible = false; panel.view(); panel.visible = true; panel.view();
  await panel.receive({type: 'ready', revision: panel.messages.at(-1).revision});
  assert.equal(panel.messages.length, count + 1, 'returning refreshes the clock even at the same data revision');
  assert.equal(panel.messages.at(-1).resetView, undefined); assert.equal(h.calls.length, 0);
});


test('Antigravity joins the configured collection schedule atomically and both views without starting Codex or Claude', async t => {
  const now = Date.now(), quota = {response: {groups: [{displayName: 'Gemini Models', buckets: [{bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: .6, resetTime: new Date(now + 86400000).toISOString()}]}]}};
  const values = require('../src/antigravity.cjs').snapshots(quota, {account: core.hash('google-fixture'), plan: 'g1-pro-tier'}, now);
  const h = await harness(t, {settings: {intervalSeconds: 60}, metadata: {collectors: Object.fromEntries(['codex', 'claude'].map(id => [id, {last: now, next: now + 3600000, backoffUntil: now + 3600000, message: 'fixture'}]))}, antigravity: async (_dir, _signal, options) => {assert.equal(options.connection().port, 12345); return values;}});
  await h.open(); const before = h.bootstrap(h.panels[0]); assert.ok(before.data.antigravity); assert.equal(h.calls.length, 0);
  await h.api.refresh(); assert.deepEqual(h.calls, ['antigravity']);
  const after = h.api.snapshot(), id = values[0].provider;
  assert.equal(after.data.antigravity, undefined); assert.equal(after.data[id].last.windows.week.used, 40);
  assert.equal(after.data[id].status.message, '정상'); assert.equal(after.data[id].status.effectiveIntervalSeconds, 60);
  assert.ok(h.previewOptions.at(-1).projection[id]);
  h.settings.antigravityEnabled = false;
  for (const change of h.changes) await change({affectsConfiguration: section => section === 'usageAtlas' || section === 'usageAtlas.antigravityEnabled'});
  await h.api.refresh(); assert.deepEqual(h.calls, ['antigravity']); assert.equal(h.api.snapshot().data[id].status.message, '수집 중지');
});


test('display settings update both views immediately without changing collected history or querying providers', async t => {
  const h = await harness(t, {realPreview: true}); await h.open(); const panel = h.panels[0], initial = h.bootstrap(panel);
  await panel.receive({type: 'ready', revision: initial.revision});
  const before = h.api.snapshot(); assert.equal(before.visibility.showCodex, true);
  const apply = async key => {for (const change of h.changes) await change({affectsConfiguration: section => section === 'usageAtlas' || section === 'usageAtlas.' + key});};
  h.settings['display.codex'] = false; await apply('display.codex');
  assert.equal(h.api.snapshot().visibility.showCodex, false); assert.equal(panel.messages.at(-1).visibility.showCodex, false);
  assert.equal(h.previewOptions.at(-1).visibility.showCodex, false);
  const rendered = require('../src/hover.cjs').preview([], {projection: h.previewOptions.at(-1).projection, visibility: h.previewOptions.at(-1).visibility});
  assert.deepEqual(rendered.summaries.map(row => row.name), ['Claude Code']);
  assert.deepEqual(h.api.snapshot().data, before.data); assert.equal(h.api.snapshot().count, before.count);
  h.settings['display.claude'] = false; await apply('display.claude');
  assert.deepEqual(require('../src/hover.cjs').preview([], h.previewOptions.at(-1)).summaries, []);
  h.settings['display.codex'] = true; await apply('display.codex');
  assert.equal(h.api.snapshot().visibility.showCodex, true); assert.equal(h.calls.length, 0);
});
