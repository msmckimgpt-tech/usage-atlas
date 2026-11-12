'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ag = require('../src/antigravity.cjs');
const {hash, sanitize, project, Store} = require('../src/core.cjs');
const catalog = require('../media/provider-visibility.js');
const {preview} = require('../src/hover.cjs');
const {selection} = require('../src/details-selection.cjs');
const {wakeDelay} = require('../src/schedule.cjs');
const {analyze} = require('../src/analytics.cjs');
const now = Date.now(), hour = 3600000, account = {account: hash('fixture-google'), plan: 'g1-pro-tier'};
const bucket = (id, window, remainingFraction, resetTime) => ({bucketId: id, window, remainingFraction, resetTime: new Date(resetTime).toISOString()});
const summary = () => ({response: {groups: [
    {displayName: 'Gemini Models', buckets: [bucket('gemini-5h', '5h', .8, now + hour), bucket('gemini-weekly', 'weekly', .5, now + 3 * 24 * hour)]}
  , {displayName: 'Claude and GPT models', buckets: [bucket('3p-5h', '5h', 1, now + 2 * hour), bucket('3p-weekly', 'weekly', .9, now + 5 * 24 * hour)]}
  , {displayName: 'Gemini 4 Argon', buckets: [bucket('argon-weekly', 'weekly', 0, now + 4 * 24 * hour)]}
]}});
const status = (email = 'fixture@example.invalid', plan = account.plan) => ({userStatus: {email, userTier: {id: plan}, apiKey: 'must-not-persist', profilePictureUrl: 'must-not-persist'}});
test.afterEach(() => ag.dispose());
test('official quota summary maps independent groups, exact reset windows and proto3 zero without guessing', () => {
  const data = ag.snapshots(summary(), account, now);
  assert.equal(data.length, 3); assert.equal(new Set(data.map(s => s.provider)).size, 3);
  assert.deepEqual(data.map(s => s.label), ['Gemini', 'Claude/GPT', 'Argon']);
  assert.equal(data[0].windows.five.used, 20); assert.equal(data[0].windows.week.used, 50);
  assert.equal(data[1].windows.five.used, 0); assert.equal(data[2].windows.five, null); assert.equal(data[2].windows.week.used, 100);
  const proto = summary(); delete proto.response.groups[0].buckets[0].remainingFraction;
  assert.equal(ag.snapshots(proto, account, now)[0].windows.five.used, 100);
  const reordered = summary(); reordered.response.groups.reverse(); reordered.response.groups[2].displayName = 'Renamed';
  assert.equal(ag.snapshots(reordered, account, now)[2].provider, data[0].provider);
  assert.throws(() => ag.snapshots({response: {groups: []}}, account), /한도 그룹/);
  const repeated = summary(); repeated.response.groups.push(repeated.response.groups[0]); assert.throws(() => ag.snapshots(repeated, account), /그룹이 중복/);
});
test('unknown windows, amounts and disabled quotas do not turn into fabricated percentages', () => {
  for (const mutation of [b => {b.window = 'daily';}, b => {b.remainingAmount = 123;}, b => {b.disabled = true;}, b => {b.remainingFraction = 1.1;}]) {
    const s = summary(); mutation(s.response.groups[0].buckets[0]); assert.equal(ag.snapshots(s, account)[0].windows.five, null);
  }
});
test('new group snapshots round trip without secrets, isolate accounts and preserve subscription traces with credits on', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-ag-')); t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const store = new Store(dir), first = ag.snapshots(summary(), account, now - 60000), second = ag.snapshots(summary(), account, now);
  second[0].windows.five.used = 25;
  await store.withLock(() => store.commit([...first, ...second]));
  const restored = await new Store(dir).read(); assert.equal(restored.length, 6); assert.equal(restored[0].label, 'Gemini');
  const data = project(restored), id = first[0].provider;
  assert.equal(data[id].windows.five.at(-1).delta, 5); assert.equal(data[id].ledgerAvailable, false);
  const chart = require('../media/chart-series.js');
  assert.equal(chart.quota(data[id], id, 'five', {credit: true, creditMode: 'estimate'})[0].points.at(-1).y, 25);
  const svg = preview(restored, {now, projection: data}); assert.equal(svg.summaries.length, 5); assert.equal(svg.summaries.find(s => s.name === 'Antigravity · Gemini').five, '25%');
  assert.match(svg.svg, /Antigravity · Gemini/); assert.match(svg.svg, new RegExp('data-series="' + id + '-five"'));
  assert.doesNotMatch(await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8'), /email|Token|apiKey|profilePicture/);
  const report = analyze({provider: id, account: account.account, window: 'five', start: now - 120000, end: now + 1, cursorTime: now, records: restored});
  assert.equal(report.summary.callCount, null); assert.equal(report.quotaOnly, true); assert.equal(report.observations.items[0].used, 25); assert.ok(report.coverage.notes.some(n => n.includes('Antigravity')));
  const scope = selection({provider: id, window: 'five', requestId: 'x', time: now, start: now - 120000, end: now + 1}, restored, 90, now);
  assert.equal(scope.account, account.account);
  const next = ag.snapshots(summary(), {account: hash('different'), plan: account.plan}, now + 1).slice(0, 1);
  assert.deepEqual(catalog.ids([...restored, ...next]), ['codex', 'claude', id]);
  assert.equal(project([...restored, ...next])[id].windows.five.length, 1);
  assert.throws(() => sanitize({...first[0], provider: 'antigravity-<script>'}));
});
test('collection is cached, read-only, account guarded and does not retain private response data', async () => {
  const methods = [], opts = {connection: async () => ({port: 12345, csrfToken: 'fixture-token-1234567890'}), cacheSeconds: 5, request: async (_e, method, body) => {methods.push(method); if (method === 'RetrieveUserQuotaSummary') {assert.deepEqual(body, {forceRefresh: true}); return summary();} return status();}};
  const a = await ag.collect('', undefined, opts), b = await ag.collect('', undefined, opts);
  assert.equal(methods.filter(m => m === 'RetrieveUserQuotaSummary').length, 1); assert.equal(a[0].time, b[0].time);
  assert.doesNotMatch(JSON.stringify(a), /fixture@example|apiKey|profilePicture|csrf/);
  b[0].windows.five.used = 99; assert.equal((await ag.collect('', undefined, opts))[0].windows.five.used, 20);
  ag.dispose(); let calls = 0;
  await assert.rejects(ag.collect('', undefined, {...opts, request: async (_e, m) => m === 'RetrieveUserQuotaSummary' ? summary() : status(++calls === 1 ? 'a@example.invalid' : 'b@example.invalid')}), /変更|변경/);
  await assert.rejects(ag.collect('', AbortSignal.abort(), opts), /취소/);
});
test('local RPC pins loopback, enforces method/size/time/abort limits and respects Retry-After', async t => {
  const server = http.createServer((req, res) => {
    if (req.headers['x-codeium-csrf-token'] !== 'fixture-token-1234567890') {res.writeHead(403); res.end(); return;}
    if (req.url.endsWith('/GetUserStatus')) {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(status()));}
    else {res.writeHead(429, {'Retry-After': '600'}); res.end('{}');}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = {port: server.address().port, csrfToken: 'fixture-token-1234567890'};
  assert.ok((await ag.request(endpoint, 'GetUserStatus')).userStatus);
  await assert.rejects(ag.request(endpoint, 'DeleteAllUserData'), /읽기 전용/);
  await assert.rejects(ag.request(endpoint, 'RetrieveUserQuotaSummary'), e => e.retryAfter === 600000);
  await assert.rejects(ag.request(endpoint, 'GetUserStatus', {}, {signal: AbortSignal.abort()}), /취소/);
  server.removeAllListeners('request'); server.on('request', (_req, res) => res.end('x'.repeat(1048577)));
  await assert.rejects(ag.request(endpoint, 'GetUserStatus'), /크기 제한/);
});
test('native daemon discovery rejects stale/ambiguous connections and does not execute a process', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-ag-discover-')); t.after(() => fs.rm(dir, {recursive: true, force: true})); await fs.mkdir(path.join(dir, 'daemon'));
  const daemon = port => fs.writeFile(path.join(dir, 'daemon', 'hub_' + port + '.json'), JSON.stringify({pid: process.pid, httpPort: port, csrfToken: 'fixture-token-1234567890'}));
  await daemon(12345); assert.equal((await ag.discover(dir)).port, 12345); await daemon(12346); await assert.rejects(ag.discover(dir), /여러 개/);
  assert.equal(wakeDelay({codex: {next: now + 60000}, claude: {next: now + 60000}, antigravity: {next: now + 10000}}, now, true, ['codex', 'claude', 'antigravity']), 10000);
});
