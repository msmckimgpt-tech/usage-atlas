'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const source = fs.readFileSync(path.join(__dirname, '../src/adapters.cjs'), 'utf8');
const NO_RESPONSE = Symbol('no-response');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function codexAuthFixture(accountId, subject, tokenVersion) {
  const claims = {sub: subject, email: 'first', exp: tokenVersion};
  const idToken = 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
  return JSON.stringify({auth_mode: 'chatgpt', tokens: {account_id: accountId, id_token: idToken, access_token: 'fixture-access-' + tokenVersion, refresh_token: 'fixture-refresh-' + tokenVersion}, last_refresh: tokenVersion});
}
function fixture(options = {}) {
  let now = 1000000, account = 'first', token = 'test-token', auth = 'auth-first', expiresAt = 9999999999, profileTheme = 'dark';
  const children = [], methods = [], http = [], agents = [];
  const timers = new Map(); let timerId = 0;
  const schedule = options.fakeTimers ? (callback, delay) => {
    const handle = {id: ++timerId, unref() {}};
    timers.set(handle, {callback, due: now + delay}); return handle;
  } : setTimeout;
  const unschedule = options.fakeTimers ? handle => timers.delete(handle) : clearTimeout;
  const quota = {rateLimits: {primary: {usedPercent: 5, windowDurationMins: 300, resetsAt: 2000}}};
  const fixtureFs = {readFile: async file => {
    const name = path.basename(file);
    if (name === 'auth.json') return auth;
    if (name === '.credentials.json') return JSON.stringify({claudeAiOauth: {accessToken: token, expiresAt}});
    if (name === '.claude.json') return JSON.stringify({oauthAccount: {accountUuid: account}, theme: profileTheme});
    throw new Error('unexpected read');
  }};
  const spawn = (...args) => {
    const child = new EventEmitter(); child.args = args; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new EventEmitter(); child.killed = false;
    child.stdin.end = () => {};
    child.kill = () => {child.killed = true; queueMicrotask(() => child.emit('exit', 0));};
    child.stdin.write = line => {
      const message = JSON.parse(line); methods.push(message);
      if (!Object.hasOwn(message, 'id')) return true;
      queueMicrotask(async () => {
        let response = options.onRpc ? await options.onRpc(message, child, api) : undefined;
        if (response === NO_RESPONSE) return;
        response ??= message.method === 'account/read' ? {account: {type: 'chatgpt', email: account}} : message.method === 'account/rateLimits/read' ? quota : {};
        child.stdout.emit('data', Buffer.from(JSON.stringify(response?.rpcError ? {id: message.id, error: response.rpcError} : {id: message.id, result: response}) + '\n'));
      });
      return true;
    };
    children.push(child); return child;
  };
  class FakeDate extends Date {static now() {return now;}}
  class Agent {constructor() {agents.push(this);} destroy() {this.destroyed = true;}}
  const requestJson = async (url, config) => {
    http.push({url, config});
    if (options.requestJson) return options.requestJson(url, config, api);
    return {five_hour: {utilization: 5, resets_at: '2026-11-01T00:00:00Z'}};
  };
  const module = {exports: {}}, core = require('../src/core.cjs');
  const dependencies = {
    'node:fs/promises': fixtureFs
  , 'node:child_process': {spawn}
  , 'node:os': {homedir: () => '/virtual-home'}
  , 'node:https': {Agent}
  , './core.cjs': {codexSnapshot: (data, account) => core.codexSnapshot(data, account, now), claudeSnapshot: (data, identity, plan) => core.claudeSnapshot(data, identity, plan, now)}
  , './http.cjs': {requestJson}
  };
  const api = {
    children, methods, http, agents
  , setAccount: value => {account = value;}
  , setToken: value => {token = value;}
  , setProfileTheme: value => {profileTheme = value;}
  , setAuth: value => {auth = value;}
  , setExpiry: value => {expiresAt = value;}
  , setTime: value => {now = value;}
  , advanceTime: ms => {
      now += ms;
      for (const [handle, timer] of timers) if (timer.due <= now) {timers.delete(handle); timer.callback();}
    }
  };
  vm.runInNewContext(source, {
    module, require: name => dependencies[name] || require(name), __dirname: path.join(__dirname, '../src')
  , process: {platform: options.platform || 'linux', env: {CODEX_HOME: '/virtual-codex'}}
  , Buffer, Date: FakeDate, performance, structuredClone, setTimeout: schedule, clearTimeout: unschedule
  });
  api.adapters = module.exports; return api;
}
test('on-demand remains default, uses readonly guarded RPC and retires every child', async () => {
  const f = fixture({platform: 'win32'});
  try {
    await f.adapters.codex('official.exe'); await f.adapters.codex('official.exe');
    assert.equal(f.children.length, 2); assert.ok(f.children.every(c => c.killed));
    assert.equal(f.children[0].args[2].windowsHide, true); assert.equal(f.children[0].args[2].shell, false);
    assert.match(f.children[0].args[0], /collector-host\.exe$/);
    assert.deepEqual(f.methods.filter(m => m.id).map(m => m.method), ['initialize', 'account/read', 'account/rateLimits/read', 'account/read', 'initialize', 'account/read', 'account/rateLimits/read', 'account/read']);
    assert.ok(f.methods.filter(m => m.method === 'account/read').every(m => m.params.refreshToken === false));
    assert.equal(f.adapters.getDiagnostics('codex').connection, 'onDemand');
  } finally {f.adapters.dispose();}
});
test('opt-in persistent session reuses one process and emits no idle RPC or keepalive', async () => {
  const f = fixture();
  try {
    await f.adapters.codex('official', undefined, {persistent: true});
    await f.adapters.codex('official', undefined, {persistent: true});
    const count = f.methods.length; await sleep(20);
    assert.equal(f.children.length, 1); assert.equal(f.children[0].killed, false);
    assert.equal(f.methods.length, count);
    assert.equal(f.methods.filter(m => m.method === 'account/rateLimits/read').length, 2);
    assert.equal(f.adapters.getDiagnostics('codex').connection, 'persistent');
  } finally {f.adapters.dispose();}
  assert.ok(f.children[0].killed);
});
test('host TTL retains one persistent child across active 60-second and idle 240-second intervals', async () => {
  for (const [intervalMs, ttlMs] of [[60000, 70000], [240000, 250000]]) {
    const f = fixture({fakeTimers: true}), options = {persistent: true, idleTtlMs: ttlMs};
    try {
      await f.adapters.codex('official', undefined, options);
      const count = f.methods.length;
      f.advanceTime(intervalMs);
      assert.equal(f.children[0].killed, false); assert.equal(f.methods.length, count, 'idle time sends no RPC');
      await f.adapters.codex('official', undefined, options);
      assert.equal(f.children.length, 1);
      assert.equal(f.methods.filter(m => m.method === 'account/rateLimits/read').length, 2);
      f.advanceTime(ttlMs - 1); assert.equal(f.children[0].killed, false);
      f.advanceTime(1); assert.equal(f.children[0].killed, true);
    } finally {f.adapters.dispose();}
  }
});
test('persistent TTL keeps the omitted 60-second default and caps explicit retention at 300 seconds', async () => {
  for (const [options, ttlMs] of [[{persistent: true}, 60000], [{persistent: true, idleTtlMs: 999999}, 300000]]) {
    const f = fixture({fakeTimers: true});
    try {
      await f.adapters.codex('official', undefined, options);
      f.advanceTime(ttlMs - 1); assert.equal(f.children[0].killed, false);
      f.advanceTime(1); assert.equal(f.children[0].killed, true);
    } finally {f.adapters.dispose();}
  }
});
test('optional on-demand cache avoids launches, preserves source time and invalidates changed credentials', async () => {
  const f = fixture(), metrics = [];
  try {
    const first = await f.adapters.codex('official', undefined, {cacheSeconds: 5, onMetrics: m => metrics.push(m)});
    first.windows.five.used = 99;
    const next = await f.adapters.codex('official', undefined, {cacheSeconds: 5});
    assert.equal(next.windows.five.used, 5);
    assert.equal(next.time, first.time); assert.equal(next.fetchedAt, first.time);
    assert.equal(next.cached, true); assert.equal(next.freshSource, false); assert.equal(f.children.length, 1);
    f.setAuth('auth-second');
    assert.equal((await f.adapters.codex('official', undefined, {cacheSeconds: 5})).cached, false);
    assert.equal(f.children.length, 2);
    const diagnostic = f.adapters.getDiagnostics('codex'); diagnostic.cacheHit = true;
    assert.equal(f.adapters.getDiagnostics('codex').cacheHit, false);
    assert.deepEqual(Object.keys(metrics[0]).sort(), ['cacheHit', 'connection', 'fetchMs']);
  } finally {f.adapters.dispose();}
});
test('metricsEnabled false clears retained diagnostics and suppresses callbacks for fresh and cached reads', async () => {
  const f = fixture(); let callbacks = 0;
  const enabled = {cacheSeconds: 5, onMetrics: () => {callbacks++;}};
  const disabled = {...enabled, metricsEnabled: false};
  try {
    await f.adapters.codex('official', undefined, enabled);
    await f.adapters.claude('/virtual', undefined, enabled);
    assert.ok(f.adapters.getDiagnostics('codex')); assert.ok(f.adapters.getDiagnostics('claude')); assert.equal(callbacks, 2);
    const codexCached = await f.adapters.codex('official', undefined, disabled);
    const claudeCached = await f.adapters.claude('/virtual', undefined, disabled);
    assert.equal(codexCached.cached, true); assert.equal(claudeCached.cached, true);
    assert.equal(f.adapters.getDiagnostics('codex'), null); assert.equal(f.adapters.getDiagnostics('claude'), null);
    await f.adapters.codex('official', undefined, {...disabled, cacheSeconds: 0, persistent: true});
    await f.adapters.claude('/virtual', undefined, {...disabled, cacheSeconds: 0});
    assert.equal(f.adapters.getDiagnostics('codex'), null); assert.equal(f.adapters.getDiagnostics('claude'), null); assert.equal(callbacks, 2);
    await f.adapters.codex('official', undefined, enabled); assert.ok(f.adapters.getDiagnostics('codex')); assert.equal(callbacks, 3);
  } finally {f.adapters.dispose();}
});
test('persistent cache guards account each time, and factory refuses non-readonly RPC', async () => {
  const f = fixture();
  try {
    const session = f.adapters.createCodexSession('official', {cacheSeconds: 5});
    const first = await session.read(); const next = await session.read();
    assert.equal(next.cached, true); assert.equal(next.time, first.time);
    assert.equal(f.methods.filter(m => m.method === 'account/rateLimits/read').length, 1);
    assert.equal(f.methods.filter(m => m.method === 'account/read').length, 4);
    await assert.rejects(session.send('thread/start', {}), /읽기 전용/);
    await assert.rejects(session.send('account/read', {refreshToken: true}), /읽기 전용/);
  } finally {f.adapters.dispose();}
});
test('both provider caches expire at five seconds and reject a backwards clock', async () => {
  const f = fixture();
  try {
    const options = {cacheSeconds: 5};
    await f.adapters.codex('official', undefined, options); await f.adapters.claude('/virtual', undefined, options);
    f.setTime(1004999);
    assert.equal((await f.adapters.codex('official', undefined, options)).cached, true);
    assert.equal((await f.adapters.claude('/virtual', undefined, options)).cached, true);
    f.setTime(1005000);
    assert.equal((await f.adapters.codex('official', undefined, options)).cached, false);
    assert.equal((await f.adapters.claude('/virtual', undefined, options)).cached, false);
    f.setTime(1000000);
    assert.equal((await f.adapters.codex('official', undefined, options)).cached, false);
    assert.equal((await f.adapters.claude('/virtual', undefined, options)).cached, false);
    assert.equal(f.children.length, 3); assert.equal(f.http.length, 3);
  } finally {f.adapters.dispose();}
});
test('account switch during quota RPC discards result and destroys owned child', async () => {
  const f = fixture({onRpc: (m, child, api) => {if (m.method === 'account/rateLimits/read') api.setAccount('second');}});
  try {await assert.rejects(f.adapters.codex('official', undefined, {persistent: true}), /계정이 변경/); assert.ok(f.children[0].killed);}
  finally {f.adapters.dispose();}
});
test('account notifications and credential changes during RPC invalidate the result', async () => {
  for (const change of ['notification', 'credentials']) {
    const f = fixture({onRpc: (m, child, api) => {
      if (m.method === 'account/rateLimits/read') {
        if (change === 'credentials') api.setAuth('changed');
        else child.stdout.emit('data', Buffer.from(JSON.stringify({method: 'account/updated', params: {authMode: null}}) + '\n'));
      }
    }});
    try {await assert.rejects(f.adapters.codex('official'), /계정이 변경/); assert.ok(f.children[0].killed);}
    finally {f.adapters.dispose();}
  }
});
test('property order, plan changes and same-mode account notifications do not imply an identity switch', async () => {
  let reads = 0, observed;
  const f = fixture({onRpc: (m, child) => {
    if (m.method === 'account/read') {
      reads++;
      return {account: reads % 2 ? {type: 'chatgpt', email: 'same', planType: 'unknown'} : {planType: 'pro', email: 'same', type: 'chatgpt'}};
    }
    if (m.method === 'account/rateLimits/read') {
      child.stdout.emit('data', Buffer.from(JSON.stringify({method: 'account/updated', params: {authMode: 'chatgpt', planType: 'pro'}}) + '\n'));
      child.stdout.emit('data', Buffer.from(JSON.stringify({method: 'account/rateLimits/updated', params: {}}) + '\n'));
    }
  }});
  try {
    const snapshot = await f.adapters.codex('official', undefined, {onGuardCheck: value => {observed = value;}});
    assert.equal(snapshot.plan, 'pro');
    assert.equal(observed.accountObjectChanged, true); assert.equal(observed.accountNotificationObserved, true);
    assert.equal(observed.accountIdentityChanged, false); assert.equal(observed.authTransitionObserved, false); assert.equal(observed.authFileChanged, false);
    assert.ok(Object.values(observed).every(value => typeof value === 'boolean'));
  } finally {f.adapters.dispose();}
});
test('same-mode account notification alone reproduces the WSL false positive without changing identity or auth', async () => {
  let observed;
  const f = fixture({onRpc: (m, child) => {
    if (m.method === 'account/rateLimits/read') child.stdout.emit('data', Buffer.from(JSON.stringify({method: 'account/updated', params: {authMode: 'chatgpt'}}) + '\n'));
  }});
  try {
    const snapshot = await f.adapters.codex('official', undefined, {onGuardCheck: value => {observed = value;}});
    assert.equal(snapshot.freshSource, true); assert.equal(snapshot.cached, false);
    assert.equal(observed.accountNotificationObserved, true);
    for (const key of ['accountObjectChanged', 'accountIdentityChanged', 'authTransitionObserved', 'authFileChanged']) assert.equal(observed[key], false);
  } finally {f.adapters.dispose();}
});
test('same-email account ID changes and transient logout notifications still reject attribution', async () => {
  for (const change of ['account-id', 'logout']) {
    let reads = 0;
    const f = fixture({onRpc: (m, child) => {
      if (m.method === 'account/read') {reads++; return {account: {type: 'chatgpt', email: 'same', accountId: change === 'account-id' && reads === 2 ? 'second' : 'first'}};}
      if (m.method === 'account/rateLimits/read' && change === 'logout') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({method: 'account/updated', params: {authMode: null}}) + '\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({method: 'account/updated', params: {authMode: 'chatgpt'}}) + '\n'));
      }
    }});
    try {
      await assert.rejects(f.adapters.codex('official'), error => {
        assert.equal(error.guardReasons.accountIdentityChanged, change === 'account-id');
        assert.equal(error.guardReasons.authTransitionObserved, change === 'logout'); return true;
      });
      assert.ok(f.children[0].killed);
    } finally {f.adapters.dispose();}
  }
});
test('concurrent token rotation for the same verified identity does not discard fresh quota', async () => {
  let observed;
  const f = fixture({onRpc: (m, child, api) => {
    if (m.method === 'account/rateLimits/read') api.setAuth(codexAuthFixture('workspace-first', 'user-first', 2));
  }});
  f.setAuth(codexAuthFixture('workspace-first', 'user-first', 1));
  try {
    const snapshot = await f.adapters.codex('official', undefined, {onGuardCheck: value => {observed = value;}});
    assert.equal(snapshot.freshSource, true); assert.equal(observed.authFileChanged, true);
    assert.equal(observed.accountIdentityChanged, false); assert.equal(observed.authIdentityChanged, false); assert.equal(observed.authIdentityUnverified, false);
    assert.ok(Object.values(observed).every(value => typeof value === 'boolean'));
  } finally {f.adapters.dispose();}
});
test('concurrent workspace or subject switches remain rejected even when RPC email is unchanged', async () => {
  for (const change of ['workspace', 'subject', 'unknown']) {
    const f = fixture({onRpc: (m, child, api) => {
      if (m.method === 'account/rateLimits/read') api.setAuth(change === 'unknown' ? '{}' : codexAuthFixture(change === 'workspace' ? 'workspace-second' : 'workspace-first', change === 'subject' ? 'user-second' : 'user-first', 2));
    }});
    f.setAuth(codexAuthFixture('workspace-first', 'user-first', 1));
    try {
      await assert.rejects(f.adapters.codex('official'), error => {
        assert.equal(error.guardReasons.accountIdentityChanged, false);
        assert.equal(error.guardReasons.authFileChanged, true);
        assert.equal(error.guardReasons.authIdentityChanged, change !== 'unknown');
        assert.equal(error.guardReasons.authIdentityUnverified, change === 'unknown'); return true;
      });
      assert.ok(f.children[0].killed);
    } finally {f.adapters.dispose();}
  }
});
test('conservative invalidation reports an enum and boolean equality without private values', async () => {
  for (const change of ['account', 'logout', 'auth', 'unknown']) {
    let observed;
    const f = fixture({onRpc: (m, child, api) => {
      if (m.method === 'account/rateLimits/read') {
        if (change === 'account') api.setAccount('second');
        if (change === 'logout') child.stdout.emit('data', Buffer.from(JSON.stringify({method: 'account/updated', params: {authMode: null}}) + '\n'));
        if (change === 'auth') api.setAuth(codexAuthFixture('workspace-second', 'user-second', 2));
        if (change === 'unknown') api.setAuth('{}');
      }
    }});
    f.setAuth(codexAuthFixture('workspace-first', 'user-first', 1));
    const expected = {account: 'account-identity-changed', logout: 'auth-transition', auth: 'auth-identity-changed', unknown: 'auth-identity-unverified'}[change];
    try {
      await assert.rejects(f.adapters.codex('official', undefined, {onInvalidation: value => {observed = value;}}), error => {
        assert.equal(error.invalidation.reason, expected); return true;
      });
      assert.equal(observed.reason, expected);
      assert.deepEqual(Object.keys(observed).sort(), ['beforeAfterEquality', 'reason']);
      assert.ok(Object.values(observed.beforeAfterEquality).every(value => typeof value === 'boolean'));
      assert.equal(observed.beforeAfterEquality.accountIdentityEqual, change !== 'account');
      assert.equal(observed.beforeAfterEquality.authFileEqual, change === 'account' || change === 'logout');
    } finally {f.adapters.dispose();}
  }
});
test('auth file change retires persistent connection and next call creates a clean child', async () => {
  const f = fixture();
  try {
    await f.adapters.codex('official', undefined, {persistent: true, cacheSeconds: 5}); f.setAuth('changed');
    const next = await f.adapters.codex('official', undefined, {persistent: true, cacheSeconds: 5});
    assert.equal(next.cached, false);
    assert.ok(f.children[0].killed);
    await f.adapters.codex('official', undefined, {persistent: true}); assert.equal(f.children.length, 2);
  } finally {f.adapters.dispose();}
});
test('UTF-8 output is bounded by bytes, including small complete notifications', async () => {
  const f = fixture({onRpc: (m, child) => {if (m.method === 'account/rateLimits/read') {child.stdout.emit('data', Buffer.from(('가'.repeat(1000) + '\n').repeat(350))); return NO_RESPONSE;}}});
  try {await assert.rejects(f.adapters.codex('official'), /응답 크기 제한/); assert.ok(f.children[0].killed);}
  finally {f.adapters.dispose();}
});
test('deadline, abort and idle TTL clean up the owned process', async () => {
  const hung = fixture({onRpc: () => NO_RESPONSE});
  try {await assert.rejects(hung.adapters.codex('official', undefined, {timeoutMs: 15}), /시간 초과/); assert.ok(hung.children[0].killed);}
  finally {hung.adapters.dispose();}
  const f = fixture(), controller = new AbortController();
  try {
    await f.adapters.codex('official', undefined, {persistent: true, idleTtlMs: 10}); await sleep(30); assert.ok(f.children[0].killed);
    controller.abort(); await assert.rejects(f.adapters.codex('official', controller.signal), /취소/);
    assert.equal(f.children.length, 1);
  } finally {f.adapters.dispose();}
});
test('serial queue is bounded and does not launch concurrent Codex children', async () => {
  const f = fixture({onRpc: () => NO_RESPONSE});
  const pending = Array.from({length: 6}, () => f.adapters.codex('official', undefined, {timeoutMs: 15}));
  const result = await Promise.allSettled(pending);
  assert.equal(result.filter(r => r.status === 'rejected' && /대기 수 제한/.test(r.reason.message)).length, 2);
  assert.equal(f.children.length, 4); assert.ok(f.children.every(c => c.killed)); f.adapters.dispose();
});
test('abort during RPC and dispose during Claude HTTP cannot publish a stale result', async () => {
  const controller = new AbortController();
  const f = fixture({onRpc: m => {if (m.method === 'account/rateLimits/read') {controller.abort(); return NO_RESPONSE;}}});
  try {await assert.rejects(f.adapters.codex('official', controller.signal), /취소/); assert.ok(f.children[0].killed);}
  finally {f.adapters.dispose();}
  let release;
  const g = fixture({requestJson: () => new Promise(resolve => {release = resolve;})});
  const request = g.adapters.claude('/virtual');
  while (!release) await sleep(1);
  g.adapters.dispose(); release({});
  await assert.rejects(request, /취소/); assert.equal(g.adapters.getDiagnostics('claude'), null);
});
test('RPC backoff prevents another launch, including after dispose', async () => {
  const f = fixture({onRpc: m => m.method === 'account/rateLimits/read' ? {rpcError: {code: 429, data: {retryAfterMs: 600000}}} : undefined});
  await assert.rejects(f.adapters.codex('official'), e => e.retryAfter === 600000);
  f.adapters.dispose();
  await assert.rejects(f.adapters.codex('official'), e => e.retryAfter === 600000);
  assert.equal(f.children.length, 1);
});
test('Claude optional cache preserves timestamp, validates credentials each call and retains no child', async () => {
  const f = fixture();
  try {
    const first = await f.adapters.claude('/virtual', undefined, {cacheSeconds: 5});
    const next = await f.adapters.claude('/virtual', undefined, {cacheSeconds: 5});
    assert.equal(next.time, first.time); assert.equal(next.cached, true); assert.equal(next.freshSource, false); assert.equal(f.http.length, 1);
    f.setToken('changed'); await f.adapters.claude('/virtual', undefined, {cacheSeconds: 5}); assert.equal(f.http.length, 2);
    f.setExpiry(1); await assert.rejects(f.adapters.claude('/virtual', undefined, {cacheSeconds: 5}), /인증 만료/);
    assert.equal(f.http.length, 2); assert.equal(f.children.length, 0);
  } finally {f.adapters.dispose();}
  assert.ok(f.agents.every(a => a.destroyed));
});
test('Claude credentials changing during HTTP discard the response', async () => {
  const f = fixture({requestJson: (url, config, api) => {api.setToken('changed'); return {};}});
  try {await assert.rejects(f.adapters.claude('/virtual'), /계정이 변경/); assert.equal(f.adapters.getDiagnostics('claude'), null);}
  finally {f.adapters.dispose();}
});
test('Claude default performs fresh reads and never overrides server Retry-After', async () => {
  const f = fixture();
  try {await f.adapters.claude('/virtual'); await f.adapters.claude('/virtual'); assert.equal(f.http.length, 2);}
  finally {f.adapters.dispose();}
  const throttled = fixture({requestJson: () => {const error = new Error('limited'); error.retryAfter = 900000; throw error;}});
  try {
    await assert.rejects(throttled.adapters.claude('/virtual'), e => e.retryAfter === 900000);
    await assert.rejects(throttled.adapters.claude('/virtual', undefined, {cacheSeconds: 5}), e => e.retryAfter === 900000);
    assert.equal(throttled.http.length, 1);
  } finally {throttled.adapters.dispose();}
});

test('Claude unrelated profile preferences do not invalidate an in-flight account read', async () => {
  const f = fixture({requestJson: (url, config, api) => {api.setProfileTheme('light'); return {};}});
  try {await f.adapters.claude('/virtual'); assert.equal(f.http.length, 1);}
  finally {f.adapters.dispose();}
});
test('Claude identity changes during HTTP still discard the response', async () => {
  const f = fixture({requestJson: (url, config, api) => {api.setAccount('second'); return {};}});
  try {await assert.rejects(f.adapters.claude('/virtual'), /계정이 변경/);}
  finally {f.adapters.dispose();}
});
