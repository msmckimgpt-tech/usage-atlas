'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {constants} = require('node:fs');
const {setImmediate: yieldTurn} = require('node:timers/promises');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const limits = Object.freeze({bytes: 8 * 1024 * 1024, line: 1024 * 1024, entries: 20000, files: 8, messages: 40, text: 16000, pageText: 200000, metadata: 20000});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => finite(value) ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const body = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(block =>
  ['text', 'input_text', 'output_text'].includes(block?.type) && typeof block.text === 'string' ? block.text : block?.type === 'image' || block?.type === 'input_image' ? '[이미지]' : ''
).filter(Boolean).join('\n') : '';
function messages(event, provider) {
  const time = timestamp(event?.timestamp ?? event?.time), rows = [];
  if (time === null) return rows;
  const add = (role, text, id, fallback = false) => {
    if (!['user', 'assistant'].includes(role) || !text.trim()) return;
    rows.push({role, time, text: text.slice(0, limits.text), clipped: text.length > limits.text, sourceId: typeof id === 'string' ? id.slice(0, 200) : null, contentHash: hash(role + ':' + text), fallback});
  };
  if (provider === 'claude') {
    if (['user', 'assistant'].includes(event.type) && !event.isMeta) add(event.message?.role || event.type, body(event.message?.content), event.message?.id || event.uuid);
  } else if (event.type === 'response_item' && event.payload?.type === 'message') {
    add(event.payload.role, body(event.payload.content), event.payload.id);
  } else if (event.type === 'event_msg' && ['user_message', 'agent_message'].includes(event.payload?.type)) {
    add(event.payload.type === 'user_message' ? 'user' : 'assistant', body(event.payload.message), event.payload.id, true);
  } else {
    const response = event.type === 'response.completed' ? event.response : event.payload?.type === 'response.completed' ? event.payload.response : null;
    const output = (Array.isArray(response?.output) ? response.output : []).filter(item => item.type === 'message' && item.role === 'assistant');
    add('assistant', output.map(item => body(item.content)).filter(Boolean).join('\n'), response?.id);
  }
  return rows;
}
const within = (root, file) => {const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);};
async function locate(hints, roots, signal) {
  const found = new Map(), wanted = new Map(hints.map(hint => [hint.key, hint]));
  let entries = 0;
  for (const configured of roots) {
    if (signal?.aborted) throw new Error('조회가 취소되었습니다.');
    let root;
    try {root = await fs.realpath(configured);} catch {continue;}
    for (const hint of hints) if (hint.path && within(root, hint.path) && hash(`${hint.provider}:${hint.path}`) === hint.key) found.set(hint.key, {...hint, root});
    const queue = [root];
    for (let index = 0; index < queue.length && found.size < wanted.size; index++) {
      if (signal?.aborted) throw new Error('조회가 취소되었습니다.');
      if (entries >= limits.entries) return {files: [...found.values()], limited: true};
      let directory;
      try {directory = await fs.opendir(queue[index]);} catch {continue;}
      try {
        for await (const entry of directory) {
          if (++entries > limits.entries) break;
          const full = path.join(queue[index], entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) queue.push(full);
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const lexical = path.join(path.resolve(configured), path.relative(root, full));
          const hint = wanted.get(hash(`${hints[0]?.provider}:${full}`)) || wanted.get(hash(`${hints[0]?.provider}:${lexical}`));
          if (hint) found.set(hint.key, {...hint, path: full, root});
          if (entries % 128 === 0) await yieldTurn();
          if (found.size === wanted.size) break;
        }
      } finally {await directory.close().catch(() => {});}
    }
  }
  return {files: [...found.values()], limited: found.size < wanted.size};
}
async function* reverseLines(file, owner) {
  const real = await fs.realpath(file.path);
  if (!within(file.root, real) || (await fs.lstat(file.path)).isSymbolicLink()) throw new Error('로컬 대화 파일 경로를 확인할 수 없습니다.');
  const stat = await fs.stat(real), handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || await fs.realpath(file.path) !== real) throw new Error('대화 파일이 변경되었습니다. 다시 선택하세요.');
    if (file.headLength && file.headHash) {
      const head = Buffer.alloc(file.headLength); const read = await handle.read(head, 0, head.length, 0);
      if (read.bytesRead !== head.length || hash(head) !== file.headHash) throw new Error('대화 파일이 변경되었습니다. 다시 선택하세요.');
    }
    let offset = opened.size, pending = Buffer.alloc(0), skipping = false, first = true;
    while (offset > 0) {
      if (owner.signal?.aborted) return;
      while (owner.budget.bytes >= limits.bytes) yield {pause: true};
      const length = Math.min(65536, offset, limits.bytes - owner.budget.bytes), buffer = Buffer.alloc(length);
      offset -= length;
      const read = await handle.read(buffer, 0, length, offset); owner.budget.bytes += read.bytesRead;
      if (read.bytesRead !== length) throw new Error('대화 파일이 변경되었습니다. 다시 선택하세요.');
      const joined = pending.length ? Buffer.concat([buffer, pending]) : buffer;
      let end = joined.length;
      for (let i = joined.length - 1; i >= 0; i--) {
        if (joined[i] !== 10) continue;
        if (first) {if (i !== joined.length - 1) owner.partialTail = true; first = false;}
        else if (!skipping && end - i - 1 <= limits.line) yield {text: joined.subarray(i + 1, end).toString('utf8'), offset: offset + i + 1};
        else owner.oversized++;
        skipping = false; end = i;
      }
      if (end > limits.line) {pending = Buffer.alloc(0); skipping = true;}
      else pending = Buffer.from(joined.subarray(0, end));
    }
    if (!first && !skipping && pending.length) yield {text: pending.toString('utf8'), offset: 0};
  } finally {await handle.close();}
}
class ConversationReader {
  constructor() {this.version = 0; this.states = []; this.index = []; this.queue = Promise.resolve();}
  async close() {
    this.version++;
    const states = this.states; this.states = []; this.index = []; this.token = null;
    await Promise.allSettled(states.map(state => state.iterator.return()));
  }
  async open({hints, roots, start, end, earliest, signal}) {
    await this.close();
    this.signal = signal; this.start = start; this.end = end; this.earliest = earliest; this.oversized = 0; this.partialTail = false; this.malformed = 0;
    this.scanAt = 0; this.ready = false; this.nextIndex = 0; this.metadataLimited = false;
    const version = this.version, located = await locate(hints.slice(0, limits.files), roots, signal);
    if (version !== this.version || signal?.aborted) throw new Error('조회가 취소되었습니다.');
    this.unavailable = located.limited || hints.length > limits.files; this.budget = {bytes: 0};
    this.states = located.files.map(file => ({file, iterator: reverseLines(file, this)}));
    if (!this.states.length) throw new Error('해당 세션의 로컬 대화 파일을 찾을 수 없습니다. 색인 완료 후 다시 선택하세요.');
    return await this.page();
  }
  _keep(row) {
    const compare = (a, b) => a.time - b.time || a.id.localeCompare(b.id), heap = this.index;
    if (heap.length >= limits.metadata) {
      this.metadataLimited = true;
      if (compare(row, heap[0]) <= 0) return;
      heap[0] = row;
      for (let i = 0;;) {let child = i * 2 + 1; if (child >= heap.length) break; if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++; if (compare(heap[i], heap[child]) <= 0) break; [heap[i], heap[child]] = [heap[child], heap[i]]; i = child;}
    } else {
      heap.push(row);
      for (let i = heap.length - 1; i > 0;) {const parent = (i - 1) >>> 1; if (compare(heap[parent], heap[i]) <= 0) break; [heap[parent], heap[i]] = [heap[i], heap[parent]]; i = parent;}
    }
  }
  page(token) {
    const work = this.queue.then(async () => {
      if (token != null && token !== this.token) throw new Error('이전 대화 조회가 만료되었습니다. 세션을 다시 선택하세요.');
      if (!this.states.length || this.signal?.aborted) throw new Error('조회가 취소되었습니다.');
      const version = this.version; this.budget = {bytes: 0}; const result = []; let checked = 0, chars = 0, paused = false;
      const active = () => {if (this.signal?.aborted || version !== this.version) throw new Error('조회가 취소되었습니다.');};
      // 본문은 보관하지 않고 시각·파일 위치만 정렬해 로그 기록 순서와 무관하게 최신순을 보장한다.
      while (!this.ready && this.scanAt < this.states.length) {
        active(); const state = this.states[this.scanAt], line = await state.iterator.next();
        if (line.done) {this.scanAt++; continue;}
        if (line.value.pause) {paused = true; break;}
        try {
          const event = JSON.parse(line.value.text), accountId = event.account_id || event.payload?.account_id;
          const explicit = event.account_hash || event.payload?.account_hash || (typeof accountId === 'string' ? hash(accountId).slice(0, 20) : null);
          if (explicit && explicit !== state.file.account) throw new Error('scope-mismatch');
          const session = event.type === 'session_meta' ? event.payload?.id : event.sessionId || event.session_id;
          if (state.file.sessionId && session && ![state.file.sessionId, state.file.parentSessionId].includes(session)) throw new Error('scope-mismatch');
          for (const row of messages(event, state.file.provider)) if (row.time <= this.end && row.time >= this.earliest) {
            this._keep({time: row.time, role: row.role, sourceId: row.sourceId, fallback: row.fallback, signature: row.contentHash, id: hash(state.file.key + ':' + line.value.offset + ':' + (row.sourceId || '')), file: state.file, offset: line.value.offset, length: Buffer.byteLength(line.value.text), digest: hash(line.value.text)});
          }
        } catch (error) {if (error.message === 'scope-mismatch') throw new Error('대화 파일의 계정·세션이 변경되었습니다.'); this.malformed++;}
        if (++checked % 128 === 0) await yieldTurn();
      }
      if (!this.ready && this.scanAt === this.states.length) {
        const seen = new Map(); this.index.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
        this.index = this.index.filter(row => {const prior = seen.get(row.signature); if (prior && (row.sourceId && prior.sourceId === row.sourceId || (row.fallback || prior.fallback) && Math.abs(row.time - prior.time) < 2000)) return false; seen.set(row.signature, row); return true;});
        this.ready = true;
      }
      const handles = new Map();
      try {
        while (this.ready && this.nextIndex < this.index.length && result.length < limits.messages && chars < limits.pageText) {
          active(); const entry = this.index[this.nextIndex];
          if (this.budget.bytes + entry.length > limits.bytes) {paused = true; break;}
          let handle = handles.get(entry.file.key);
          if (!handle) {
            const real = await fs.realpath(entry.file.path);
            if (!within(entry.file.root, real) || (await fs.lstat(entry.file.path)).isSymbolicLink()) throw new Error('대화 경로가 변경되었습니다.');
            handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); handles.set(entry.file.key, handle);
            const stat = await handle.stat(); if (!stat.isFile() || await fs.realpath(entry.file.path) !== real) throw new Error('대화 파일이 변경되었습니다.');
          }
          const buffer = Buffer.alloc(entry.length), read = await handle.read(buffer, 0, buffer.length, entry.offset); this.budget.bytes += read.bytesRead;
          if (read.bytesRead !== entry.length || hash(buffer) !== entry.digest) throw new Error('대화 파일이 변경되었습니다. 다시 선택하세요.');
          const row = messages(JSON.parse(buffer.toString('utf8')), entry.file.provider).find(row => row.time === entry.time && row.role === entry.role);
          if (!row) throw new Error('대화 기록이 변경되었습니다.');
          if (chars + row.text.length > limits.pageText && result.length) break;
          result.push({id: entry.id, time: row.time, role: row.role, text: row.text, clipped: row.clipped, context: row.time < this.start}); chars += row.text.length; this.nextIndex++;
        }
      } finally {await Promise.allSettled([...handles.values()].map(handle => handle.close()));}
      active(); const hasMore = !this.ready || this.nextIndex < this.index.length; this.token = hasMore ? crypto.randomUUID() : null;
      return {items: result, next: this.token, hasMore, loading: !this.ready || paused && !result.length, scannedBytes: this.budget.bytes, limited: paused || this.unavailable || this.metadataLimited, oversizedLines: this.oversized, malformedLines: this.malformed, incompleteTail: this.partialTail};
    });
    this.queue = work.then(() => undefined, () => undefined); return work;
  }
}
module.exports = {ConversationReader, messages, limits};
