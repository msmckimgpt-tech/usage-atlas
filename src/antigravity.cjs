'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {hash} = require('./core.cjs');
const {retryAfter} = require('./http.cjs');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const dataDir = value => value || path.join(os.homedir(), '.gemini', 'antigravity');
function connection(value) {
  const port = value?.port ?? value?.httpPort, token = value?.csrfToken;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !/^[a-zA-Z0-9_-]{16,256}$/.test(token)) throw Error('Antigravity 연결 정보가 없습니다. 공식 확장을 열어주세요.');
  return {port, csrfToken: token};
}
async function discover(directory) {
  const dir = path.join(dataDir(directory), 'daemon');
  let entries;
  try {entries = await fs.readdir(dir, {withFileTypes: true});} catch {throw Error('Antigravity 실행 연결이 없습니다. 공식 확장을 열어주세요.');}
  if (entries.length > 256) throw Error('Antigravity 연결 파일이 너무 많습니다. 공식 확장 연결을 사용해주세요.');
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^hub_[0-9]{1,5}\.json$/.test(entry.name)) continue;
    try {
      const file = path.join(dir, entry.name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) continue;
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(value.pid) || value.pid < 1) continue;
      try {process.kill(value.pid, 0);} catch (e) {if (e.code !== 'EPERM') continue;}
      const selected = connection(value);
      if (entry.name !== 'hub_' + selected.port + '.json') continue;
      candidates.push(selected);
    } catch {}
  }
  if (candidates.length !== 1) throw Error(candidates.length ? 'Antigravity 연결이 여러 개입니다. 같은 확장 호스트의 공식 확장이 필요합니다.' : 'Antigravity 실행 연결이 없습니다. 공식 확장을 열어주세요.');
  return candidates[0];
}
function request(endpoint, method, body, {signal, timeoutMs = 8000} = {}) {
  if (!['GetUserStatus', 'RetrieveUserQuotaSummary'].includes(method)) return Promise.reject(Error('읽기 전용 사용량 조회만 허용됩니다.'));
  const {port, csrfToken} = connection(endpoint);
  return new Promise((resolve, reject) => {
    let done = false, req;
    const finish = (error, value) => {if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) {req?.destroy(); reject(error);} else resolve(value);};
    const abort = () => finish(Error('Antigravity 조회 취소'));
    const timer = setTimeout(() => finish(Error('Antigravity 조회 시간 초과')), Math.max(1, Math.min(15000, timeoutMs)));
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) {abort(); return;}
    req = http.request({hostname: '127.0.0.1', port, path: '/exa.language_server_pb.LanguageServerService/' + method, method: 'POST', agent: false, headers: {'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken}}, async res => {
      try {
        if (res.statusCode !== 200) {const error = Error('Antigravity 조회 HTTP ' + res.statusCode); if (res.statusCode === 429 || res.statusCode === 503) error.retryAfter = retryAfter(res.headers['retry-after']); res.resume(); finish(error); return;}
        const chunks = []; let size = 0;
        for await (const chunk of res) {size += chunk.length; if (size > 1048576) throw Error('Antigravity 응답 크기 제한 초과'); chunks.push(chunk);}
        let data; try {data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));} catch {throw Error('Antigravity 응답 형식 오류');}
        finish(null, data);
      } catch (error) {finish(error);}
    });
    req.on('error', () => finish(Error('Antigravity 로컬 연결 실패')));
    req.end(JSON.stringify(body || {}));
  });
}
function identity(status) {
  const value = status?.userStatus;
  const id = value?.email?.trim().toLowerCase();
  if (!id || id.length > 320) throw Error('Antigravity 로그인이 필요합니다.');
  const plan = value.userTier?.id;
  if (typeof plan !== 'string' || !plan || plan.length > 100) throw Error('Antigravity 요금제 정보가 없습니다.');
  return {account: hash(id), plan};
}
function snapshots(summary, account, now = Date.now()) {
  const groups = summary?.response?.groups;
  if (!Array.isArray(groups) || !groups.length || groups.length > 16) throw Error('Antigravity 한도 그룹 응답을 확인할 수 없습니다.');
  const seen = new Set(), result = [];
  for (const group of groups) {
    if (!Array.isArray(group.buckets) || group.buckets.length > 16) throw Error('Antigravity 한도 창 응답이 올바르지 않습니다.');
    const windows = {five: null, week: null}, keys = [];
    for (const bucket of group.buckets) {
      if (typeof bucket.bucketId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(bucket.bucketId)) throw Error('Antigravity 한도 ID가 올바르지 않습니다.');
      keys.push(bucket.bucketId.replace(/-(?:5h|weekly)$/, ''));
      const key = bucket.window === '5h' ? 'five' : bucket.window === 'weekly' ? 'week' : null;
      if (!key || bucket.disabled) continue;
      if (windows[key]) throw Error('Antigravity 한도 창이 중복되었습니다.');
      // Proto3의 생략된 숫자 기본값은 0. remainingAmount는 비율로 해석하지 않는다.
      const fraction = Object.hasOwn(bucket, 'remainingAmount') ? null : bucket.remainingFraction ?? 0;
      const reset = Date.parse(bucket.resetTime);
      if (!finite(fraction) || fraction < 0 || fraction > 1 || !finite(reset)) continue;
      windows[key] = {used: Math.round((1 - fraction) * 100000000) / 1000000, reset: Math.round(reset / 60000) * 60000};
    }
    if (!keys.length || !Object.values(windows).some(Boolean)) continue;
    const provider = 'antigravity-' + hash([...new Set(keys)].sort().join('/')).slice(0, 16);
    if (seen.has(provider)) throw Error('Antigravity 한도 그룹이 중복되었습니다.');
    seen.add(provider);
    const labels = {'Gemini Models': 'Gemini', 'Claude and GPT models': 'Claude/GPT', 'Gemini 4 Argon': 'Argon'};
    const label = labels[group.displayName] || group.displayName;
    if (typeof label !== 'string' || !label.trim() || label.length > 80 || /[\x00-\x1f]/.test(label)) throw Error('Antigravity 그룹 이름이 올바르지 않습니다.');
    result.push({v: 1, provider, ...account, time: now, label: label.trim(), windows, source: 'antigravity-local'});
  }
  if (!result.length) throw Error('Antigravity에 확인 가능한 사용률이 없습니다.');
  return result;
}
let cached, pending, generation = 0, backoff = 0;
async function collect(directory, signal, options = {}) {
  if (signal?.aborted) throw Error('Antigravity 조회 취소');
  if (backoff > Date.now()) {const error = Error('Antigravity 서버 재시도 대기 중'); error.retryAfter = backoff - Date.now(); throw error;}
  if (pending) return pending;
  const epoch = generation;
  pending = (async () => {
    const endpoint = options.connection ? connection(await options.connection()) : await discover(directory);
    const key = hash(endpoint.port + '/' + endpoint.csrfToken), start = performance.now();
    const call = options.request || request;
    const before = identity(await call(endpoint, 'GetUserStatus', {}, {signal}));
    const cacheHit = cached?.key === key && cached.account === before.account && cached.plan === before.plan && Date.now() - cached.time >= 0 && Date.now() - cached.time < Math.min(5, Math.max(0, options.cacheSeconds || 0)) * 1000;
    const data = cacheHit ? cached.data : snapshots(await call(endpoint, 'RetrieveUserQuotaSummary', {forceRefresh: true}, {signal}), before);
    const after = identity(await call(endpoint, 'GetUserStatus', {}, {signal}));
    if (before.account !== after.account || before.plan !== after.plan) throw Error('Antigravity 조회 중 계정 또는 요금제가 변경되어 결과를 폐기했습니다.');
    if (signal?.aborted || epoch !== generation) throw Error('Antigravity 조회 취소');
    cached = {key, ...before, time: data[0].time, data};
    if (options.metricsEnabled !== false) options.onMetrics?.({connection: 'local-rpc', cacheHit, fetchMs: performance.now() - start});
    return structuredClone(data);
  })().catch(error => {cached = null; if (error.retryAfter > 0) backoff = Date.now() + error.retryAfter; throw error;}).finally(() => {pending = null;});
  return pending;
}
function dispose() {generation++; cached = null; backoff = 0;}
module.exports = {collect, discover, request, snapshots, identity, dataDir, dispose};
