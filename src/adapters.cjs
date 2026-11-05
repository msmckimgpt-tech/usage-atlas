'use strict';
// Collection lifecycle adapted from https://github.com/jisoq/Codexon; Copyright (c) 2026 jisoq.
// See licenses/Codexon-LICENSE.txt. Usage Atlas adds opt-in sessions, guards and bounded caches.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const https = require('node:https');
const {StringDecoder} = require('node:string_decoder');
const {codexSnapshot, claudeSnapshot} = require('./core.cjs');
const {requestJson} = require('./http.cjs');
const sessions = new Map(), liveSessions = new Set(), claudeCache = new Map(), codexCache = new Map(), backoffs = new Map();
const diagnostics = new Map(), queues = new Map();
let claudeAgent, generation = 0;
const aborted = provider => new Error(provider + ' 조회 취소');
function serial(key, signal, work) {
  if (signal?.aborted) return Promise.reject(aborted(typeof key === 'string' ? key : 'Codex'));
  const queue = queues.get(key) || {tail: Promise.resolve(), size: 0};
  if (queue.size >= 4) return Promise.reject(new Error('조회 대기 수 제한 초과'));
  queues.set(key, queue); queue.size++;
  const epoch = generation;
  const result = queue.tail.then(() => {
    if (signal?.aborted || epoch !== generation) throw aborted(typeof key === 'string' ? key : 'Codex');
    return work();
  });
  queue.tail = result.catch(() => {}).finally(() => {queue.size--; if (!queue.size && queues.get(key) === queue) queues.delete(key);});
  return result;
}
function cacheMs(options) {return Number.isFinite(options.cacheSeconds) ? Math.max(0, Math.min(5, options.cacheSeconds)) * 1000 : 0;}
function isFresh(snapshot, options) {const age = Date.now() - snapshot.time; return age >= 0 && age < cacheMs(options);}
function metadata(snapshot, cached) {return {...structuredClone(snapshot), fetchedAt: snapshot.time, cached, freshSource: !cached};}
function recordMetrics(id, connection, cacheHit, start, options) {
  if (options.metricsEnabled === false) {diagnostics.delete(id); return;}
  const value = {connection, cacheHit, fetchMs: Math.max(0, performance.now() - start)};
  diagnostics.set(id, value);
  try {options.onMetrics?.({...value});} catch {}
}
function getDiagnostics(id) {const value = diagnostics.get(id); return value ? {...value} : null;}
function checkBackoff(key) {
  const until = backoffs.get(key);
  if (until > Date.now()) {const error = new Error('서버 재시도 대기 중'); error.retryAfter = until - Date.now(); throw error;}
  backoffs.delete(key);
}
function rememberBackoff(key, error) {if (Number.isFinite(error.retryAfter) && error.retryAfter > 0) backoffs.set(key, Date.now() + error.retryAfter);}
function tokenClaims(token) {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload || payload.length > 262144) return null;
  try {return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));} catch {return null;}
}
async function authState() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  try {
    const contents = await fs.readFile(file), stamp = crypto.createHash('sha256').update(contents).digest('hex');
    let data; try {data = JSON.parse(contents.toString());} catch {return {stamp, identity: null};}
    // Local identity metadata only; token bytes, expiry and refresh timestamps are never retained.
    const claims = tokenClaims(data.tokens?.id_token) || tokenClaims(data.tokens?.access_token);
    const subject = typeof claims?.sub === 'string' && claims.sub ? claims.sub : null;
    const email = typeof claims?.email === 'string' && claims.email.trim() ? claims.email.trim().toLowerCase() : null;
    const accountId = data.tokens?.account_id || claims?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
    const identity = subject || email ? crypto.createHash('sha256').update(JSON.stringify([data.auth_mode || 'chatgpt', accountId, subject, email])).digest('hex') : null;
    return {stamp, identity};
  } catch (error) {if (error.code === 'ENOENT') return {stamp: 'missing', identity: null}; throw new Error('Codex 로그인 정보 확인 실패');}
}
async function authStamp() {return (await authState()).stamp;}
function accountIdentity(account) {
  // Plan metadata and JSON property order are not account identity.
  const email = typeof account?.email === 'string' ? account.email.trim().toLowerCase() : null;
  return JSON.stringify([account?.type ?? null, email, account?.accountId ?? null, account?.userId ?? null]);
}
function rpcError(value) {
  const error = new Error('Codex 사용량 조회 실패: 로그인 상태를 확인하세요');
  if (value?.code === 429 || /429|rate.?limit/i.test(value?.message || '')) {
    error.message = 'Codex 조회 제한: 잠시 후 재시도';
    error.retryAfter = Math.max(300000, Number(value.data?.retryAfterMs) || Number(value.data?.retryAfter) * 1000 || 0);
  }
  return error;
}
class CodexSession {
  constructor(executable, options = {}) {
    this.executable = executable; this.options = options;
    this.pending = new Map(); this.next = 0; this.buffer = ''; this.bytes = 0;
    this.decoder = new StringDecoder('utf8'); this.epoch = 0; this.authEpoch = 0; this.closed = false;
    this.queueKey = Symbol('codex-session'); liveSessions.add(this);
  }
  start() {
    if (this.closed) throw new Error('Codex 연결이 종료되었습니다');
    if (this.ready) return this.ready;
    const windows = process.platform === 'win32';
    const cp = this.child = spawn(
      windows ? path.join(__dirname, '..', 'bin', 'collector-host.exe') : this.executable
    , windows ? [this.executable, 'app-server'] : ['app-server']
    , {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: false, env: {...process.env, TOKIO_WORKER_THREADS: '2'}}
    );
    cp.on('error', () => this.dispose(new Error('Codex 실행 파일을 시작하지 못했습니다')));
    cp.on('exit', code => this.dispose(new Error(windows && code === 70 ? 'Codex 백그라운드 실행 실패: 공식 확장 또는 실행 파일 경로를 확인하세요' : 'Codex 연결이 종료되었습니다')));
    cp.stderr.resume();
    cp.stdin.on('error', () => this.dispose(new Error('Codex 입력 연결 종료')));
    cp.stdout.on('data', chunk => {
      // Bound notifications too; small complete lines cannot bypass the cap.
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > 1048576) {this.dispose(new Error('Codex 응답 크기 제한 초과')); return;}
      this.buffer += this.decoder.write(chunk);
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
        let message; try {message = JSON.parse(line);} catch {continue;}
        if (message.method === 'account/updated') {
          this.epoch++; this.cache = null;
          if (message.params && Object.hasOwn(message.params, 'authMode') && !['chatgpt', 'chatgptAuthTokens'].includes(message.params.authMode)) this.authEpoch++;
        }
        if (message.method === 'account/rateLimits/updated') this.cache = null;
        const p = this.pending.get(message.id);
        if (p) {this.pending.delete(message.id); message.error ? p.reject(rpcError(message.error)) : p.resolve(message.result);}
      }
    });
    this.ready = this.send('initialize', {clientInfo: {name: 'usage_atlas', title: 'Usage Atlas', version: '0.2.0'}}).then(() => {
      if (this.closed) throw new Error('Codex 연결이 종료되었습니다');
      cp.stdin.write(JSON.stringify({method: 'initialized'}) + '\n');
    });
    return this.ready;
  }
  send(method, params) {
    if (!['initialize', 'account/read', 'account/rateLimits/read'].includes(method) || method === 'account/read' && params?.refreshToken !== false) return Promise.reject(new Error('읽기 전용 RPC만 허용됩니다'));
    if (this.closed || !this.child) return Promise.reject(new Error('Codex 연결이 종료되었습니다'));
    if (this.pending.size) return Promise.reject(new Error('Codex 동시 RPC 제한 초과'));
    return new Promise((resolve, reject) => {
      const id = ++this.next; this.pending.set(id, {resolve, reject});
      try {this.child.stdin.write(JSON.stringify({id, method, params}) + '\n');}
      catch {this.dispose(new Error('Codex 입력 연결 종료'));}
    });
  }
  read(signal, options = this.options) {
    return serial(this.queueKey, signal, async () => {
      if (this.closed) throw new Error('Codex 연결이 종료되었습니다');
      clearTimeout(this.idleTimer); this.bytes = Buffer.byteLength(this.buffer);
      const start = performance.now(), key = 'codex:' + this.executable;
      const stop = () => this.dispose(aborted('Codex'));
      const timeoutMs = Math.max(1, Math.min(20000, Number(options.timeoutMs) || 20000));
      const deadline = setTimeout(() => this.dispose(new Error('Codex 조회 시간 초과')), timeoutMs);
      signal?.addEventListener('abort', stop, {once: true});
      try {
        checkBackoff(key);
        const auth = await authState(), stamp = auth.stamp;
        if (this.auth !== undefined && this.auth !== stamp) {
          this.cache = null;
          if (!this.authIdentity || this.authIdentity !== auth.identity) {this.dispose(); throw new Error('Codex 로그인 정보 변경: 다음 조회에서 다시 연결합니다');}
        }
        this.auth = stamp; this.authIdentity = auth.identity;
        await this.start();
        const account = (await this.send('account/read', {refreshToken: false}))?.account;
        if (account?.type !== 'chatgpt') throw new Error('Codex 구독 계정 로그인이 필요합니다');
        const identity = accountIdentity(account), epoch = this.epoch, authEpoch = this.authEpoch;
        const hit = !!(this.cache && this.cache.identity === identity && isFresh(this.cache.snapshot, options));
        const cachedSnapshot = hit ? this.cache.snapshot : null;
        const data = hit ? null : await this.send('account/rateLimits/read', {});
        const after = (await this.send('account/read', {refreshToken: false}))?.account;
        const afterAuth = await authState(), authFileChanged = afterAuth.stamp !== stamp;
        const guardReasons = {
          accountObjectChanged: JSON.stringify(after) !== JSON.stringify(account)
        , accountIdentityChanged: accountIdentity(after) !== identity
        , accountNotificationObserved: this.epoch !== epoch
        , authTransitionObserved: this.authEpoch !== authEpoch
        , authFileChanged
        , authIdentityChanged: authFileChanged && !!auth.identity && !!afterAuth.identity && auth.identity !== afterAuth.identity
        , authIdentityUnverified: authFileChanged && (!auth.identity || !afterAuth.identity)
        };
        const beforeAfterEquality = {
          accountJsonEqual: !guardReasons.accountObjectChanged
        , accountIdentityEqual: !guardReasons.accountIdentityChanged
        , planMetadataEqual: (account?.planType ?? null) === (after?.planType ?? null)
        , authFileEqual: !authFileChanged
        , authIdentityEqual: !!auth.identity && auth.identity === afterAuth.identity
        , authIdentityKnown: !!auth.identity && !!afterAuth.identity
        };
        if (options.metricsEnabled !== false) {try {options.onGuardCheck?.({...guardReasons});} catch {}}
        if (guardReasons.accountIdentityChanged || guardReasons.authTransitionObserved || guardReasons.authIdentityChanged || guardReasons.authIdentityUnverified) {
          const reason = guardReasons.accountIdentityChanged ? 'account-identity-changed' : guardReasons.authTransitionObserved ? 'auth-transition' : guardReasons.authIdentityChanged ? 'auth-identity-changed' : 'auth-identity-unverified';
          const invalidation = {reason, beforeAfterEquality};
          if (options.metricsEnabled !== false) {try {options.onInvalidation?.(structuredClone(invalidation));} catch {}}
          const error = new Error('Codex 조회 중 계정이 변경되어 결과를 폐기했습니다'); error.guardReasons = guardReasons; error.invalidation = invalidation;
          this.dispose(); throw error;
        }
        const snapshot = hit ? cachedSnapshot : codexSnapshot(data, after);
        this.auth = afterAuth.stamp; this.authIdentity = afterAuth.identity;
        this.cache = authFileChanged ? null : {identity, snapshot};
        recordMetrics('codex', options.persistent === false ? 'onDemand' : 'persistent', hit, start, options);
        return metadata(snapshot, hit);
      } catch (error) {this.cache = null; rememberBackoff(key, error); this.dispose(error); throw error;}
      finally {
        clearTimeout(deadline); signal?.removeEventListener('abort', stop);
        if (!this.closed) {
          // Explicit persistent users can retain the child through the next scheduled read.
          const ttl = Math.max(1, Math.min(300000, Number(options.idleTtlMs) || 60000));
          this.idleTimer = setTimeout(() => this.dispose(), ttl); this.idleTimer.unref?.();
        }
      }
    });
  }
  dispose(error = new Error('Codex 연결이 종료되었습니다')) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.idleTimer); this.cache = null;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear(); liveSessions.delete(this);
    try {this.child?.stdin.end();} catch {}
    try {this.child?.kill();} catch {}
  }
}
function createCodexSession(executable, options = {}) {return new CodexSession(executable, options);}
function codex(executable, signal, options = {}) {
  return serial('codex', signal, async () => {
    const start = performance.now(), key = 'codex:' + executable, epoch = generation;
    diagnostics.delete('codex');
    checkBackoff(key);
    let session;
    if (options.persistent === true) {
      for (const [key, old] of sessions) if (key !== executable) {old.dispose(); sessions.delete(key);}
      session = sessions.get(executable);
      if (session && !session.closed && session.auth !== undefined && session.auth !== await authStamp()) {session.dispose(); sessions.delete(executable); session = null;}
      if (!session || session.closed) {session = createCodexSession(executable, options); sessions.set(executable, session);}
    } else {
      for (const old of sessions.values()) old.dispose(); sessions.clear();
      const cached = codexCache.get(executable);
      if (cached && isFresh(cached.snapshot, options) && cached.stamp === await authStamp()) {
        if (signal?.aborted || epoch !== generation) throw aborted('Codex');
        recordMetrics('codex', 'onDemand', true, start, options); return metadata(cached.snapshot, true);
      }
      codexCache.clear(); session = createCodexSession(executable, options);
    }
    if (signal?.aborted || epoch !== generation) {session.dispose(); throw aborted('Codex');}
    try {
      const snapshot = await session.read(signal, {...options, persistent: options.persistent === true});
      if (cacheMs(options) && options.persistent !== true) codexCache.set(executable, {snapshot: structuredClone(snapshot), stamp: session.auth});
      return snapshot;
    } catch (error) {codexCache.clear(); throw error;}
    finally {if (options.persistent !== true) session.dispose();}
  });
}
async function claudeAuth(dir) {
  const files = [path.join(dir, '.credentials.json'), path.join(dir, '.claude.json'), path.join(os.homedir(), '.claude.json')];
  const contents = await Promise.all(files.map(file => fs.readFile(file, 'utf8').catch(error => {if (error.code === 'ENOENT') return ''; throw new Error('Claude 로그인 정보 확인 실패');})));
  let creds; try {creds = JSON.parse(contents[0]).claudeAiOauth;} catch {throw new Error('Claude 로그인 정보가 없습니다');}
  if (!creds?.accessToken) throw new Error('Claude 구독 계정 로그인이 필요합니다');
  if (creds.expiresAt && creds.expiresAt < Date.now()) throw new Error('Claude 인증 만료: 공식 확장에서 로그인 상태를 갱신하세요');
  let identity;
  for (const content of contents.slice(1)) {try {const data = JSON.parse(content); identity = data.oauthAccount?.accountUuid || data.oauthAccount?.emailAddress; if (identity) break;} catch {}}
  if (!identity) throw new Error('Claude 계정 식별 정보가 없어 기록을 분리할 수 없습니다');
  const stamp = crypto.createHash('sha256').update(contents[0]).update('\0').update(identity).digest('hex');
  return {creds, identity, stamp};
}
function claude(configDir, signal, options = {}) {
  return serial('claude', signal, async () => {
    const dir = path.resolve(configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    const key = 'claude:' + dir, start = performance.now(), epoch = generation;
    diagnostics.delete('claude');
    try {
      checkBackoff(key);
      // Validate auth on every call, including cache hits; no retained tokens or refresh.
      const auth = await claudeAuth(dir), cached = claudeCache.get(dir);
      if (cached?.stamp !== auth.stamp) claudeCache.delete(dir);
      if (cached?.stamp === auth.stamp && isFresh(cached.snapshot, options)) {
        if (signal?.aborted || epoch !== generation) throw aborted('Claude');
        recordMetrics('claude', 'onDemand', true, start, options); return metadata(cached.snapshot, true);
      }
      claudeAgent ||= new https.Agent({keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 30000});
      const data = await requestJson('https://api.anthropic.com/api/oauth/usage', {agent: claudeAgent, signal, headers: {Authorization: 'Bearer ' + auth.creds.accessToken, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json'}});
      if (signal?.aborted || epoch !== generation) throw aborted('Claude');
      const after = await claudeAuth(dir);
      if (after.stamp !== auth.stamp) throw new Error('Claude 조회 중 계정이 변경되어 결과를 폐기했습니다');
      const snapshot = claudeSnapshot(data, auth.identity, (auth.creds.subscriptionType || 'unknown') + ':' + (auth.creds.rateLimitTier || 'unknown'));
      claudeCache.clear(); if (cacheMs(options)) claudeCache.set(dir, {stamp: auth.stamp, snapshot});
      recordMetrics('claude', 'onDemand', false, start, options); return metadata(snapshot, false);
    } catch (error) {claudeCache.delete(dir); rememberBackoff(key, error); throw error;}
  });
}
function dispose() {
  generation++; for (const session of liveSessions) session.dispose(); sessions.clear();
  claudeAgent?.destroy(); claudeAgent = null; claudeCache.clear(); codexCache.clear(); diagnostics.clear();
}
module.exports = {codex, claude, dispose, createCodexSession, getDiagnostics};
