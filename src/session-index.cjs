'use strict';

// Copyright (c) 2026 jisoq; adapted from https://github.com/jisoq/Codexon.
// See licenses/Codexon-LICENSE.txt. Usage Atlas: independent async JSONL/cache implementation.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {StringDecoder} = require('node:string_decoder');

const PROVIDERS = ['codex', 'claude'];
const DAY = 86400000;
const LIMITS = Object.freeze({
    bytes: 2 * 1024 * 1024
  , milliseconds: 50
  , entries: 512
  , files: 64
  , chunk: 64 * 1024
  , line: 1024 * 1024
  , pending: 4 * 1024 * 1024
  , sources: 20000
  , directories: 20000
  , cache: 128 * 1024 * 1024
});
const NUMBERS = [
    'time'
  , 'startedAt'
  , 'completedAt'
  , 'input'
  , 'cached'
  , 'cacheWrite5m'
  , 'cacheWrite1h'
  , 'output'
  , 'reasoning'
  , 'contextWindowTokens'
  , 'contextTokens'
];
const TOKENS = ['input', 'cached', 'cacheWrite5m', 'cacheWrite1h', 'output', 'reasoning'];
const EMPTY_BUFFER = Buffer.alloc(0);
const JSON_ESCAPES = Object.freeze({'"': 34, '\\': 92, '/': 47, b: 8, f: 12, n: 10, r: 13, t: 9});
const fieldLists = new Map();
function frozenFields(values) {
  const key = values.join(',');
  const existing = fieldLists.get(key);
  if (existing) return existing;
  const list = Object.freeze(values);
  if (fieldLists.size < 256) fieldLists.set(key, list);
  return list;
}
function internMetadata(state, value) {
  for (const key of ['provider', 'accountSource', 'homeKey', 'account', 'project', 'projectName', 'model', 'effort']) {
    const text = value[key];
    if (typeof text !== 'string') continue;
    const existing = state.strings.get(text);
    if (existing !== undefined) value[key] = existing;
    else if (state.strings.size < 1024) state.strings.set(text, text);
  }
}
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const identifier = value => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value) ? value : null;
const accountHash = value => typeof value === 'string' && /^[a-f\d]{16,128}$/i.test(value) ? value : null;
const metadata = value => typeof value === 'string' && /^[\w./:-]{1,160}$/.test(value) ? value : null;
const LABEL_UNSAFE = /[\\/:\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const LABEL_INVALID = /[\\/:\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
function projectName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC');
  return normalized && normalized === normalized.trim() && !LABEL_INVALID.test(normalized)
    && normalized !== '.' && normalized !== '..' && Array.from(normalized).length <= 80 ? normalized : null;
}
function projectBasename(value) {
  const base = value.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || '';
  if (/^[a-z]:$/i.test(base)) return null;
  const name = Array.from(base.normalize('NFKC').replace(LABEL_UNSAFE, '').trim()).slice(0, 80).join('').trim();
  return projectName(name);
}
function explicitProject(value) {
  const p = object(value);
  for (const key of ['cwd', 'project_path', 'projectPath', 'project']) {
    const candidate = p[key];
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 8192
      && (key !== 'project' || /[\\/]/u.test(candidate))) return candidate;
  }
  return null;
}
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const stamp = value => typeof value === 'number' ? numeric(value) : typeof value === 'string' ? numeric(Date.parse(value)) : null;
const first = (...values) => values.find(value => value !== null && value !== undefined) ?? null;
const abort = signal => {
  if (signal?.aborted) {
    const error = new Error('Session index scan aborted');
    error.name = 'AbortError';
    throw error;
  }
};
function modeOf(source) {
  for (const key of ['mode', 'service_tier', 'serviceTier', 'speed']) {
    const value = typeof source[key] === 'string' ? source[key].toLowerCase() : null;
    if (['standard', 'default'].includes(value)) return 'Standard';
    if (['fast', 'priority'].includes(value)) return 'Fast';
    if (value === 'ultrafast') return 'Ultrafast';
  }
  return 'unknown';
}
function tokenValues(usage, provider) {
  const u = object(usage);
  const ttl = object(u.cache_creation);
  const cached = numeric(first(u.cached_input_tokens, u.cache_read_input_tokens, u.input_tokens_details?.cached_tokens));
  const cacheWrite5m = numeric(first(ttl.ephemeral_5m_input_tokens, u.cache_write_5m_input_tokens));
  const cacheWrite1h = numeric(first(ttl.ephemeral_1h_input_tokens, u.cache_write_1h_input_tokens));
  const nativeInput = numeric(u.input_tokens);
  const creation = numeric(first(u.cache_creation_input_tokens, u.cache_write_input_tokens, u.input_tokens_details?.cache_write_tokens));
  const splitCreation = cacheWrite5m !== null && cacheWrite1h !== null ? cacheWrite5m + cacheWrite1h : null;
  const writeTotal = first(creation, splitCreation);
  return {
      input: provider === 'claude'
        ? nativeInput !== null && cached !== null && writeTotal !== null ? nativeInput + cached + writeTotal : null
        : nativeInput
    , cached
    , cacheWrite5m
    , cacheWrite1h
    , output: numeric(u.output_tokens)
    , reasoning: numeric(first(u.reasoning_output_tokens, u.output_tokens_details?.reasoning_tokens))
    , nativeInput
    , writeTotal
    , ttlUnknown: writeTotal !== null && (cacheWrite5m === null || cacheWrite1h === null)
  };
}
function cleanContext(value = {}) {
  const v = object(value);
  return {
      sessionId: identifier(v.sessionId)
    , parentSessionId: identifier(v.parentSessionId)
    , project: accountHash(v.project)
    , projectName: projectName(v.projectName)
    , model: metadata(v.model)
    , effort: metadata(v.effort)
    , mode: ['Standard', 'Fast', 'Ultrafast'].includes(v.mode) ? v.mode : 'unknown'
    , turnId: identifier(v.turnId)
    , turnStartedAt: numeric(v.turnStartedAt)
    , lastActivity: numeric(v.lastActivity)
    , running: typeof v.running === 'boolean' ? v.running : null
    , modern: v.modern === true
    , cumulative: v.cumulative ? Object.fromEntries(TOKENS.map(key => [key, numeric(v.cumulative[key])])) : null
    , cumulativeSignature: accountHash(v.cumulativeSignature)
    , compactionEpoch: numeric(v.compactionEpoch) ?? 0
    , resetEpoch: numeric(v.resetEpoch) ?? 0
    , contextWindowTokens: numeric(v.contextWindowTokens)
    , contextTokens: numeric(v.contextTokens)
    , pendingCompaction: v.pendingCompaction === true
    , pendingReset: v.pendingReset === true
  };
}
function cleanSource(raw) {
  if (!accountHash(raw.key) || !accountHash(raw.homeKey) || !PROVIDERS.includes(raw.provider)) throw new Error('cache source');
  return {
      key: raw.key
    , homeKey: raw.homeKey
    , provider: raw.provider
    , account: accountHash(raw.account)
    , accountSource: ['source-metadata', 'local-root-assumption'].includes(raw.accountSource) ? raw.accountSource : 'unknown'
    , offset: numeric(raw.offset) ?? 0
    , readOffset: numeric(raw.offset) ?? 0
    , line: numeric(raw.line) ?? 0
    , headHash: accountHash(raw.headHash)
    , headLength: Math.min(256, numeric(raw.headLength) ?? 0)
    , tailHash: accountHash(raw.tailHash)
    , tailLength: Math.min(256, numeric(raw.tailLength) ?? 0)
    , size: numeric(raw.size) ?? 0
    , mtime: numeric(raw.mtime) ?? 0
    , ctime: numeric(raw.ctime) ?? 0
    , ino: numeric(raw.ino)
    , dev: numeric(raw.dev)
    , skip: raw.skip === true
    , malformed: numeric(raw.malformed) ?? 0
    , oversized: numeric(raw.oversized) ?? 0
    , rewrites: numeric(raw.rewrites) ?? 0
    , streamId: identifier(raw.streamId)
    , ctx: cleanContext(raw.ctx)
    , pending: EMPTY_BUFFER
    , path: null
  };
}
function cleanCall(value) {
  const v = object(value);
  if (!accountHash(v.id) || !PROVIDERS.includes(v.provider) || !accountHash(v.homeKey)) return null;
  const p = object(v.provenance);
  const call = {
      id: v.id
    , provider: v.provider
    , account: accountHash(v.account)
    , accountSource: ['source-metadata', 'local-root-assumption'].includes(v.accountSource) ? v.accountSource : 'unknown'
    , homeKey: v.homeKey
    , time: numeric(v.time)
    , startedAt: numeric(v.startedAt)
    , completedAt: numeric(v.completedAt)
    , input: numeric(v.input)
    , cached: numeric(v.cached)
    , cacheWrite5m: numeric(v.cacheWrite5m)
    , cacheWrite1h: numeric(v.cacheWrite1h)
    , output: numeric(v.output)
    , reasoning: numeric(v.reasoning)
    , contextWindowTokens: numeric(v.contextWindowTokens)
    , contextTokens: numeric(v.contextTokens)
    , sessionId: identifier(v.sessionId)
    , parentSessionId: identifier(v.parentSessionId)
    , project: accountHash(v.project)
    , projectName: projectName(v.projectName)
    , model: metadata(v.model)
    , effort: metadata(v.effort)
    , mode: ['Standard', 'Fast', 'Ultrafast'].includes(v.mode) ? v.mode : 'unknown'
    , completionState: ['in_progress', 'completed', 'failed', 'cancelled', 'incomplete'].includes(v.completionState) ? v.completionState : 'unknown'
    , turnId: identifier(v.turnId)
    , requestId: identifier(v.requestId)
    , messageId: identifier(v.messageId)
    , compactionEpoch: numeric(v.compactionEpoch)
    , resetEpoch: numeric(v.resetEpoch)
    , provenance: {
        source: ['codex-token-usage-record', 'codex-response', 'codex-token-count', 'claude-assistant', 'claude-stream'].includes(p.source) ? p.source : 'unknown'
      , fileKey: accountHash(p.fileKey)
      , line: numeric(p.line)
      , inputSemantics: v.provider === 'claude' ? 'exclusive-plus-cache' : 'inclusive'
      , nativeInput: numeric(p.nativeInput)
      , cacheWriteTotal: numeric(p.cacheWriteTotal)
      , reasoningIsSubsetOfOutput: true
      , orphan: p.orphan === true
      , cumulativeDelta: p.cumulativeDelta === true
      , observedAt: numeric(p.observedAt)
      , compaction: p.compaction === true
      , contextReset: p.contextReset === true
      , unsupportedTokenCategories: []
    }
    , missingFields: []
  };
  call.provenance.unsupportedTokenCategories = [
      ...(call.provenance.cacheWriteTotal !== null && (call.cacheWrite5m === null || call.cacheWrite1h === null) ? ['cacheWriteTTL'] : [])
    , ...(call.provider === 'claude' && call.input === null && call.provenance.nativeInput !== null ? ['inputCacheBreakdown'] : [])
    , ...(call.reasoning === null ? ['reasoning'] : [])
  ];
  call.missingFields = [
      ...NUMBERS.filter(key => call[key] === null)
    , ...['account', 'sessionId', 'project', 'model', 'effort'].filter(key => call[key] === null)
    , ...(call.mode === 'unknown' ? ['mode'] : [])
    , ...(call.completionState === 'unknown' ? ['completionState'] : [])
    , ...call.provenance.unsupportedTokenCategories
  ];
  call.provenance.unsupportedTokenCategories = frozenFields(call.provenance.unsupportedTokenCategories);
  Object.freeze(call.provenance);
  call.missingFields = frozenFields(call.missingFields);
  return Object.freeze(call);
}
function sameCall(a, b) {
  for (const key in a) {
    if (key !== 'provenance' && key !== 'missingFields' && a[key] !== b[key]) return false;
  }
  for (const key in a.provenance) {
    if (key !== 'unsupportedTokenCategories' && a.provenance[key] !== b.provenance[key]) return false;
  }
  const equal = (left, right) => left === right || left.length === right.length && left.every((value, i) => value === right[i]);
  return equal(a.missingFields, b.missingFields) && equal(a.provenance.unsupportedTokenCategories, b.provenance.unsupportedTokenCategories);
}

// Legacy envelopes contain one giant object/string. Slice only individual array entries.
class LegacyData {
  constructor(accept) {
    this.accept = accept;
    this.counts = {records: 0, files: 0};
    this.phase = 'open';
    this.seen = new Set();
    this.key = null;
    this.token = '';
    this.parts = [];
    this.length = 0;
    this.depth = 0;
    this.string = false;
    this.escape = false;
    this.checksum = crypto.createHash('sha256');
    this.highSurrogate = '';
    this.revision = 0;
  }

  hash(text) {
    const joined = this.highSurrogate + text;
    const code = joined.charCodeAt(joined.length - 1);
    const high = code >= 0xd800 && code <= 0xdbff;
    this.highSurrogate = high ? joined.slice(-1) : '';
    this.checksum.update(high ? joined.slice(0, -1) : joined);
  }

  feed(text, start = 0, trailing = false) {
    let part = this.phase === 'entry' ? start : -1;
    let end = start;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (this.phase === 'entry') {
        if (this.string) {
          if (this.escape) this.escape = false;
          else if (char === '\\') this.escape = true;
          else if (char === '"') this.string = false;
        } else if (char === '"') this.string = true;
        else if (char === '{' || char === '[') this.depth++;
        else if (char === '}' || char === ']') this.depth--;
        if (this.depth === 0) {
          if (++this.counts[this.key] > (this.key === 'records' ? 50000 : LIMITS.sources)) throw new Error('cache entries limit');
          this.capture(text.slice(part, i + 1));
          this.accept(this.key, JSON.parse(this.parts.join('')));
          this.parts = [];
          this.length = 0;
          part = -1;
          this.phase = 'arrayAfter';
        }
      } else if (this.phase === 'keyToken') {
        this.token += char;
        if (this.token.length > 128) throw new Error('cache key');
        if (this.escape) this.escape = false;
        else if (char === '\\') this.escape = true;
        else if (char === '"') {
          this.key = JSON.parse(this.token);
          if (!['revision', 'records', 'files'].includes(this.key) || this.seen.has(this.key)) throw new Error('cache field');
          this.seen.add(this.key);
          this.phase = 'colon';
        }
      } else if (this.phase === 'number') {
        if (/[\s,}]/u.test(char)) {
          this.revision = JSON.parse(this.token);
          if (!Number.isSafeInteger(this.revision) || this.revision < 0) throw new Error('cache revision');
          this.phase = 'after';
          i--;
        } else {
          this.token += char;
          if (this.token.length > 32) throw new Error('cache number');
        }
      } else if (/\s/u.test(char)) continue;
      else if (this.phase === 'open' && char === '{') this.phase = 'keyFirst';
      else if (['keyFirst', 'keyNext'].includes(this.phase) && char === '"') {
        this.token = '"';
        this.escape = false;
        this.phase = 'keyToken';
      } else if (this.phase === 'colon' && char === ':') this.phase = 'value';
      else if (this.phase === 'value' && this.key === 'revision') {
        this.token = char;
        this.phase = 'number';
      } else if (this.phase === 'value' && char === '[') this.phase = 'arrayFirst';
      else if (['arrayFirst', 'arrayNext'].includes(this.phase) && char === '{') {
        this.depth = 1;
        this.string = this.escape = false;
        part = i;
        this.phase = 'entry';
      } else if (['arrayFirst', 'arrayAfter'].includes(this.phase) && char === ']') this.phase = 'after';
      else if (this.phase === 'arrayAfter' && char === ',') this.phase = 'arrayNext';
      else if (this.phase === 'after' && char === ',') this.phase = 'keyNext';
      else if (this.phase === 'after' && char === '}' && this.seen.size === 3) {
        this.phase = 'done';
        if (!trailing) { end = i + 1; this.hash(text.slice(start, end)); return end; }
      } else throw new Error('cache data grammar');
      end = i + 1;
    }
    if (part !== -1) this.capture(text.slice(part));
    this.hash(text.slice(start));
    return text.length;
  }

  capture(part) {
    this.length += Buffer.byteLength(part);
    if (this.length > LIMITS.line) throw new Error('cache entry limit');
    this.parts.push(part);
  }

  digest() {
    if (this.phase !== 'done') throw new Error('cache data incomplete');
    if (this.highSurrogate) this.checksum.update(this.highSurrogate);
    return this.checksum.digest('hex');
  }
}

class LegacyEnvelope {
  constructor(accept) {
    this.data = new LegacyData(accept);
    this.phase = 'open';
    this.seen = new Set();
    this.values = {};
    this.key = null;
    this.token = '';
    this.escape = false;
    this.unicode = null;
    this.decoded = new Uint16Array(LIMITS.chunk);
    this.decodedLength = 0;
    this.encoding = null;
  }

  flushDecoded() {
    if (this.decodedLength) {
      const bytes = Buffer.from(this.decoded.buffer, 0, this.decodedLength * 2);
      if (os.endianness() !== 'LE') bytes.swap16();
      this.data.feed(bytes.toString('utf16le'), 0, true);
    }
    this.decodedLength = 0;
  }

  decode(code) {
    if (this.decodedLength === this.decoded.length) this.flushDecoded();
    this.decoded[this.decodedLength++] = code;
  }

  feed(text) {
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.phase === 'dataObject') {
        i = this.data.feed(text, i) - 1;
        if (this.data.phase === 'done') this.phase = 'after';
      } else if (this.phase === 'dataString') {
        if (this.unicode !== null) {
          if (!/[a-f\d]/iu.test(char)) throw new Error('cache unicode');
          this.unicode += char;
          if (this.unicode.length === 4) { this.decode(parseInt(this.unicode, 16)); this.unicode = null; }
        } else if (this.escape) {
          this.escape = false;
          if (char === 'u') this.unicode = '';
          else {
            const decoded = JSON_ESCAPES[char];
            if (decoded === undefined) throw new Error('cache escape');
            this.decode(decoded);
          }
        } else if (char === '\\') this.escape = true;
        else if (char === '"') { this.flushDecoded(); this.phase = 'after'; }
        else {
          if (char.charCodeAt(0) < 32) throw new Error('cache string');
          this.decode(char.charCodeAt(0));
        }
      } else if (this.phase === 'keyToken' || this.phase === 'stringToken') {
        this.token += char;
        if (this.token.length > 256) throw new Error('cache token');
        if (this.escape) this.escape = false;
        else if (char === '\\') this.escape = true;
        else if (char === '"') {
          const value = JSON.parse(this.token);
          if (this.phase === 'keyToken') {
            if (!['version', 'checksum', 'data'].includes(value) || this.seen.has(value)) throw new Error('cache envelope field');
            this.key = value;
            this.seen.add(value);
            this.phase = 'colon';
          } else { this.values[this.key] = value; this.phase = 'after'; }
        }
      } else if (this.phase === 'number') {
        if (/[\s,}]/u.test(char)) { this.values[this.key] = JSON.parse(this.token); this.phase = 'after'; i--; }
        else { this.token += char; if (this.token.length > 32) throw new Error('cache number'); }
      } else if (/\s/u.test(char)) continue;
      else if (this.phase === 'open' && char === '{') this.phase = 'keyFirst';
      else if (['keyFirst', 'keyNext'].includes(this.phase) && char === '"') { this.token = '"'; this.escape = false; this.phase = 'keyToken'; }
      else if (this.phase === 'colon' && char === ':') this.phase = 'value';
      else if (this.phase === 'value' && this.key === 'data' && char === '{') { this.encoding = 2; this.phase = 'dataObject'; i--; }
      else if (this.phase === 'value' && this.key === 'data' && char === '"') { this.encoding = 1; this.phase = 'dataString'; }
      else if (this.phase === 'value' && char === '"') { this.token = '"'; this.escape = false; this.phase = 'stringToken'; }
      else if (this.phase === 'value' && this.key === 'version') { this.token = char; this.phase = 'number'; }
      else if (this.phase === 'after' && char === ',') this.phase = 'keyNext';
      else if (this.phase === 'after' && char === '}' && this.seen.size === 3) this.phase = 'done';
      else throw new Error('cache envelope grammar');
    }
    if (this.phase === 'dataString') this.flushDecoded();
  }

  finish() {
    if (this.phase !== 'done' || this.values.version !== this.encoding || this.data.digest() !== this.values.checksum) throw new Error('cache checksum');
    return this.data.revision;
  }
}

/** Metadata only. Roots may be strings or arrays (including WSL/UNC paths); [] disables a provider. */
class SessionIndex {
  constructor({dir, retentionDays = 90, maxCalls = 50000} = {}) {
    this.dir = dir || path.join(os.homedir(), '.usage-atlas', 'session-index');
    this.file = path.join(this.dir, 'session-index.json');
    this.retentionDays = Math.min(3650, Math.max(1, numeric(retentionDays) ?? 90));
    this.maxCalls = Math.min(50000, Math.max(1, Math.floor(numeric(maxCalls) ?? 50000)));
    this._records = new Map();
    this._callCache = null;
    this._modernSessions = new Set();
    this._legacySessions = new Map();
    this._messageKeys = new Map();
    this._urgentFiles = [];
    this._files = new Map();
    this._directories = new Map();
    this._roots = new Map();
    this._fileKeys = [];
    this._directoryKeys = [];
    this._fileCursor = 0;
    this._directoryCursor = 0;
    this._revision = 0;
    this._diskStamp = null;
    this._loaded = false;
    this._writer = false;
    this._dirty = false;
    this._disposed = false;
    this._queue = Promise.resolve();
    this._now = Date.now();
    this._lastWork = {bytes: 0, entries: 0, files: 0, partial: false, scanMs: 0};
    this._cacheRecovered = false;
    this._cacheWriteFailed = false;
    this._needsMigration = false;
    this._limited = false;
  }

  get calls() { return this._callView().calls; }
  get activity() { return this.snapshot().activity; }
  get coverage() { return this.snapshot().coverage; }
  get revision() { return this._revision; }

  _exclusive(fn) {
    const next = this._queue.then(async () => {
      if (this._disposed) throw new Error('Session index disposed');
      return await fn();
    });
    this._queue = next.catch(() => {});
    return next;
  }

  async load() {
    return await this._exclusive(async () => {
      await this._load();
      return this.snapshot();
    });
  }

  async conversationSources({provider, account, sessionId, homeKey}) {
    return await this._exclusive(async () => {
      await this._load();
      const keys = new Set();
      for (const {call, sources} of this._records.values()) if (call.provider === provider && call.account === account && call.sessionId === sessionId && call.homeKey === homeKey) {
        for (const key of [...sources, call.provenance?.fileKey].filter(Boolean)) keys.add(key);
      }
      return [...keys].map(key => this._files.get(key)).filter(source => source && source.provider === provider && source.account === account && source.homeKey === homeKey)
        .map(source => ({key: source.key, provider, account, homeKey, sessionId, parentSessionId: source.ctx.parentSessionId, path: source.path, headHash: source.headHash, headLength: source.headLength}));
    });
  }

  async _load() {
    // A window that has scanned owns live cursors. Reader refreshes must never replace them.
    if (this._writer) return;
    let stat;
    try { stat = await fs.stat(this.file, {bigint: true}); }
    catch (error) {
      if (error.code !== 'ENOENT') this._cacheRecovered = true;
      this._loaded = true;
      return;
    }
    const signature = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
    if (this._loaded && signature === this._diskStamp) return;
    try {
      if (stat.size > LIMITS.cache) throw new Error('cache limit');
      const handle = await fs.open(this.file, 'r');
      let loaded;
      try {
        const head = Buffer.alloc(64);
        await handle.read(head, 0, head.length, 0);
        loaded = head.toString('utf8').startsWith('{"version":3,')
          ? await this._loadLines(handle) : await this._loadLegacy(handle);
        this._needsMigration = !head.toString('utf8').startsWith('{"version":3,');
      } finally { await handle.close(); }
      this._records = loaded.records;
      this._callCache = null;
      this._files = loaded.files;
      this._rebuildLookups();
      this._fileKeys = [...loaded.files.keys()];
      this._revision = loaded.revision;
      this._diskStamp = signature;
    } catch {
      // Retain the last valid reader snapshot; a fresh writer rebuilds from source files.
      this._cacheRecovered = true;
      this._diskStamp = signature;
    }
    this._loaded = true;
  }

  _cacheCall(state, item) {
    if (++state.recordCount > 50000) throw new Error('cache calls limit');
    const raw = object(item.call);
    internMetadata(state, raw);
    const source = state.files.get(raw.provenance?.fileKey) || state.hints.get(raw.provenance?.fileKey);
    if (source) {
      for (const key of ['sessionId', 'parentSessionId', 'project', 'projectName', 'model', 'effort']) {
        if (raw[key] === source.ctx[key]) raw[key] = source.ctx[key];
      }
      raw.provenance.fileKey = source.key;
    }
    let call = cleanCall(raw);
    if (!call) throw new Error('cache call');
    const previous = this._records.get(call.id)?.call;
    if (previous && sameCall(previous, call)) call = previous;
    const sources = [];
    if (Array.isArray(item.sources)) {
      for (const key of item.sources) {
        if (accountHash(key)) sources.push(state.files.get(key)?.key || state.hints.get(key)?.key || key);
        if (sources.length === 32) break;
      }
    }
    state.records.set(call.id, {call, sources});
    if (!source && call.provenance.fileKey && state.hints.size < LIMITS.sources) {
      state.hints.set(call.provenance.fileKey, {key: call.provenance.fileKey, ctx: call});
    }
    if (state.records.size > this.maxCalls) state.records.delete(state.records.keys().next().value);
  }

  _cacheFile(state, raw) {
    if (++state.fileCount > LIMITS.sources) throw new Error('cache sources limit');
    internMetadata(state, raw);
    internMetadata(state, object(raw.ctx));
    const hint = state.hints.get(raw.key);
    if (hint) {
      raw.key = hint.key;
      for (const key of ['sessionId', 'parentSessionId', 'project', 'projectName', 'model', 'effort']) {
        if (raw.ctx?.[key] === hint.ctx[key]) raw.ctx[key] = hint.ctx[key];
      }
    }
    const source = cleanSource(raw);
    state.files.set(source.key, source);
  }

  async _loadLegacy(handle) {
    const state = {records: new Map(), files: new Map(), strings: new Map(), hints: new Map(), revision: 0, recordCount: 0, fileCount: 0};
    const buffer = Buffer.alloc(16 * 1024);
    const parser = new LegacyEnvelope((kind, value) => kind === 'records' ? this._cacheCall(state, value) : this._cacheFile(state, value));
    const decoder = new StringDecoder('utf8');
    let offset = 0;
    while (true) {
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > LIMITS.cache) throw new Error('cache limit');
      parser.feed(decoder.write(buffer.subarray(0, bytesRead)));
    }
    parser.feed(decoder.end());
    state.revision = parser.finish();
    return state;
  }

  async _loadLines(handle) {
    const state = {records: new Map(), files: new Map(), strings: new Map(), hints: new Map(), revision: 0, recordCount: 0, fileCount: 0};
    const checksum = crypto.createHash('sha256');
    let header;
    let complete = false;
    let pending = Buffer.alloc(0);
    let offset = 0;
    const buffer = Buffer.alloc(LIMITS.chunk);
    while (true) {
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > LIMITS.cache) throw new Error('cache limit');
      const chunk = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let at = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, at)) {
        if (complete || end - at > LIMITS.line) throw new Error('cache line');
        const raw = chunk.subarray(at, end);
        const value = JSON.parse(raw.toString('utf8'));
        if (!header) {
          if (value.version !== 3 || !Number.isSafeInteger(value.revision) || value.revision < 0
            || !Number.isSafeInteger(value.calls) || value.calls < 0 || value.calls > 50000
            || !Number.isSafeInteger(value.files) || value.files < 0 || value.files > LIMITS.sources) throw new Error('cache header');
          header = value;
          state.revision = value.revision;
        } else if (value.kind === 'file') this._cacheFile(state, object(value.value));
        else if (value.kind === 'call') this._cacheCall(state, object(value.value));
        else if (value.kind === 'checksum') {
          if (checksum.digest('hex') !== value.checksum || state.recordCount !== header.calls || state.fileCount !== header.files
            || state.files.size !== state.fileCount || state.records.size !== Math.min(state.recordCount, this.maxCalls)) throw new Error('cache checksum');
          complete = true;
        } else throw new Error('cache entry');
        if (!complete) checksum.update(chunk.subarray(at, end + 1));
        at = end + 1;
      }
      pending = Buffer.from(chunk.subarray(at));
      if (pending.length > LIMITS.line) throw new Error('cache line limit');
    }
    if (!complete || pending.length) throw new Error('cache incomplete');
    return state;
  }

  async scan({codexHome, claudeDir, accounts = {}, now = Date.now(), signal} = {}) {
    return await this._exclusive(async () => {
      abort(signal);
      if (!this._loaded) await this._load();
      this._writer = true;
      this._now = numeric(now) ?? Date.now();
      this._configureRoots(codexHome, claudeDir, accounts);
      const budget = {
          start: performance.now()
        , bytes: 0
        , entries: 0
        , files: 0
        , operations: 0
      };
      try {
        // Reach recent date directories before an old large file can spend the read budget.
        for (let i = 0; i < 4 && this._directoryKeys.length && this._available(budget); i++) {
          abort(signal);
          await this._discover(budget);
        }
        // Newly discovered files get a small fast lane, leaving most of the budget for the fair cursor.
        for (let i = 0; i < 4 && this._urgentFiles.length && this._available(budget); i++) {
          abort(signal);
          const source = this._files.get(this._urgentFiles.pop());
          if (source?.path && this._roots.get(source.homeKey)?.enabled) {
            await this._read(source, budget, signal, 64 * 1024);
            budget.files++;
          }
        }
        let fileSteps = 0;
        let directorySteps = 0;
        const fileTarget = Math.min(this._fileKeys.length + LIMITS.files, LIMITS.files);
        while (this._available(budget)) {
          abort(signal);
          let work = false;
          if (directorySteps < LIMITS.entries && this._directoryKeys.length) {
            await this._discover(budget);
            work = true;
            directorySteps++;
          }
          if (fileSteps < fileTarget && budget.files < LIMITS.files && this._fileKeys.length) {
            const key = this._fileKeys[this._fileCursor++ % this._fileKeys.length];
            const source = this._files.get(key);
            if (source?.path && this._roots.get(source.homeKey)?.enabled) {
              await this._read(source, budget, signal);
              budget.files++;
            }
            fileSteps++;
            work = true;
          }
          const filesDone = fileSteps >= fileTarget || budget.files >= LIMITS.files;
          if (!work || directorySteps >= LIMITS.entries && filesDone) break;
          if (directorySteps >= this._directoryKeys.length && !this._directoryKeys.some(key => this._directories.get(key)?.handle) && filesDone) break;
        }
        this._trim();
        this._lastWork = {
            bytes: budget.bytes
          , entries: budget.entries
          , files: budget.files
          , partial: !this._available(budget) || this._fileKeys.length > fileSteps || [...this._directories.values()].some(d => d.handle || !d.visited)
        };
        if (this._dirty || this._needsMigration) {
          this._revision++;
          await this._persist();
        }
        this._lastWork.scanMs = performance.now() - budget.start;
        return this.snapshot();
      } finally {
        this._boundPending();
      }
    });
  }

  _available(budget) {
    return budget.bytes < LIMITS.bytes && budget.entries < LIMITS.entries
      && budget.operations < 1024 && performance.now() - budget.start < LIMITS.milliseconds;
  }

  _configureRoots(codexHome, claudeDir, accounts) {
    for (const root of this._roots.values()) root.enabled = false;
    for (const provider of PROVIDERS) {
      const configured = provider === 'codex'
        ? codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
        : claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
      const homes = Array.isArray(configured) ? configured : [configured];
      for (const home of homes.slice(0, 32)) {
        if (typeof home !== 'string' || !home) continue;
        const resolved = path.resolve(home);
        const key = hash(`${provider}:${resolved}`);
        const previous = this._roots.get(key);
        const account = accountHash(accounts[provider]);
        const switched = previous?.switched || Boolean(previous?.account && account && previous.account !== account);
        this._roots.set(key, {key, provider, account, switched, enabled: true});
        for (const name of provider === 'codex' ? ['sessions', 'archived_sessions'] : ['projects']) {
          this._addDirectory(path.join(resolved, name), key, provider);
        }
        if (provider === 'codex') {
          for (let days = 0; days < 2; days++) {
            const date = new Date(this._now - days * DAY).toISOString().slice(0, 10).split('-');
            this._addDirectory(path.join(resolved, 'sessions', ...date), key, provider);
          }
        }
      }
    }
  }

  _addDirectory(directory, homeKey, provider) {
    const key = hash(`${provider}:${directory}`);
    if (this._directories.has(key)) return;
    if (this._directories.size >= LIMITS.directories) { this._limited = true; return; }
    this._directories.set(key, {path: directory, homeKey, provider, handle: null, stamp: null, visited: false});
    this._directoryKeys.push(key);
  }

  async _discover(budget) {
    const key = this._directoryKeys[this._directoryCursor++ % this._directoryKeys.length];
    const directory = this._directories.get(key);
    if (!directory || !this._roots.get(directory.homeKey)?.enabled) return false;
    budget.operations++;
    try {
      if (!directory.handle) {
        const stat = await fs.lstat(directory.path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { directory.visited = true; return false; }
        const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
        if (directory.visited && directory.stamp === signature) return false;
        directory.stamp = signature;
        directory.handle = await fs.opendir(directory.path, {bufferSize: 16});
      }
      const entry = await directory.handle.read();
      budget.entries++;
      if (!entry) {
        await directory.handle.close();
        directory.handle = null;
        directory.visited = true;
        return false;
      }
      const fullPath = path.join(directory.path, entry.name);
      if (entry.isDirectory()) this._addDirectory(fullPath, directory.homeKey, directory.provider);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) this._addFile(fullPath, directory);
      return true;
    } catch (error) {
      if (directory.handle) await directory.handle.close().catch(() => {});
      directory.handle = null;
      directory.visited = true;
      directory.unavailable = !['ENOENT', 'ENOTDIR'].includes(error.code);
      return false;
    }
  }

  _addFile(fullPath, directory) {
    const key = hash(`${directory.provider}:${fullPath}`);
    const existing = this._files.get(key);
    if (existing) {
      if (!existing.path) this._urgentFiles.push(key);
      existing.path = fullPath;
      return;
    }
    if (this._files.size >= LIMITS.sources) { this._limited = true; return; }
    const root = this._roots.get(directory.homeKey);
    const parts = fullPath.split(/[\\/]/);
    const child = parts.lastIndexOf('subagents');
    const parent = child >= 1 ? identifier(parts[child - 1]) : null;
    const base = path.basename(fullPath, '.jsonl');
    const session = directory.provider === 'claude' ? identifier(base) : identifier(base.match(/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i)?.[1]);
    this._files.set(key, {
        key
      , path: fullPath
      , homeKey: directory.homeKey
      , provider: directory.provider
      , account: root.account
      , accountSource: root.account ? 'local-root-assumption' : 'unknown'
      , offset: 0
      , readOffset: 0
      , line: 0
      , size: 0
      , mtime: 0
      , ctime: 0
      , headHash: null
      , headLength: 0
      , tailHash: null
      , tailLength: 0
      , skip: false
      , malformed: 0
      , oversized: 0
      , rewrites: 0
      , pending: Buffer.alloc(0)
      , ctx: cleanContext({sessionId: session, parentSessionId: parent})
    });
    this._fileKeys.push(key);
    this._urgentFiles.push(key);
    if (this._urgentFiles.length > LIMITS.files) this._urgentFiles.shift();
    this._dirty = true;
  }

  async _range(handle, at, length, budget) {
    const buffer = Buffer.alloc(Math.min(length, Math.max(0, LIMITS.bytes - budget.bytes)));
    if (!buffer.length) return buffer;
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, at);
    budget.bytes += bytesRead;
    return buffer.subarray(0, bytesRead);
  }

  _reset(source) {
    for (const [key, record] of this._records) {
      record.sources = record.sources.filter(fileKey => fileKey !== source.key);
      if (!record.sources.length) this._records.delete(key);
    }
    this._callCache = null;
    const parts = source.path.split(/[\\/]/);
    const child = parts.lastIndexOf('subagents');
    source.ctx = cleanContext({
        sessionId: source.provider === 'claude' ? identifier(path.basename(source.path, '.jsonl')) : null
      , parentSessionId: child >= 1 ? identifier(parts[child - 1]) : null
    });
    source.offset = source.readOffset = source.line = 0;
    source.pending = Buffer.alloc(0);
    source.headHash = source.tailHash = null;
    source.headLength = source.tailLength = 0;
    source.skip = false;
    source.streamId = null;
    source.rewrites++;
    this._rebuildLookups();
    this._dirty = true;
  }

  _sessionKey(source) {
    return `${source.homeKey}:${source.ctx.sessionId || source.key}`;
  }

  _rebuildLookups() {
    this._modernSessions.clear();
    this._legacySessions.clear();
    this._messageKeys.clear();
    for (const source of this._files.values()) {
      if (source.provider === 'codex' && source.ctx.modern) this._modernSessions.add(this._sessionKey(source));
    }
    for (const record of this._records.values()) {
      this._rememberMessage(record.call);
      this._rememberLegacy(record.call);
    }
  }

  _rememberLegacy(call) {
    if (call.provenance.source !== 'codex-token-count') return;
    const key = `${call.homeKey}:${call.sessionId || call.provenance.fileKey}`;
    const ids = this._legacySessions.get(key) || new Set();
    ids.add(call.id);
    this._legacySessions.set(key, ids);
  }

  _rememberMessage(call) {
    if (call.provider !== 'claude' || !call.messageId) return;
    const key = `${call.homeKey}:${call.messageId}`;
    const previous = this._messageKeys.get(key);
    if (!previous || !(previous instanceof Map) && (!previous.requestId || previous.requestId === call.requestId)) {
      this._messageKeys.set(key, {requestId: call.requestId, id: call.id});
      return;
    }
    const requests = previous instanceof Map ? previous : new Map([[previous.requestId || '', previous.id]]);
    if (call.requestId) requests.delete('');
    requests.set(call.requestId || '', call.id);
    this._messageKeys.set(key, requests);
  }

  _markModern(source) {
    const sessionKey = this._sessionKey(source);
    if (!this._modernSessions.has(sessionKey)) {
      for (const id of this._legacySessions.get(sessionKey) || []) {
        this._records.delete(id);
        this._callCache = null;
      }
      this._legacySessions.delete(sessionKey);
      this._modernSessions.add(sessionKey);
    }
    source.ctx.modern = true;
  }

  async _read(source, budget, signal, maxBytes = LIMITS.bytes) {
    if (LIMITS.bytes - budget.bytes < 1024 || !this._available(budget)) return;
    budget.operations++;
    let handle;
    const initialBytes = budget.bytes;
    try {
      const stat = await fs.lstat(source.path);
      if (!stat.isFile() || stat.isSymbolicLink()) { source.unavailable = true; return; }
      source.unavailable = false;
      if (stat.size === source.size && stat.mtimeMs === source.mtime && stat.ctimeMs === source.ctime && source.readOffset >= stat.size) return;
      handle = await fs.open(source.path, 'r');
      let rewritten = stat.size < source.readOffset
        || source.ino !== undefined && source.ino !== null && (stat.ino !== source.ino || stat.dev !== source.dev)
        || source.headHash && stat.size <= source.size && (source.mtime !== stat.mtimeMs || source.ctime !== stat.ctimeMs);
      if (!rewritten && source.headHash) rewritten = digest(await this._range(handle, 0, source.headLength, budget)) !== source.headHash;
      if (!rewritten && source.tailHash && source.offset) rewritten = digest(await this._range(handle, source.offset - source.tailLength, source.tailLength, budget)) !== source.tailHash;
      if (rewritten) this._reset(source);
      source.size = stat.size;
      source.mtime = stat.mtimeMs;
      source.ctime = stat.ctimeMs;
      source.ino = stat.ino;
      source.dev = stat.dev;
      if (!source.headHash && stat.size && this._available(budget)) {
        const head = await this._range(handle, 0, Math.min(256, stat.size), budget);
        source.headLength = head.length;
        source.headHash = digest(head);
      }
      while (source.readOffset < stat.size && this._available(budget) && budget.bytes - initialBytes < maxBytes) {
        abort(signal);
        const chunk = await this._range(handle, source.readOffset, Math.min(LIMITS.chunk, stat.size - source.readOffset, maxBytes - (budget.bytes - initialBytes)), budget);
        if (!chunk.length) break;
        const start = source.readOffset;
        source.readOffset += chunk.length;
        let at = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, at)) {
          const part = chunk.subarray(at, end);
          source.line++;
          if (!source.skip && source.pending.length + part.length <= LIMITS.line) {
            const line = source.pending.length ? Buffer.concat([source.pending, part]) : part;
            if (line.length) this._consume(source, line);
          } else if (!source.skip) source.oversized++;
          source.pending = Buffer.alloc(0);
          source.skip = false;
          source.offset = start + end + 1;
          // Hashes, never raw tail fragments, are persisted for append/rewrite checks.
          const tailLength = Math.min(256, end + 1);
          source.tailLength = tailLength;
          source.tailHash = digest(chunk.subarray(end + 1 - tailLength, end + 1));
          at = end + 1;
        }
        const tail = chunk.subarray(at);
        if (source.skip || source.pending.length + tail.length > LIMITS.line) {
          if (!source.skip) source.oversized++;
          source.pending = Buffer.alloc(0);
          source.skip = true;
          source.offset = source.readOffset;
          source.tailLength = Math.min(256, chunk.length);
          source.tailHash = digest(chunk.subarray(chunk.length - source.tailLength));
        } else source.pending = Buffer.concat([source.pending, tail]);
        this._dirty = true;
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      source.unavailable = true;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  _consume(source, line) {
    let event;
    try { event = object(JSON.parse(line.toString('utf8'))); }
    catch { source.malformed++; return; }
    const time = stamp(first(event.timestamp, event.ts));
    const ctx = source.ctx;
    if (time !== null) ctx.lastActivity = Math.max(ctx.lastActivity ?? 0, time);
    if (source.provider === 'codex') this._codex(source, event, time);
    else this._claude(source, event, time);
  }

  _context(source, value) {
    const ctx = source.ctx;
    const p = object(value);
    const turnId = identifier(p.turn_id);
    if (turnId && turnId !== ctx.turnId) {
      ctx.model = ctx.effort = null;
      ctx.mode = 'unknown';
      ctx.turnStartedAt = null;
    }
    if (turnId) ctx.turnId = turnId;
    if (metadata(p.model)) ctx.model = metadata(p.model);
    ctx.effort = first(metadata(p.effort), metadata(p.reasoning_effort), metadata(p.collaboration_mode?.settings?.reasoning_effort), ctx.effort);
    const mode = modeOf(p);
    if (['mode', 'service_tier', 'serviceTier', 'speed'].some(key => Object.hasOwn(p, key))) ctx.mode = mode;
    if (['effort', 'reasoning_effort'].some(key => Object.hasOwn(p, key))) ctx.effort = first(metadata(p.effort), metadata(p.reasoning_effort));
    const project = explicitProject(p);
    if (project !== null) {
      ctx.project = hash(project);
      ctx.projectName = projectBasename(project);
    }
    ctx.contextWindowTokens = first(numeric(p.model_context_window), numeric(p.context_window), ctx.contextWindowTokens);
    ctx.contextTokens = first(numeric(p.context_tokens), ctx.contextTokens);
  }

  _sourceAccount(source, payload) {
    const explicitHash = accountHash(first(payload.account_hash, payload.accountHash));
    const explicitId = identifier(payload.account_id);
    if (explicitHash || explicitId) {
      source.account = explicitHash || hash(explicitId).slice(0, 20);
      source.accountSource = 'source-metadata';
    }
  }

  _codex(source, event, time) {
    const p = object(event.payload);
    const ctx = source.ctx;
    if (event.type === 'session_meta') {
      ctx.sessionId = first(identifier(p.id), ctx.sessionId);
      ctx.parentSessionId = first(identifier(p.parent_thread_id), identifier(p.source?.subagent?.thread_spawn?.parent_thread_id), ctx.parentSessionId);
      this._sourceAccount(source, p);
      this._context(source, p);
      return;
    }
    if (event.type === 'turn_context') { this._context(source, p); return; }
    if (event.type === 'compacted' || event.type === 'event_msg' && p.type === 'context_compacted') {
      ctx.compactionEpoch++;
      ctx.pendingCompaction = true;
      ctx.contextTokens = null;
      return;
    }
    if (event.type === 'event_msg') {
      if (['task_started', 'task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) {
        if (p.type === 'task_started') {
          this._context(source, {turn_id: p.turn_id});
          ctx.turnStartedAt = time;
          ctx.running = true;
        } else ctx.running = false;
        return;
      }
      if (p.type === 'thread_settings_applied') {
        this._context(source, object(p.thread_settings));
        return;
      }
      if (p.type !== 'token_count' || ctx.modern || this._modernSessions.has(this._sessionKey(source))) return;
      const info = object(p.info);
      ctx.contextWindowTokens = first(numeric(info.model_context_window), ctx.contextWindowTokens);
      const totals = tokenValues(info.total_token_usage, 'codex');
      const signature = hash(JSON.stringify(TOKENS.map(key => totals[key])));
      const hasTotals = TOKENS.some(key => totals[key] !== null);
      if (hasTotals && ctx.cumulativeSignature === signature) return;
      const values = hasTotals ? {...totals} : tokenValues(info.last_token_usage, 'codex');
      if (hasTotals) {
        const previous = ctx.cumulative;
        const reset = previous && TOKENS.some(key => totals[key] !== null && previous[key] !== null && totals[key] < previous[key]);
        if (reset) { ctx.resetEpoch++; ctx.pendingReset = true; }
        for (const key of TOKENS) values[key] = totals[key] === null ? null
          : !previous || reset ? totals[key] : previous[key] === null ? null : totals[key] - previous[key];
        ctx.cumulative = Object.fromEntries(TOKENS.map(key => [key, totals[key]]));
        ctx.cumulativeSignature = signature;
      }
      if (!TOKENS.some(key => values[key] !== null)) return;
      this._put(source, {
          time
        , values
        , identity: `legacy:${ctx.sessionId || source.key}:${ctx.resetEpoch}:${hasTotals ? signature : hash(JSON.stringify([time, values]))}`
        , source: 'codex-token-count'
        , cumulativeDelta: hasTotals
      });
      return;
    }
    if (event.type === 'token_usage_record') {
      if (identifier(p.thread_id) && ctx.sessionId && p.thread_id !== ctx.sessionId) return;
      this._markModern(source);
      this._put(source, {
          time
        , payload: p
        , values: tokenValues(p.usage, 'codex')
        , identity: identifier(p.response_id) || `orphan:${source.key}:${source.line}`
        , orphan: !identifier(p.response_id)
        , source: 'codex-token-usage-record'
      });
      return;
    }
    const responseEvent = typeof event.type === 'string' && event.type.startsWith('response.') ? event : p;
    const response = object(responseEvent.response);
    if (typeof responseEvent.type === 'string' && responseEvent.type.startsWith('response.')) {
      const id = identifier(first(response.id, responseEvent.response_id));
      if (!id) return;
      this._markModern(source);
      this._put(source, {
          time
        , payload: {...response, response_id: id, turn_id: responseEvent.turn_id}
        , values: tokenValues(response.usage, 'codex')
        , identity: id
        , source: 'codex-response'
        , startedAt: responseEvent.type === 'response.created' ? time : null
        , completion: responseEvent.type.replace('response.', '')
      });
    }
  }

  _claude(source, event, time) {
    const ctx = source.ctx;
    ctx.sessionId = ctx.parentSessionId
      ? first(identifier(event.agentId), ctx.sessionId, identifier(event.sessionId))
      : first(identifier(event.sessionId), ctx.sessionId);
    // parentUuid links messages, not sessions. Only the subagents path supplies lineage here.
    this._context(source, {
        cwd: event.cwd
      , project_path: event.project_path
      , projectPath: event.projectPath
      , project: event.project
    });
    this._sourceAccount(source, event);
    const stream = object(event.event);
    const streaming = event.type === 'stream_event';
    const message = object(streaming ? stream.message : event.message);
    if (event.type !== 'assistant' && !streaming) return;
    const requestId = identifier(first(event.requestId, event.request_id));
    const messageId = identifier(first(message.id, event.messageId));
    // Continuation deltas do not always repeat message.id; keep only the hashed call key.
    let identity = messageId ? `message:${messageId}:${requestId || ''}` : null;
    let callId = !messageId && streaming ? accountHash(source.streamId) : null;
    if (messageId) {
      const requests = this._messageKeys.get(`${source.homeKey}:${messageId}`);
      callId = requests instanceof Map
        ? requests.get(requestId || '') || (requestId ? requests.get('') : requests.size === 1 ? [...requests.values()][0] : null)
        : requests && (!requestId || !requests.requestId || requests.requestId === requestId) ? requests.id : null;
    }
    if (callId) identity = callId;
    if (!identity) identity = `orphan:${source.key}:${source.line}`;
    const usage = {...object(message.usage), ...object(stream.usage)};
    const stop = first(message.stop_reason, stream.delta?.stop_reason);
    if (stream.type === 'message_start') ctx.running = true;
    if (stop !== null || stream.type === 'message_stop') ctx.running = false;
    const resultId = this._put(source, {
        time
      , id: callId
      , messageId
      , payload: {
          model: message.model
        , effort: first(event.effort, message.effort, message.output_config?.effort)
        , mode: first(event.mode, message.mode)
        , service_tier: first(event.service_tier, message.service_tier)
        , turn_id: event.turnId
        , request_id: requestId
      }
      , values: tokenValues(usage, 'claude')
      , identity
      , orphan: !messageId && !(streaming && source.streamId)
      , source: streaming ? 'claude-stream' : 'claude-assistant'
      , startedAt: streaming && stream.type === 'message_start' ? time : null
      , completion: stop !== null || stream.type === 'message_stop' ? 'completed' : stream.type === 'message_start' ? 'in_progress' : 'unknown'
    });
    if (streaming && messageId) source.streamId = resultId;
    if (stream.type === 'message_stop') source.streamId = null;
  }

  _put(source, record) {
    const ctx = source.ctx;
    const p = object(record.payload);
    const turnId = first(identifier(p.turn_id), ctx.turnId);
    const sameTurn = !identifier(p.turn_id) || p.turn_id === ctx.turnId;
    const projectPath = explicitProject(p);
    const id = accountHash(record.id) || hash(`${source.provider}:${source.homeKey}:${record.identity}`);
    const existing = this._records.get(id);
    const prior = existing?.call;
    const values = record.values;
    const completion = ['completed', 'failed', 'cancelled', 'incomplete', 'in_progress'].includes(record.completion)
      ? record.completion : ['completed', 'failed', 'cancelled', 'incomplete', 'in_progress'].includes(p.status) ? p.status : 'unknown';
    const terminal = ['completed', 'failed', 'cancelled', 'incomplete'].includes(completion);
    const priorTerminal = ['completed', 'failed', 'cancelled', 'incomplete'].includes(prior?.completionState);
    const stale = prior && (prior.provenance.observedAt !== null && record.time !== null && record.time < prior.provenance.observedAt
      || priorTerminal && !terminal);
    const mergedTokens = Object.fromEntries(TOKENS.map(key => [key, stale ? first(prior?.[key], values[key]) : first(values[key], prior?.[key])]));
    const nativeInput = stale ? first(prior?.provenance.nativeInput, values.nativeInput) : first(values.nativeInput, prior?.provenance.nativeInput);
    const cacheWriteTotal = stale ? first(prior?.provenance.cacheWriteTotal, values.writeTotal) : first(values.writeTotal, prior?.provenance.cacheWriteTotal);
    if (source.provider === 'claude' && nativeInput !== null && mergedTokens.cached !== null && cacheWriteTotal !== null) {
      mergedTokens.input = nativeInput + mergedTokens.cached + cacheWriteTotal;
    }
    const call = cleanCall({
        id
      , provider: source.provider
      , account: prior ? prior.account : source.account
      , accountSource: prior ? prior.accountSource : source.accountSource
      , homeKey: source.homeKey
      , time: first(prior?.time, record.time)
      , startedAt: first(prior?.startedAt, stamp(p.started_at), record.startedAt)
      , completedAt: first(stamp(p.completed_at), prior?.completedAt, terminal ? record.time : null)
      , sessionId: first(ctx.sessionId, identifier(p.thread_id))
      , parentSessionId: ctx.parentSessionId
      , project: projectPath !== null ? hash(projectPath) : first(ctx.project, prior?.project)
      , projectName: projectPath !== null ? projectBasename(projectPath) : ctx.project ? ctx.projectName : prior?.projectName
      , model: first(metadata(p.model), sameTurn ? ctx.model : null, prior?.model)
      , effort: first(metadata(p.effort), metadata(p.reasoning_effort), metadata(p.reasoning?.effort), sameTurn ? ctx.effort : null, prior?.effort)
      , mode: modeOf(p) !== 'unknown' ? modeOf(p) : sameTurn && ctx.mode !== 'unknown' ? ctx.mode : prior?.mode
      , completionState: stale || completion === 'unknown' ? prior?.completionState : completion
      , turnId
      , requestId: first(identifier(p.request_id), identifier(p.requestId), prior?.requestId)
      , messageId: first(identifier(record.messageId), prior?.messageId)
      , compactionEpoch: ctx.compactionEpoch
      , resetEpoch: ctx.resetEpoch
      , contextWindowTokens: first(numeric(p.model_context_window), ctx.contextWindowTokens, prior?.contextWindowTokens)
      , contextTokens: first(numeric(p.context_tokens), ctx.contextTokens, prior?.contextTokens)
      , ...mergedTokens
      , provenance: {
          source: record.source
        , fileKey: source.key
        , line: source.line
        , nativeInput
        , cacheWriteTotal
        , orphan: record.orphan === true
        , cumulativeDelta: record.cumulativeDelta === true
        , observedAt: Math.max(record.time ?? 0, prior?.provenance.observedAt ?? 0) || null
        , compaction: ctx.pendingCompaction || prior?.provenance.compaction
        , contextReset: ctx.pendingReset || prior?.provenance.contextReset
      }
    });
    ctx.pendingCompaction = false;
    ctx.pendingReset = false;
    if (call.time !== null && call.time < this._now - this.retentionDays * DAY) return;
    if (existing && !existing.sources.includes(source.key)) existing.sources.push(source.key);
    const sources = existing?.sources.slice(-32) || [source.key];
    if (!prior || JSON.stringify(prior) !== JSON.stringify(call)) {
      this._records.delete(id);
      this._records.set(id, {call, sources});
      this._callCache = null;
      this._dirty = true;
    }
    this._rememberMessage(call);
    this._rememberLegacy(call);
    if (this._records.size > this.maxCalls + 256) this._trim();
    return id;
  }

  _trim() {
    const cutoff = this._now - this.retentionDays * DAY;
    let removed = false;
    for (const [id, record] of this._records) {
      if (record.call.time !== null && record.call.time < cutoff) { this._records.delete(id); this._dirty = true; removed = true; }
    }
    if (this._records.size > this.maxCalls) {
      const sorted = [...this._records.values()].sort((a, b) => (b.call.time ?? 0) - (a.call.time ?? 0));
      this._records = new Map(sorted.slice(0, this.maxCalls).map(record => [record.call.id, record]));
      this._callCache = null;
      this._dirty = true;
      this._limited = true;
      this._rebuildLookups();
    } else if (removed) {
      this._callCache = null;
      this._rebuildLookups();
    }
  }

  _boundPending() {
    let bytes = 0;
    for (const source of this._files.values()) {
      bytes += source.pending.length;
      if (bytes > LIMITS.pending) {
        bytes -= source.pending.length;
        source.pending = Buffer.alloc(0);
        source.readOffset = source.offset;
      }
    }
  }

  async _persist() {
    const revision = this._revision;
    const temp = path.join(this.dir, `.session-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.mkdir(this.dir, {recursive: true});
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        // Keep one small encoded batch in memory; each write yields to the event loop.
        // Checkpoint every changed scan so account bindings and cursors stay crash consistent.
        const checksum = crypto.createHash('sha256');
        let parts = [];
        let batchBytes = 0;
        let totalBytes = 0;
        const flush = async () => {
          if (!parts.length) return;
          const chunk = parts.join('');
          totalBytes += batchBytes;
          if (totalBytes + 128 > LIMITS.cache) throw new Error('cache limit');
          checksum.update(chunk);
          await handle.writeFile(chunk);
          parts = [];
          batchBytes = 0;
        };
        const append = async text => {
          parts.push(text);
          batchBytes += Buffer.byteLength(text);
          if (batchBytes >= LIMITS.chunk) await flush();
        };
        await append(JSON.stringify({version: 3, revision, calls: this._records.size, files: this._files.size}) + '\n');
        for (const source of this._files.values()) {
          await append(JSON.stringify({kind: 'file', value: {
              key: source.key
            , homeKey: source.homeKey
            , provider: source.provider
            , account: source.account
            , accountSource: source.accountSource
            , offset: source.offset
            , line: source.line
            , headHash: source.headHash
            , headLength: source.headLength
            , tailHash: source.tailHash
            , tailLength: source.tailLength
            , size: source.size
            , mtime: source.mtime
            , ctime: source.ctime
            , ino: source.ino
            , dev: source.dev
            , skip: source.skip
            , malformed: source.malformed
            , oversized: source.oversized
            , rewrites: source.rewrites
            , streamId: identifier(source.streamId)
            , ctx: cleanContext(source.ctx)
          }}) + '\n');
        }
        for (const record of this._records.values()) await append(JSON.stringify({kind: 'call', value: record}) + '\n');
        await flush();
        await handle.writeFile(JSON.stringify({kind: 'checksum', checksum: checksum.digest('hex')}) + '\n');
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temp, this.file);
      const stat = await fs.stat(this.file);
      this._diskStamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
      this._revision = revision;
      this._dirty = false;
      this._cacheWriteFailed = false;
      this._needsMigration = false;
    } catch {
      this._cacheWriteFailed = true;
    } finally { await fs.unlink(temp).catch(() => {}); }
  }

  _callView() {
    if (this._callCache) return this._callCache;
    const calls = Object.freeze(Array.from(this._records.values(), record => record.call));
    const summary = Object.fromEntries(PROVIDERS.map(provider => [provider, {count: 0, unknownTime: 0, legacy: false, modern: false}]));
    for (const call of calls) {
      const item = summary[call.provider];
      item.count++;
      if (call.time === null) item.unknownTime++;
      if (call.provenance.source === 'codex-token-count') item.legacy = true;
      if (call.provenance.source === 'codex-token-usage-record') item.modern = true;
    }
    this._callCache = {calls, summary};
    return this._callCache;
  }

  snapshot() {
    const {calls, summary} = this._callView();
    const activity = {};
    const coverage = {};
    for (const provider of PROVIDERS) {
      const files = [...this._files.values()].filter(source => source.provider === provider);
      const providerCalls = summary[provider];
      const lastActivity = files.reduce((last, source) => first(source.ctx.lastActivity, 0) > (last ?? -1) ? source.ctx.lastActivity : last, null);
      const active = files.some(source => source.ctx.running === true && source.ctx.lastActivity !== null
        && this._now - source.ctx.lastActivity >= 0 && this._now - source.ctx.lastActivity < 120000);
      activity[provider] = {
          active
        , lastActivity
        , signature: hash(JSON.stringify(files.map(source => [source.key, source.offset, source.ctx.lastActivity, source.ctx.running])))
      };
      const switchedFiles = files.filter(source => source.accountSource === 'local-root-assumption' && source.account && this._roots.get(source.homeKey)?.account
        && source.account !== this._roots.get(source.homeKey).account).length;
      coverage[provider] = {
          roots: [...this._roots.values()].filter(root => root.enabled && root.provider === provider).length
        , files: files.length
        , calls: providerCalls.count
        , bytesRead: this._lastWork.bytes
        , entriesVisited: this._lastWork.entries
        , filesVisited: this._lastWork.files
        , scanMs: this._lastWork.scanMs
        , partial: this._lastWork.partial || files.some(source => source.path && (source.readOffset < source.size || source.pending.length || source.skip))
        , pendingFiles: files.filter(source => source.path && (source.readOffset < source.size || source.pending.length || source.skip)).length
        , malformedLines: files.reduce((sum, source) => sum + source.malformed, 0)
        , oversizedLines: files.reduce((sum, source) => sum + source.oversized, 0)
        , rewrites: files.reduce((sum, source) => sum + source.rewrites, 0)
        , unavailableFiles: files.filter(source => source.unavailable).length
        , unknownAccountFiles: files.filter(source => !source.account).length
        , accountSwitchFiles: switchedFiles
        , unknownTimeCalls: providerCalls.unknownTime
        , limited: this._limited
        , cacheRecovered: this._cacheRecovered
        , cacheWriteFailed: this._cacheWriteFailed
        , notes: [
            ...(switchedFiles ? ['account-switch-existing-file-bindings-preserved'] : [])
          , ...(files.some(source => source.accountSource === 'local-root-assumption') ? ['account-assumed-at-first-file-observation'] : [])
          , ...(files.some(source => !source.account) ? ['unknown-account-binding-preserved'] : [])
          , ...(providerCalls.legacy ? ['legacy-cumulative-deltas-completion-unknown'] : [])
          , ...(providerCalls.modern ? ['modern-records-supersede-session-token-count'] : [])
        ]
      };
    }
    return {calls, activity, coverage, revision: this._revision};
  }

  async dispose() {
    await this._queue;
    this._disposed = true;
    for (const directory of this._directories.values()) {
      if (directory.handle) await directory.handle.close().catch(() => {});
      directory.handle = null;
    }
    for (const source of this._files.values()) source.pending = Buffer.alloc(0);
  }
}

module.exports = {SessionIndex};
