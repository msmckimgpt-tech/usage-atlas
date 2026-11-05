'use strict';
const https = require('node:https');
const zlib = require('node:zlib');
function retryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 300000;
  const seconds = Number(value), delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(300000, delay) : 300000;
}
function requestJson(url, {headers, agent, signal, timeoutMs = 15000, maxBytes = 1048576, request = https.request} = {}) {
  if (signal?.aborted) return Promise.reject(new Error('Claude 조회 취소'));
  return new Promise((resolve, reject) => {
    let done = false, req, stream;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (error) {stream?.destroy(); req?.destroy(); reject(error);} else resolve(value);
    };
    const stop = () => finish(new Error('Claude 조회 취소'));
    const timer = setTimeout(() => finish(new Error('Claude 조회 시간 초과')), timeoutMs);
    signal?.addEventListener('abort', stop, {once: true});
    try {
      req = request(url, {method: 'GET', agent, headers: {...headers, 'Accept-Encoding': 'identity'}}, async res => {
        res.on('error', () => finish(new Error('Claude 응답 연결 종료')));
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(res.statusCode === 429 ? 'Claude 조회 제한: 잠시 후 재시도' : `Claude 조회 HTTP ${res.statusCode}`);
            error.retryAfter = retryAfter(res.headers['retry-after']); res.resume(); finish(error); return;
          }
          const encoding = res.headers['content-encoding'];
          stream = encoding === 'gzip' ? res.pipe(zlib.createGunzip()) : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress()) : encoding === 'deflate' ? res.pipe(zlib.createInflate()) : res;
          if (stream !== res) res.on('error', error => stream.destroy(error));
          const chunks = []; let size = 0;
          for await (const chunk of stream) {size += chunk.length; if (size > maxBytes) throw new Error('Claude 응답 크기 제한 초과'); chunks.push(chunk);}
          let value; try {value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));} catch {throw new Error('Claude 사용량 응답 형식 오류');}
          finish(null, value);
        } catch (error) {finish(error);}
      });
      req.on('error', () => finish(new Error('Claude 네트워크 연결 실패')));
      req.end();
    } catch {finish(new Error('Claude 네트워크 연결 실패'));}
  });
}
module.exports = {requestJson, retryAfter};
