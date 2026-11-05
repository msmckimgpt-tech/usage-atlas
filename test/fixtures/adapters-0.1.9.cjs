'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {codexSnapshot, claudeSnapshot} = require('./core-0.1.9.cjs');
async function codex(executable, signal) {
  const cp = spawn(executable, ['app-server'], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let buffer = '', next = 0, failure;
  const pending = new Map();
  const fail = error => {failure = error; for (const p of pending.values()) p.reject(error); pending.clear();};
  const stop = () => {fail(new Error('Codex 조회 취소')); cp.kill();};
  signal?.addEventListener('abort', stop, {once: true});
  cp.on('error', () => fail(new Error('Codex 실행 파일을 시작하지 못했습니다')));
  cp.on('exit', () => fail(new Error('Codex 연결이 종료되었습니다')));
  cp.stderr.resume();
  cp.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1048576) {fail(new Error('Codex 응답 크기 제한 초과')); cp.kill(); return;}
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try {const m = JSON.parse(line), p = pending.get(m.id); if (p) {pending.delete(m.id); m.error ? p.reject(new Error('Codex 사용량 조회 실패: 로그인 상태를 확인하세요')) : p.resolve(m.result);}} catch {}
    }
  });
  cp.stdin.on('error', () => fail(new Error('Codex 입력 연결 종료')));
  const send = (method, params) => new Promise((resolve, reject) => {if (failure) return reject(failure); const id = ++next; pending.set(id, {resolve, reject}); cp.stdin.write(JSON.stringify({id, method, params}) + '\n');});
  const deadline = setTimeout(() => {fail(new Error('Codex 조회 시간 초과')); cp.kill();}, 20000);
  try {
    await send('initialize', {clientInfo: {name: 'usage_atlas', title: 'Usage Atlas', version: '0.1.9'}});
    cp.stdin.write(JSON.stringify({method: 'initialized'}) + '\n');
    const a = await send('account/read', {refreshToken: false});
    if (a.account?.type !== 'chatgpt') throw new Error('Codex 구독 계정 로그인이 필요합니다');
    return codexSnapshot(await send('account/rateLimits/read', {}), a.account);
  } finally {clearTimeout(deadline); signal?.removeEventListener('abort', stop); cp.stdin.end(); cp.kill();}
}
async function claude(configDir, signal) {
  const dir = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let creds;
  try {creds = JSON.parse(await fs.readFile(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;} catch {throw new Error('Claude 로그인 정보가 없습니다');}
  if (!creds?.accessToken) throw new Error('Claude 구독 계정 로그인이 필요합니다');
  if (creds.expiresAt && creds.expiresAt < Date.now()) throw new Error('Claude 인증 만료: 공식 확장에서 로그인 상태를 갱신하세요');
  let identity;
  for (const file of [path.join(dir, '.claude.json'), path.join(os.homedir(), '.claude.json')]) {
    try {const data = JSON.parse(await fs.readFile(file, 'utf8')); identity = data.oauthAccount?.accountUuid || data.oauthAccount?.emailAddress; if (identity) break;} catch {}
  }
  if (!identity) throw new Error('Claude 계정 식별 정보가 없어 기록을 분리할 수 없습니다');
  const abort = new AbortController();
  const stop = () => abort.abort(); signal?.addEventListener('abort', stop, {once: true});
  const timer = setTimeout(stop, 15000);
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {method: 'GET', redirect: 'error', headers: {Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json'}, signal: abort.signal});
    if (!res.ok) {const e = new Error(res.status === 429 ? 'Claude 조회 제한: 잠시 후 재시도' : `Claude 조회 HTTP ${res.status}`); e.retryAfter = Math.min(3600000, Math.max(300000, Number(res.headers.get('retry-after')) * 1000 || 0)); throw e;}
    const text = await res.text(); if (text.length > 1048576) throw new Error('Claude 응답 크기 제한 초과');
    return claudeSnapshot(JSON.parse(text), identity, `${creds.subscriptionType || 'unknown'}:${creds.rateLimitTier || 'unknown'}`);
  } finally {clearTimeout(timer); signal?.removeEventListener('abort', stop);}
}
module.exports = {codex, claude};
