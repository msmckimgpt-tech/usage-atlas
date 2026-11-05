'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const {requestJson, retryAfter} = require('../src/http.cjs');
async function server(fn, handler) {
  const host = http.createServer(handler); await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({keepAlive: true, maxSockets: 1, timeout: 1000});
  const read = options => requestJson(`http://127.0.0.1:${host.address().port}`, {request: http.request, agent, ...options});
  try {await fn(read);} finally {agent.destroy(); host.closeAllConnections(); await new Promise(resolve => host.close(resolve));}
}
test('Claude transport preserves exact JSON and reuses connection with bounded sockets', () => {
  const sockets = new Set();
  return server(async read => {assert.deepEqual(await read(), {used: 12.345, text: '주간'}); await read(); assert.equal(sockets.size, 1);}, (req, res) => {sockets.add(req.socket); res.end(JSON.stringify({used: 12.345, text: '주간'}));});
});
test('retry-after accepts HTTP-date and delays longer than one hour without early polling', () => {
  const now = Date.now(); assert.equal(retryAfter('7200', now), 7200000);
  assert.ok(retryAfter(new Date(now + 7200000).toUTCString(), now) >= 7199000);
  assert.equal(retryAfter('invalid'), 300000); assert.equal(retryAfter('-1'), 300000);
  return server(async read => {await assert.rejects(read(), error => error.retryAfter === 7200000 && /조회 제한/.test(error.message));}, (_, res) => {res.writeHead(429, {'Retry-After': '7200'}); res.end('private response must not appear');});
});
test('redirects and invalid JSON are rejected without exposing response content', () => server(async read => {
  await assert.rejects(read(), /HTTP 302/); await assert.rejects(read(), error => /응답 형식 오류/.test(error.message) && !error.message.includes('secret'));
}, (() => {let count = 0; return (_, res) => {if (!count++) res.writeHead(302, {Location: 'https://example.com'}); res.end('secret');};})()));
test('timeout and cancellation stop actual requests and leave no queued work', () => server(async read => {
  await assert.rejects(read({timeoutMs: 20}), /시간 초과/);
  const abort = new AbortController(), pending = read({signal: abort.signal}); abort.abort(); await assert.rejects(pending, /조회 취소/);
  await assert.rejects(read({signal: abort.signal}), /조회 취소/);
}, () => {}));
test('compressed responses decode correctly and expansion is bounded', () => server(async read => {
  await assert.rejects(read({maxBytes: 1000}), /크기 제한/);
  assert.deepEqual(await read(), {used: 12.345});
}, (() => {let count = 0; return (_, res) => {res.writeHead(200, {'Content-Encoding': 'gzip'}); res.end(zlib.gzipSync(JSON.stringify(count++ ? {used: 12.345} : {text: 'a'.repeat(5000)})));};})()));
