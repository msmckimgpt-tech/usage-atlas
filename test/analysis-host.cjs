'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, browserOptions} = require('./browser.cjs');
const {Store, hash} = require('../src/core.cjs');
const adapters = require('../src/adapters.cjs');
exports.run = async () => {
  const root = path.resolve(__dirname, '..'), result = {status: 'RUNNING', scope: 'actual VS Code Extension Host and CSP Webview; synthetic local logs; no provider requests'};
  const cfg = vscode.workspace.getConfiguration('usageAtlas'), original = {codex: adapters.codex, claude: adapters.claude};
  let calls = 0, browser;
  adapters.codex = adapters.claude = async () => {calls++; throw new Error('fixture forbids provider requests');};
  try {
    const api = await vscode.extensions.getExtension(require('../package.json').publisher + '.' + require('../package.json').name).activate();
    const now = Date.now(), secret = 'PRIVATE-TEST-CONTENT-MUST-NOT-PERSIST';
    const source = path.join(root, '.test-analysis-input'), codexHome = path.join(source, 'codex'), claudeDir = path.join(source, 'claude');
    assert.equal(path.resolve(process.env.CODEX_HOME).toLowerCase(), path.resolve(codexHome).toLowerCase());
    const stamp = offset => new Date(now + offset).toISOString();
    const jsonl = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';
    for (const child of [false, true]) {
      const session = child ? 'codex-child' : 'codex-main', id = child ? 'response-child' : 'response-main';
      const file = path.join(codexHome, 'sessions', session + '.jsonl'); await fs.mkdir(path.dirname(file), {recursive: true});
      await fs.writeFile(file, jsonl([
          {type: 'session_meta', timestamp: stamp(-25000), payload: {id: session, cwd: '/fixture/Project Atlas', account_hash: hash('codex'), ...(child ? {parent_thread_id: 'codex-main'} : {}), instructions: secret}}
        , {type: 'response_item', timestamp: stamp(-24500), payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'NATIVE-CODEX-TASK'}]}}
        , {type: 'response_item', timestamp: stamp(-19500), payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'NATIVE-CODEX-REPLY'}]}}
        , {type: 'turn_context', timestamp: stamp(-24000), payload: {turn_id: 'turn-' + session, model: 'gpt-6.1-sol', effort: 'high', mode: 'Standard', service_tier: 'default'}}
        , {type: 'response.created', timestamp: stamp(-22000), response: {id, model: 'gpt-6.1-sol'}}
        , {type: 'response.completed', timestamp: stamp(-20000), response: {id, model: 'gpt-6.1-sol', usage: {input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 20}, output: secret}}
      ]));
      const cf = path.join(claudeDir, 'projects', 'fixture', child ? 'claude-main/subagents/agent-child.jsonl' : 'claude-main.jsonl');
      await fs.mkdir(path.dirname(cf), {recursive: true});
      const message = {id: child ? 'message-child' : 'message-main', model: 'claude-opus-5-5', role: 'assistant', content: [{type: 'text', text: 'NATIVE-CLAUDE-REPLY'}], usage: {input_tokens: 800, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, cache_creation: {ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0}, output_tokens: 100}};
      await fs.writeFile(cf, jsonl([
          {type: 'user', timestamp: stamp(-24500), sessionId: 'claude-main', message: {role: 'user', content: [{type: 'text', text: 'NATIVE-CLAUDE-TASK'}]}}
        , {type: 'stream_event', timestamp: stamp(-22000), sessionId: 'claude-main', requestId: 'request-' + id, cwd: '/fixture/Project Atlas', effort: 'high', mode: 'Standard', event: {type: 'message_start', message}}
        , {type: 'assistant', timestamp: stamp(-20000), sessionId: 'claude-main', requestId: 'request-' + id, cwd: '/fixture/Project Atlas', effort: 'high', mode: 'Standard', message: {...message, stop_reason: 'end_turn'}}
      ]));
    }
    const records = ['codex', 'claude'].flatMap(provider => [-30000, -10000, -1000].map((offset, i) => ({v: 1, provider, account: hash(provider), plan: 'native-fixture', source: 'import', time: now + offset, windows: {five: {used: 10 + i * 5, reset: now + 18000000}, week: {used: 20 + i * 5, reset: now + 604800000}}})));
    assert.ok(api.storagePath.toLowerCase().includes('.test-analysis-user'));
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl');
      await fs.writeFile(file + '.fixture.tmp', jsonl(records)); await fs.rename(file + '.fixture.tmp', file);
    });
    const metadata = {capacities: [], creditConversions: [], exclusions: [], goals: {}, collectors: Object.fromEntries(['codex', 'claude'].map(id => [id, {last: now, next: now + 3600000, backoffUntil: now + 3600000, errors: 0, message: 'fixture'}]))};
    await fs.writeFile(path.join(api.storagePath, 'metadata.json'), JSON.stringify(metadata));
    await cfg.update('claudeConfigDir', claudeDir, vscode.ConfigurationTarget.Global);
    await cfg.update('intervalSeconds', 60, vscode.ConfigurationTarget.Global);
    await cfg.update('analysisEnabled', true, vscode.ConfigurationTarget.Global);
    await cfg.update('diagnosticsEnabled', true, vscode.ConfigurationTarget.Global);
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
    await api.refresh();
    const currentCallsReady = () => {const rows = api.analysisSnapshot().calls; return rows.length === 4 && rows.every(row => row.time >= now - 30000 && row.time <= now);};
    for (let n = 0; n < 12 && !currentCallsReady(); n++) {await api.maintainAnalysis(true); if (!currentCallsReady()) await new Promise(resolve => setTimeout(resolve, 25));}
    assert.equal(api.analysisSnapshot().calls.length, 4);
    for (const provider of ['codex', 'claude']) {
      const detail = await api.details({provider, window: 'week', requestId: 'native-' + provider, time: now - 15000, start: now - 60000, end: now});
      assert.equal(detail.summary.callCount, 2); assert.equal(detail.sessions.totalCount, 2);
      assert.equal(detail.diagnostics.enabled, true); assert.equal(detail.attribution.author, 'jisoq');
      result[provider] = {calls: detail.summary.callCount, sessions: detail.sessions.totalCount, priced: detail.summary.pricedCallCount, quotaDelta: detail.estimate.quotaDelta, estimate: detail.estimate.valueUsdPer100Pct, sourceAccountAssumptions: detail.estimate.accountAssumedCallCount};
    }
    const cached = await fs.readFile(path.join(api.storagePath, 'session-index.json'), 'utf8');
    assert.equal(cached.includes(secret), false); assert.equal(cached.includes('/fixture/'), false);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.USAGE_ATLAS_TEST_DEBUG_PORT);
    const context = browser.contexts()[0];
    const workbench = context.pages().find(page => page.url().includes('workbench'));
    const onboarding = workbench.locator('.onboarding-a-overlay.visible');
    if (await onboarding.count()) {
      await workbench.keyboard.press('Escape');
      try {await onboarding.waitFor({state: 'hidden', timeout: 2000});}
      catch {result.onboardingButtons = await onboarding.getByRole('button').allTextContents(); throw new Error('Isolated profile onboarding remains open');}
    }
    const started = Date.now(); await vscode.commands.executeCommand('usageAtlas.open'); result.openCommandMs = Date.now() - started;
    let frame; const deadline = Date.now() + 20000;
    while (!frame && Date.now() < deadline) {
      for (const page of context.pages()) for (const candidate of page.frames()) {
        if (await candidate.locator('[data-details-line="codex-week"]').count().catch(() => 0)) {frame = candidate; break;}
      }
      if (!frame) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(frame, 'real CSP Webview renders graph detail targets'); result.webviewReadyMs = Date.now() - started;
    const resolveChartFrame = async () => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        for (const page of context.pages()) for (const candidate of page.frames()) {
          if (await candidate.locator('#ua-chart').isVisible().catch(() => false)) return candidate;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Usage Atlas Webview did not resume');
    };
    const chartRange = () => frame.locator('#ua-chart').evaluate(node => [+node.dataset.domainStart, +node.dataset.domainEnd]);
    await frame.locator('#ua-nav-pan').focus(); await frame.locator('#ua-nav-pan').press('+'); await frame.locator('#ua-nav-pan').press('ArrowLeft');
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const selectedRange = await chartRange(), previousTransparency = cfg.get('tooltipTransparency', 14);
    const otherTab = await vscode.workspace.openTextDocument({content: 'Usage Atlas tab-switch fixture', language: 'plaintext'});
    for (let cycle = 0; cycle < 3; cycle++) {
      await vscode.window.showTextDocument(otherTab, {viewColumn: vscode.ViewColumn.Active, preview: false});
      const hiddenDeadline = Date.now() + 5000;
      while (api.isUiReady() && Date.now() < hiddenDeadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(api.isUiReady(), false, 'background Webview releases readiness');
      await cfg.update('tooltipTransparency', 20 + cycle, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('usageAtlas.open'); frame = await resolveChartFrame();
      result.tabRangeAttempts ||= []; result.tabRangeAttempts.push({cycle, selectedRange, resumedRange: await chartRange()});
      await frame.waitForFunction(range => {const node = document.getElementById('ua-chart'); return +node.dataset.domainStart === range[0] && +node.dataset.domainEnd === range[1];}, selectedRange);
      assert.deepEqual(await chartRange(), selectedRange, 'actual tab switching preserves the selected absolute range');
      await vscode.commands.executeCommand('usageAtlas.open');
      assert.deepEqual(await chartRange(), selectedRange, 'repeated Usage commands preserve the existing view');
    }
    await cfg.update('tooltipTransparency', previousTransparency, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('usageAtlas.open'); frame = await resolveChartFrame();
    const freshRange = await chartRange(); assert.ok(Math.abs(freshRange[1] - freshRange[0] - 14 * 86400000) < 100);
    assert.notDeepEqual(freshRange, selectedRange, 'closing the panel creates a fresh default range on the next open');
    result.tabRange = {switches: 3, preservedRange: true, hiddenDataUpdates: true, repeatedOpenPreserved: true, freshPanelDefaults: true, providerRequests: calls};
    const target = frame.locator('[data-details-line="codex-week"]').first();
    await target.focus(); await target.press('Enter');
    const dialog = frame.locator('#ua-details'); await dialog.waitFor({state: 'visible'});
    await frame.waitForFunction(() => document.getElementById('ua-details')?.getAttribute('aria-busy') !== 'true');
    assert.match(await frame.locator('#ua-panel-report').textContent(), /세션/);
    assert.equal(await frame.locator('#ua-details-diagnostics').isVisible(), true);
    await cfg.update('diagnosticsEnabled', false, vscode.ConfigurationTarget.Global);
    await frame.waitForFunction(() => document.getElementById('ua-details-diagnostics')?.hidden === true);
    assert.equal((await api.details({provider: 'codex', window: 'week', requestId: 'native-off', time: now, start: now - 60000, end: now})).diagnostics.enabled, false);
    await frame.locator('#ua-details-close').click();
    await frame.locator('[data-details-line="claude-week"]').first().focus();
    await frame.locator('[data-details-line="claude-week"]').first().press('Space');
    await dialog.waitFor({state: 'visible'}); await frame.waitForFunction(() => document.getElementById('ua-details')?.getAttribute('aria-busy') !== 'true');
    assert.match(await dialog.textContent(), /Claude Code/);
    assert.equal((await dialog.textContent()).includes(secret), false);
    await fs.mkdir(path.join(root, 'screenshots'), {recursive: true});
    await context.pages()[0].screenshot({path: path.join(root, 'screenshots', 'analysis-native-fixture.png')});
    await frame.locator('#ua-details-close').click();
    for (const id of ['codex', 'claude']) {
      await frame.locator('[data-details-line="' + id + '-week"]').first().focus(); await frame.locator('[data-details-line="' + id + '-week"]').first().press('Enter');
      await frame.waitForFunction(() => document.getElementById('ua-details')?.getAttribute('aria-busy') !== 'true');
      await frame.locator('table[aria-label="세션 → 요청 → 호출"]').getByRole('button', {name: '대화 보기', exact: true}).first().click();
      await frame.waitForFunction(() => !!document.querySelector('#ua-conversation-messages pre'));
      const body = await frame.locator('#ua-panel-conversation').textContent(); assert.match(body, new RegExp('NATIVE-' + id.toUpperCase() + '-TASK')); assert.match(body, new RegExp('NATIVE-' + id.toUpperCase() + '-REPLY'));
      const full = await frame.locator('#ua-details').evaluate(node => {const rect = node.getBoundingClientRect(); return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, vw: innerWidth, vh: innerHeight};});
      assert.equal(full.x, 0); assert.equal(full.y, 0); assert.equal(full.width, full.vw); assert.equal(full.height, full.vh);
      const times = await frame.locator('.ua-conversation-message').evaluateAll(nodes => nodes.map(node => +node.dataset.time)); assert.ok(times.every((time, i) => !i || time <= times[i - 1]));
      await workbench.screenshot({path: path.join(root, 'screenshots/details-conversation-' + id + '-native.png')});
      await frame.locator('#ua-details-close').click();
      for (let i = 0; i < 20 && api.conversationStatus().sources; i++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(api.conversationStatus().sources, 0);
    }
    const scopedCall = api.analysisSnapshot().calls.find(row => row.provider === 'codex');
    const deniedRequest = {provider: 'codex', window: 'week', requestId: 'conversation-denied', time: now - 15000, start: now - 60000, end: now + 60000, conversationSessionId: scopedCall.sessionId, conversationHomeKey: '0'.repeat(64)};
    await assert.rejects(api.conversation(deniedRequest), /세션/);
    await cfg.update('analysisEnabled', false, vscode.ConfigurationTarget.Global);
    await assert.rejects(api.conversation({...deniedRequest, conversationHomeKey: scopedCall.homeKey}), /꺼져/);
    await cfg.update('analysisEnabled', true, vscode.ConfigurationTarget.Global);
    result.conversations = {bothProviders: true, onDemand: true, newestFirst: true, fullscreen: true, releasedOnClose: true, sourceAndSettingGuards: true};
    await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
    const creditFixture = require('./cumulative-credit-fixture.cjs').fixture(Date.now());
    const creditEngine = require('../src/credit-conversion.cjs'), creditModel = creditEngine.buildConversion(creditFixture);
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl'); await fs.writeFile(file + '.credit.tmp', jsonl(creditFixture.records)); await fs.rename(file + '.credit.tmp', file);
      await fs.writeFile(path.join(api.storagePath, 'metadata.json'), JSON.stringify({...metadata, capacities: creditFixture.capacities}));
      await fs.writeFile(path.join(api.storagePath, 'automatic-conversion.json'), JSON.stringify({...creditModel, schema: 4}));
    });
    await vscode.commands.executeCommand('usageAtlas.open');
    assert.equal(api.snapshot().data.codex.windows.week.at(-1).creditEstimate.nativeTotal, null, 'legacy derived cache is rejected');
    const automaticPath = path.join(api.storagePath, 'automatic-conversion.json');
    await fs.writeFile(automaticPath + '.current', JSON.stringify(creditModel)); await fs.rename(automaticPath + '.current', automaticPath);
    await vscode.commands.executeCommand('usageAtlas.open');
    assert.equal(api.snapshot().data.codex.windows.five.at(-1).creditEstimate.nativeTotal, 45);
    assert.equal(creditModel.ratioOnlyDebitCount, 1); assert.equal(creditModel.schema, 5);
    await frame.locator('#ua-mode').selectOption('total'); await frame.locator('#ua-credit').check(); await frame.locator('#ua-credit-mode').selectOption('money');
    await frame.waitForFunction(time => ['codex-credit', 'codex-credit-five', 'claude-credit', 'claude-credit-five'].every(key => [...document.querySelectorAll('[data-series="' + key + '"]')].some(node => node.__data__?.at(-1)?.time === time)), creditFixture.now);
    await frame.locator('#ua-credit-mode').selectOption('estimate');
    await frame.waitForFunction(time => ['codex-five', 'codex-week', 'claude-five', 'claude-week'].every(key => [...document.querySelectorAll('[data-series="' + key + '"]')].some(node => node.__data__?.at(-1)?.time === time)), creditFixture.now);
    await workbench.screenshot({path: path.join(root, 'screenshots/cumulative-credit-native.png')});
    result.cumulativeCredits = {schema: 5, ratioOnlyDebits: 1, oldCacheRejected: true, nativeAndAdditiveReachLatest: true, bothProviders: true};
    await frame.locator('#ua-codex').click(); await frame.waitForFunction(() => !document.querySelector('[data-series^="claude-"]') && !!document.querySelector('[data-series^="codex-"]'));
    assert.equal(await frame.locator('#ua-codex').getAttribute('aria-pressed'), 'true');
    await frame.locator('#ua-claude').click(); await frame.waitForFunction(() => !document.querySelector('[data-series^="codex-"]') && !!document.querySelector('[data-series^="claude-"]'));
    await frame.locator('#ua-claude').click(); await frame.waitForFunction(() => !!document.querySelector('[data-series^="codex-"]') && !!document.querySelector('[data-series^="claude-"]'));
    result.modelFocus = {solo: true, switch: true, sameButtonRestoresAll: true};

    const gapFixture = require('./credit-gap-fixture.cjs').fixture(Date.now()), gapModel = creditEngine.buildConversion(gapFixture);
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl'); await fs.writeFile(file + '.gap.tmp', jsonl(gapFixture.records)); await fs.rename(file + '.gap.tmp', file);
      await fs.writeFile(path.join(api.storagePath, 'metadata.json'), JSON.stringify({...metadata, capacities: gapFixture.capacities}));
      await fs.writeFile(automaticPath + '.gap', JSON.stringify(gapModel)); await fs.rename(automaticPath + '.gap', automaticPath);
    });
    await vscode.commands.executeCommand('usageAtlas.open');
    const gapData = api.snapshot().data;
    for (const id of ['codex', 'claude']) for (const window of ['five', 'week']) {
      const points = gapData[id].windows[window], point = points.at(-1);
      assert.ok(point.creditEstimate.nativeTotal > 0); assert.ok(point.creditEstimate.nativeUsage > 0);
      assert.equal(points[3].creditEstimate.nativeDelta, null); assert.equal(point.creditEstimate.nativeTotalContinuous, true);
    }
    await frame.locator('#ua-mode').selectOption('total'); await frame.locator('#ua-credit-mode').selectOption('money');
    await frame.waitForFunction(time => ['codex-credit', 'claude-credit'].every(key => [...document.querySelectorAll('[data-series="' + key + '"]')].some(node => node.__data__?.at(-1)?.time === time)), gapFixture.now);
    await frame.locator('#ua-credit-mode').selectOption('estimate');
    await frame.waitForFunction(time => ['codex-week', 'claude-week'].every(key => [...document.querySelectorAll('[data-series="' + key + '"]')].some(node => node.__data__?.at(-1)?.time === time)), gapFixture.now);
    await workbench.screenshot({path: path.join(root, 'screenshots/credit-gap-native.png')});
    result.creditGaps = {bothProviders: true,observedDebitPreserved: true,unknownTimingNotInvented: true,latestPathsRestored: true};

    const billFixture = structuredClone(gapFixture);
    for (const row of billFixture.records) row.plan = row.provider === 'codex' ? 'prolite' : 'team:default_claude_max_5x';
    for (const cap of billFixture.capacities) cap.plan = cap.provider === 'codex' ? 'prolite' : 'team:default_claude_max_5x';
    const billModel = creditEngine.buildConversion(billFixture);
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl'); await fs.writeFile(file + '.bill.tmp', jsonl(billFixture.records)); await fs.rename(file + '.bill.tmp', file);
      await fs.writeFile(path.join(api.storagePath, 'metadata.json'), JSON.stringify({...metadata, capacities: billFixture.capacities}));
      await fs.writeFile(automaticPath + '.bill', JSON.stringify(billModel)); await fs.rename(automaticPath + '.bill', automaticPath);
    });
    await vscode.commands.executeCommand('usageAtlas.open');
    const geometry = () => frame.locator('.ua-toolbar').evaluate(node => {const r = node.getBoundingClientRect(); return [r.x,r.y,r.width,r.height];});
    const beforeBasis = await geometry(); await frame.locator('#ua-credit-billing').check();
    await frame.waitForFunction(() => document.getElementById('usage-atlas').dataset.creditBasis === 'billing');
    for (let i = 0; i < 40 && vscode.workspace.getConfiguration('usageAtlas').get('creditBasis') !== 'billing'; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(vscode.workspace.getConfiguration('usageAtlas').get('creditBasis'), 'billing'); assert.equal(api.snapshot().creditBasis, 'billing');
    assert.equal(api.snapshot().data.codex.ledger.at(-1).billing.monthlyUsd, 100);
    assert.ok(Math.abs(api.snapshot().data.codex.ledger.at(-1).billing.total - 14) < 1e-9);
    assert.ok(Math.abs(api.snapshot().data.claude.ledger.at(-1).billing.total - 14) < 1e-9);
    await frame.waitForFunction(time => ['codex', 'claude'].every(id => [...document.querySelectorAll('[data-series="' + id + '-credit"]')].some(node => node.__data__?.at(-1)?.time === time && Math.abs(node.__data__.at(-1).y - 14) < 1e-9)), billFixture.now);
    assert.deepEqual(await geometry(), beforeBasis); assert.equal(await frame.locator('#ua-credit-mode option[value=estimate]').isDisabled(), true);
    await workbench.screenshot({path: path.join(root, 'screenshots/credit-basis-native.png')});
    result.creditBasis = {persisted: true, officialMonthly: 100, geometryUnchanged: true, billingAxis: true, officialCodexCreditUsd: .04, positiveCodexBillingRendered: true};
    await frame.locator('#ua-credit-subscription').check();
    for (let i = 0; i < 40 && vscode.workspace.getConfiguration('usageAtlas').get('creditBasis') !== 'subscription'; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(vscode.workspace.getConfiguration('usageAtlas').get('creditBasis'), 'subscription');

    const mixedCreditFixture = structuredClone(creditFixture);
    mixedCreditFixture.capacities = mixedCreditFixture.capacities.filter(c => c.provider === 'codex');
    for (const r of mixedCreditFixture.records) {
      if (r.provider === 'claude') r.spentUsd = 0;
      else r.creditBalance = [1000, 1000, 500, 250, 0][Math.round((r.time - (creditFixture.now - 240000)) / 60000)];
    }
    const mixedCreditModel = creditEngine.buildConversion(mixedCreditFixture);
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl'); await fs.writeFile(file + '.mixed.tmp', jsonl(mixedCreditFixture.records)); await fs.rename(file + '.mixed.tmp', file);
      await fs.writeFile(path.join(api.storagePath, 'metadata.json'), JSON.stringify({...metadata, capacities: mixedCreditFixture.capacities}));
      await fs.writeFile(automaticPath + '.mixed', JSON.stringify(mixedCreditModel)); await fs.rename(automaticPath + '.mixed', automaticPath);
    });
    await vscode.commands.executeCommand('usageAtlas.open');
    await frame.locator('#ua-credit-mode').selectOption('money');
    await frame.waitForFunction(() => {
      const svg = document.getElementById('ua-chart');
      return +svg?.dataset.yMax > 200 && svg.dataset.yMax === svg.dataset.yUnscaledMax;
    });
    const nativeMixed = api.snapshot();
    assert.equal(nativeMixed.data.claude.windows.five.at(-1).cumulativeKnown, false);
    assert.equal(nativeMixed.data.claude.windows.five.at(-1).credit.total, 0);
    await frame.locator('#ua-nav-pan').focus();
    for (let i = 0; i < 10; i++) await frame.locator('#ua-nav-pan').press('+');
    await workbench.screenshot({path: path.join(root, 'screenshots/cumulative-credit-axis-native.png')});
    await frame.locator('#ua-nav-pan').press('Home');
    await frame.locator('#ua-credit-mode').selectOption('estimate');
    await frame.waitForFunction(() => {
      const svg = document.getElementById('ua-chart');
      return svg?.dataset.yMax === svg?.dataset.yUnscaledMax && document.getElementById('ua-credit-mode').value === 'estimate';
    });
    const claudeMixed = await frame.locator('[data-series="claude-five"]').last().evaluate(node => node.__data__.at(-1).y);
    assert.equal(claudeMixed, 10);
    result.cumulativeCreditAxes = {calibratedAndRaw: true, sharedNumericSpacing: true, nativeAndAdditive: true, zeroUsdPreserved: true};

    await frame.locator('#ua-credit').uncheck();
    const gapNow = Date.now(), gapHour = 3600000, gapStart = gapNow - 8 * gapHour;
    const gapRecords = ['codex', 'claude'].flatMap(provider => [[0, 10, 5], [.1, 20, 5], [7, 2, 12], [7.1, 3, 12]].map(([hours, used, reset]) => ({
        v: 1, provider, account: hash(provider), plan: 'native-gap', source: 'import', time: gapStart + hours * gapHour
      , windows: Object.fromEntries(['five', 'week'].map(w => [w, {used, reset: gapStart + reset * gapHour}]))
    }))).sort((a, b) => a.time - b.time);
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl'); await fs.writeFile(file + '.gap.tmp', jsonl(gapRecords)); await fs.rename(file + '.gap.tmp', file);
    });
    await vscode.commands.executeCommand('usageAtlas.open');
    await frame.waitForFunction(() => ['codex-five', 'codex-week', 'claude-five', 'claude-week'].every(key => document.querySelector('[data-interpolated="' + key + '"]')));
    for (const id of ['codex', 'claude']) assert.equal(api.snapshot().data[id].windows.five.at(-1).nativeCumulative, 13);
    await workbench.screenshot({path: path.join(root, 'screenshots/cumulative-gap-native.png')});
    await frame.locator('#ua-mode').selectOption('usage');
    await frame.waitForFunction(() => !document.querySelector('[data-interpolated]'));
    result.cumulativeGaps = {bothProviders: true, bothWindows: true, resetSpanningEstimates: true, actualTotalsPreserved: true, usageStillDisconnected: true};

    await frame.locator('#ua-mode').selectOption('usage'); await frame.locator('#ua-credit').uncheck();
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
    const forecastNow = Date.now();
    const forecastRecords = ['codex', 'claude'].flatMap(provider => Array.from({length: 61}, (_, i) => ({v: 1, provider, account: hash(provider), plan: 'native-forecast', source: 'import', time: forecastNow - (60 - i) * 60000, windows: {five: {used: 20 + i / 2, reset: forecastNow + 18000000}, week: {used: 20 + i / 4, reset: forecastNow + 604800000}}})));
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl'); await fs.writeFile(file + '.forecast.tmp', jsonl(forecastRecords)); await fs.rename(file + '.forecast.tmp', file);
    });
    await cfg.update('forecastEnabled', true, vscode.ConfigurationTarget.Global); await api.refresh();
    await frame.waitForFunction(() => document.querySelectorAll('[data-forecast]').length === 4);
    const forecastSnapshot = api.snapshot(); assert.equal(forecastSnapshot.data.codex.forecast.five.state, 'predicted');
    assert.equal(await frame.locator('[data-forecast-trend]').count(), 4);
    await workbench.mouse.move(10, 10); await workbench.locator('.statusbar-item').filter({hasText: /Usage/}).hover();
    const forecastHover = workbench.locator('.monaco-hover').filter({has: workbench.locator('img[alt="AI 서비스별 최근 5시간 사용률"]')});
    try {await forecastHover.waitFor({state: 'visible', timeout: 8000});} catch (error) {
      await workbench.screenshot({path: path.join(root, 'screenshots/native-hover-failure.png')});
      await fs.writeFile(path.join(root, 'test-native-hover-debug.json'), JSON.stringify(await workbench.evaluate(() => ({hovers: [...document.querySelectorAll('.monaco-hover')].map(n => n.outerHTML), status: [...document.querySelectorAll('.statusbar-item')].filter(n => n.textContent.includes('Usage')).map(n => n.outerHTML), imgs: [...document.querySelectorAll('img')].map(n => ({alt: n.alt, src: n.src.slice(0, 90)}))})), null, 2)); throw error;
    }
    assert.match(await forecastHover.textContent(), /사용 가능 ≈/); assert.equal(await forecastHover.locator('tbody tr').count(), 2);
    const forecastImage = forecastHover.locator('img[alt="AI 서비스별 최근 5시간 사용률"]'); await forecastImage.evaluate(n => n.decode());
    assert.equal(await forecastImage.evaluate(n => n.naturalWidth), 360); assert.equal(await forecastImage.evaluate(n => n.naturalHeight), 192);
    await forecastHover.screenshot({path: path.join(root, 'screenshots/forecast-preview-native.png')});
    result.forecast = {pageMarkers: 4, trendPaths: 4, previewRemainingTime: true, previewRows: 2, imageWidth: 360, imageHeight: 192};
    await workbench.mouse.move(10, 10);
    for (const row of forecastRecords) if (row.provider === 'claude') for (const w of ['five', 'week']) row.windows[w].reset = forecastNow + 1800000;
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl'); await fs.writeFile(file + '.forecast.tmp', jsonl(forecastRecords)); await fs.rename(file + '.forecast.tmp', file);
    });
    await api.refresh(); await frame.waitForFunction(() => document.querySelectorAll('[data-forecast-boundary]').length === 2);
    await workbench.locator('.statusbar-item').filter({hasText: /Usage/}).hover(); await forecastHover.waitFor({state: 'visible'});
    assert.match(await forecastHover.textContent(), /사용 가능 ≈/);
    assert.match(await forecastHover.locator('tbody tr').nth(1).textContent(), /초기화 잔여 ≈35%.*초기화 잔여 ≈57.5%/);
    assert.doesNotMatch(await forecastHover.textContent(), /초기화 우선|만료 우선|소진 도달/);
    const tableFit = await forecastHover.locator('table').evaluate(table => ({width: table.getBoundingClientRect().width, overflow: [...table.querySelectorAll('td')].some(cell => cell.scrollWidth > cell.clientWidth + 1)}));
    assert.ok(tableFit.width <= 362); assert.equal(tableFit.overflow, false);
    await forecastImage.evaluate(n => n.decode()); await forecastHover.screenshot({path: path.join(root, 'screenshots/forecast-preview-outcomes-native.png')});
    result.forecast.previewResetRemainders = [35, 57.5]; result.forecast.tableWidth = tableFit.width; result.forecast.tableOverflow = false;
    await workbench.mouse.move(10, 10);
    const patternAnchor = Date.now();
    const patternRecords = ['codex', 'claude'].flatMap(id => require('./pattern-fixture.cjs').records(patternAnchor, id).map(r => {
      const shift = r.time < patternAnchor - 10 * 86400000 ? 10 * 86400000 : r.time < patternAnchor - 2 * 86400000 ? 4 * 86400000 : 0;
      return {...r, time: r.time + shift, windows: Object.fromEntries(['five', 'week'].map(w => [w, {...r.windows[w], reset: r.windows[w].reset + shift}]))};
    }));
    for (const id of ['codex', 'claude']) {
      const base = patternRecords.find(row => row.provider === id), time = patternAnchor - 60 * 86400000;
      patternRecords.push({...base, time, windows: {five: {used: 5, reset: time + 18000000}, week: {used: 5, reset: time + 604800000}}});
    }
    await new Store(api.storagePath).withLock(async () => {
      const file = path.join(api.storagePath, 'history.jsonl'); await fs.writeFile(file + '.pattern.tmp', jsonl(patternRecords)); await fs.rename(file + '.pattern.tmp', file);
    });
    await cfg.update('forecastPatternDays', 21, vscode.ConfigurationTarget.Global);
    await cfg.update('forecastPatternTimeZone', 'Asia/Seoul', vscode.ConfigurationTarget.Global); await api.refresh();
    await frame.waitForFunction(() => [...document.querySelectorAll('[data-forecast-trend]')].length === 4 && [...document.querySelectorAll('[data-forecast-trend]')].every(n => n.__data__.points.length > 2));
    assert.equal(api.snapshot().data.codex.forecast.five.pattern.days, 21);
    assert.ok(api.snapshot().data.codex.forecast.five.pattern.tierMatchedMs.dayType + api.snapshot().data.codex.forecast.five.pattern.tierMatchedMs.hour > 0);
    await workbench.locator('.statusbar-item').filter({hasText: /Usage/}).hover(); await forecastHover.waitFor({state: 'visible'});
    assert.match(await forecastHover.textContent(), /사용 가능 ≈/);
    await forecastHover.screenshot({path: path.join(root, 'screenshots/forecast-pattern-preview-native.png')});
    await workbench.mouse.move(10, 10); await cfg.update('forecastPatternDays', 0, vscode.ConfigurationTarget.Global);
    await frame.waitForFunction(() => [...document.querySelectorAll('[data-forecast-trend]')].length === 4 && [...document.querySelectorAll('[data-forecast-trend]')].every(n => n.__data__.points.length === 2));
    assert.equal(api.snapshot().data.codex.forecast.five.pattern, undefined);
    await cfg.update('forecastPatternDays', 21, vscode.ConfigurationTarget.Global);
    await cfg.update('forecastPatternTimeZone', 'UTC', vscode.ConfigurationTarget.Global);
    assert.equal(api.snapshot().data.claude.forecast.week.pattern.timeZone, 'UTC');
    const forecastRawBefore = await fs.readFile(path.join(api.storagePath, 'history.jsonl'));
    for (let i = 0; i < 3 && !api.snapshot().data.codex.forecast.five.calibration; i++) await api.maintainForecast();
    const fitted = api.forecastLearningStatus().model; assert.ok(fitted?.providers?.codex?.five); assert.ok(api.forecastLearningStatus().patternCells > 0);
    assert.ok(forecastRawBefore.equals(await fs.readFile(path.join(api.storagePath, 'history.jsonl'))));
    for (const provider of Object.values(fitted.providers)) for (const value of Object.values(provider)) {value.method = 'seasonal'; value.errors = [{hours: 1, samples: 12, dates: 3, low: -8, high: 12}];}
    const forecastFile = path.join(api.storagePath, 'forecast-learning.json'); await fs.writeFile(forecastFile + '.fixture', JSON.stringify(fitted)); await fs.rename(forecastFile + '.fixture', forecastFile);
    await vscode.commands.executeCommand('usageAtlas.open');
    await frame.waitForFunction(() => document.querySelectorAll('[data-forecast-range]').length === 4);
    await frame.locator('#ua-nav-pan').focus(); for (let i = 0; i < 8; i++) await frame.locator('#ua-nav-pan').press('+');
    assert.ok(await frame.locator('[data-forecast-range]').first().evaluate(node => node.getAttribute('aria-label').includes('신뢰구간이 아닙니다')));
    await workbench.screenshot({path: path.join(root, 'screenshots/forecast-pattern-range-native.png')});
    await frame.locator('#ua-nav-pan').press('Home');
    result.forecast.learning = {backgroundWorker: true, empiricalRangePaths: 4, rawUnchanged: true, archiveCells: api.forecastLearningStatus().patternCells};
    result.forecast.pattern = {days: 21, providers: 2, quotaWindows: 2, piecewiseCurves: true, shortHistoryTiers: true, livePeriodDisable: true, explicitTimeZone: true};
    await cfg.update('chartHistoryDays', 30, vscode.ConfigurationTarget.Global);
    await frame.waitForFunction(() => {const node = document.getElementById('ua-chart'); return Math.abs(Number(node.dataset.domainEnd) - Number(node.dataset.domainStart) - 37 * 86400000) < 100;});
    assert.equal(api.snapshot().chartHistoryDays, 30);
    await cfg.update('chartHistoryDays', 90, vscode.ConfigurationTarget.Global);
    await frame.waitForFunction(start => Number(document.getElementById('ua-chart').dataset.extentStart) === start, patternAnchor - 60 * 86400000);
    result.historyRange = {configuredPastDays: 30, futureDays: 7, oldestAvailableDays: 60, clampedToStoredHistory: true};
    await workbench.mouse.move(10, 10); await cfg.update('forecastEnabled', false, vscode.ConfigurationTarget.Global);
    await frame.waitForFunction(() => document.querySelectorAll('[data-forecast]').length === 0);
    assert.equal(api.snapshot().data.codex.forecast, undefined); assert.equal(await frame.locator('[data-forecast-trend]').count(), 0); result.forecast.settingOff = true;
    await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
    const agNow = Date.now(), ag = require('../src/antigravity.cjs');
    const agRows = [-60000, 0].flatMap(offset => ag.snapshots({response: {groups: [{displayName: 'Gemini Models', buckets: [
        {bucketId: 'gemini-5h', window: '5h', remainingFraction: .8 + (offset ? .01 : 0), resetTime: new Date(agNow + 3600000).toISOString()}
      , {bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: .6 + (offset ? .01 : 0), resetTime: new Date(agNow + 86400000).toISOString()}
    ]}]}}, {account: hash('native-google'), plan: 'g1-pro-tier'}, agNow + offset));
    await new Store(api.storagePath).withLock(() => new Store(api.storagePath).commit(agRows));
    await vscode.commands.executeCommand('usageAtlas.open');
    const agId = agRows[0].provider;
    await frame.waitForFunction(id => !!document.getElementById('ua-' + id), agId);
    await frame.locator('#ua-' + agId).click();
    await frame.waitForFunction(id => document.getElementById('usage-atlas').dataset.focusedProvider === id, agId);
    assert.ok(await frame.locator('[data-series="' + agId + '-week"]').count());
    await frame.locator('[data-details-line="' + agId + '-week"]').first().focus(); await workbench.keyboard.press('Enter');
    await frame.waitForFunction(() => document.getElementById('ua-panel-report').textContent.includes('사용률 관측'));
    assert.ok(await frame.locator('#ua-panel-report').textContent().then(text => text.includes('호출·토큰·대화')));
    assert.equal(await frame.locator('#ua-details-filters').isVisible(), false);
    await frame.locator('#ua-details-close').click();
    await workbench.mouse.move(10, 10); await workbench.locator('.statusbar-item').filter({hasText: /Usage/}).hover(); await forecastHover.waitFor({state: 'visible'});
    assert.match(await forecastHover.textContent(), /Antigravity.*Gemini/); assert.equal(await forecastHover.locator('tbody tr').count(), 3);
    await forecastImage.evaluate(n => n.decode()); assert.equal(await forecastImage.evaluate(n => n.naturalWidth), 360);
    await forecastHover.screenshot({path: path.join(root, 'screenshots/antigravity-preview-native.png')});
    result.antigravity = {nativeCspWebview: true, focus: true, previewRows: 3, independentWindows: true, providerRequests: 0};
    assert.equal(calls, 0, 'opening, graph details, settings and local indexing never request providers');
    result.providerRequests = calls; result.status = 'PASS';
  } catch (error) {result.status = 'FAIL'; result.error = error.stack; throw error;}
  finally {adapters.codex = original.codex; adapters.claude = original.claude; await cfg.update('enabled', false, vscode.ConfigurationTarget.Global); await fs.writeFile(path.join(root, 'test-analysis-host.json'), JSON.stringify(result, null, 2));}
};
