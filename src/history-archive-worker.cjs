'use strict';
const {parentPort, workerData} = require('node:worker_threads');
const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs/promises');
const {createReadStream} = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const crypto = require('node:crypto');
const {sanitize, ProjectionStream, series} = require('./core.cjs');
const {converter} = require('./credit-conversion.cjs');
const billing = require('./billing.cjs');
const catalog = require('../media/provider-visibility.js');
const day = 86400000, file = path.join(workerData.dir, 'history-archive.sqlite');
let db, cache, prunedDay, prunedDays, seeded = false, queue = Promise.resolve();
const interrupted = cancel => {if (Atomics.load(cancel, 0)) throw Error('과거 기록 조회가 취소되었습니다.');};
async function open() {
  if (db) return;
  await fs.mkdir(workerData.dir, {recursive: true});
  try {if ((await fs.lstat(file)).isSymbolicLink()) throw Error('아카이브 파일 경로가 올바르지 않습니다.');} catch (error) {if (error.code !== 'ENOENT') throw error;}
  db = new DatabaseSync(file); await fs.chmod(file, 0o600);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA wal_autocheckpoint=256; CREATE TABLE IF NOT EXISTS observations(provider TEXT NOT NULL, account TEXT NOT NULL, time INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(provider,account,time)) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS observations_time ON observations(time); CREATE TABLE IF NOT EXISTS heads(provider TEXT PRIMARY KEY, time INTEGER NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS archive_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS archive_changes(revision INTEGER PRIMARY KEY,first_time INTEGER NOT NULL,reset INTEGER NOT NULL); INSERT OR IGNORE INTO archive_meta VALUES (\'revision\',\'0\');');
}
function revise(first, reset = false) {db.exec("UPDATE archive_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"); const revision = Number(db.prepare('SELECT value FROM archive_meta WHERE key=?').get('revision').value); db.prepare('INSERT INTO archive_changes VALUES (?,?,?)').run(revision, Number.isFinite(first) ? first : 0, reset ? 1 : 0); db.prepare('DELETE FROM archive_changes WHERE revision<?').run(revision - 2048);}
function insertRows(records, cutoff) {
  const insert = db.prepare('INSERT OR IGNORE INTO observations(provider,account,time,record) VALUES (?,?,?,?)');
  const head = db.prepare('INSERT INTO heads(provider,time,record) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET time=excluded.time,record=excluded.record WHERE excluded.time>=heads.time');
  let changed = 0, first = Infinity;
  for (const value of records) {const row = sanitize(value); if (row.time < cutoff) continue; const json = JSON.stringify(row), result = insert.run(row.provider, row.account, row.time, json); if (result.changes) {head.run(row.provider, row.time, json); changed++; first = Math.min(first, row.time);}}
  return {changed, first};
}
async function seed(cutoff, cancel) {
  if (seeded) return;
  let input;
  try {await fs.access(path.join(workerData.dir, 'history.jsonl')); input = createReadStream(path.join(workerData.dir, 'history.jsonl'), {encoding: 'utf8', highWaterMark: 65536});} catch (e) {if (e.code !== 'ENOENT') throw e;}
  db.exec('BEGIN IMMEDIATE');
  try {
    let added = 0;
    if (input) {
      const lines = readline.createInterface({input, crlfDelay: Infinity}); let rows = [];
      try {for await (const line of lines) {interrupted(cancel); if (!line || line.length > 16384) continue; try {rows.push(sanitize(JSON.parse(line)));} catch {continue;} if (rows.length === 1024) {added += insertRows(rows, cutoff).changed; rows = [];}} if (rows.length) added += insertRows(rows, cutoff).changed;}
      finally {lines.close(); input.destroy();}
    }
    db.prepare('INSERT OR REPLACE INTO archive_meta VALUES (?,?)').run('seeded', '1');
    if (added) revise(0, true);
    db.exec('COMMIT'); seeded = true;
  } catch (error) {db.exec('ROLLBACK'); throw error;}
}
async function handle(message) {
  if (message.type === 'release') {cache = null; return true;}
  await open(); const cancel = new Int32Array(message.cancel), days = Number.isInteger(message.retentionDays) && message.retentionDays >= 7 && message.retentionDays <= 365 ? message.retentionDays : 365;
  const now = Date.now(), cutoff = Math.floor(now / day) * day - days * day; interrupted(cancel); if (!workerData.reader) await seed(cutoff, cancel);
  if (message.type === 'details') {
    if (!catalog.valid(message.provider) || !/^[a-f\d]{20}$/.test(message.account || '') || ![message.from, message.to, message.time].every(Number.isFinite) || message.from >= message.to) throw Error('과거 상세 조회 범위를 확인해주세요.');
    const from = Math.max(cutoff, message.from), to = Math.min(now + 1, message.to), time = Math.max(from, Math.min(to, message.time));
    const values = [message.provider, message.account, from, to];
    const totalCount = db.prepare('SELECT COUNT(*) AS count FROM observations WHERE provider=? AND account=? AND time>=? AND time<?').get(...values).count;
    const before = db.prepare('SELECT record FROM observations WHERE provider=? AND account=? AND time>=? AND time<? AND time<=? ORDER BY time DESC LIMIT 25000').all(...values, time);
    const after = db.prepare('SELECT record FROM observations WHERE provider=? AND account=? AND time>=? AND time<? AND time>? ORDER BY time ASC LIMIT 25000').all(...values, time);
    interrupted(cancel);
    const records = before.concat(after).map(r => sanitize(JSON.parse(r.record))).sort((a, b) => a.time - b.time);
    return {records, totalCount, truncated: totalCount > records.length};
  }
  if (message.type === 'append') {
    if (!Array.isArray(message.records) || message.records.length > 50000) throw Error('아카이브 저장 범위를 확인해주세요.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const {changed, first} = insertRows(message.records, cutoff);
      let removed = 0;
      if (prunedDay !== Math.floor(now / day) || prunedDays !== days) {removed = db.prepare('DELETE FROM observations WHERE time<?').run(cutoff).changes; db.prepare('DELETE FROM heads WHERE time<?').run(cutoff); prunedDay = Math.floor(now / day); prunedDays = days;}
      if (changed || removed) revise(first, removed > 0);
      db.exec('COMMIT');
      return {inserted: changed};
    } catch (error) {db.exec('ROLLBACK'); throw error;}
  }
  if (message.type !== 'query' || !Number.isFinite(message.from) || message.from > now || !Array.isArray(message.capacities)) throw Error('과거 기록 조회 범위를 확인해주세요.');
  const from = Math.max(cutoff, message.from), key = crypto.createHash('sha256').update(JSON.stringify([from, message.capacities, message.conversion, message.maxGap, days, billing.catalog.version])).digest('hex');
  db.exec('BEGIN');
  try {
    const revision = db.prepare('SELECT value FROM archive_meta WHERE key=?').get('revision').value;
    const heads = db.prepare('SELECT record FROM heads WHERE time>=?').all(cutoff).map(r => sanitize(JSON.parse(r.record)));
    const oldestQuery = db.prepare('SELECT MIN(time) AS time FROM observations WHERE provider=? AND account=? AND time>=?');
    const firstTimes = heads.map(row => oldestQuery.get(row.provider, row.account, cutoff).time).filter(Number.isFinite), oldest = firstTimes.length ? Math.min(...firstTimes) : null;
    const scope = JSON.stringify(heads.map(r => [r.provider, r.account, r.plan]));
    if (!cache || cache.key !== key || cache.scope !== scope) {
      const multipliers = Object.fromEntries(heads.map(row => [row.provider, Object.fromEntries(['five', 'week'].map(w => [w, series([row], row.provider, w, message.capacities).at(-1)?.mult ?? null]))]));
      const convert = converter(message.conversion, {states: new Map(), multipliers, assumeStandard: true}), bill = billing.enricher(billing.catalog, new Map());
      cache = {key, scope, projector: new ProjectionStream(heads, message.capacities, message.maxGap, (...args) => {convert(...args); bill(...args);}), through: from - 1, revision: null, count: 0, peakHeapBytes: 0};
    }
    if (cache.revision !== revision) {
      // 다른 창의 쓰기·과거 가져오기는 다시 읽고, 이 작업자의 순차 수집만 이어 계산한다.
      if (cache.revision !== null) {
        const changes = db.prepare('SELECT revision,first_time,reset FROM archive_changes WHERE revision>? ORDER BY revision').all(Number(cache.revision));
        const appendOnly = changes.length && changes[0].revision === Number(cache.revision) + 1 && changes.at(-1).revision === Number(revision) && changes.every(change => !change.reset && change.first_time > cache.through);
        if (!appendOnly) {cache = null; db.exec('ROLLBACK'); return handle({...message, cancel: cancel.buffer});}
      }
      let batch = [];
      const query = cache.revision === null ? 'SELECT record FROM observations WHERE time>=? AND time<=? ORDER BY time,provider,account' : 'SELECT record FROM observations WHERE time>? AND time<=? ORDER BY time,provider,account';
      for (const item of db.prepare(query).iterate(cache.revision === null ? from : cache.through, now)) {
        if ((cache.count + batch.length) % 256 === 0) interrupted(cancel);
        batch.push(sanitize(JSON.parse(item.record)));
        if (batch.length === 1024) {cache.projector.accept(batch); cache.count += batch.length; cache.through = batch.at(-1).time; cache.peakHeapBytes = Math.max(cache.peakHeapBytes, process.memoryUsage().heapUsed); batch = [];}
      }
      if (batch.length) {cache.projector.accept(batch); cache.count += batch.length; cache.through = batch.at(-1).time;}
      cache.revision = revision;
    }
    const data = cache.projector.data(); db.exec('COMMIT');
    return {data, first: oldest, from, count: cache.count, metrics: {peakHeapBytes: cache.peakHeapBytes, workerHeapLimitMb: 128, batchRecords: 1024}};
  } catch (error) {try {db.exec('ROLLBACK');} catch {} cache = null; throw error;}
}
parentPort.on('message', message => {queue = queue.catch(() => {}).then(async () => {try {parentPort.postMessage({id: message.id, value: await handle(message)});} catch (error) {parentPort.postMessage({id: message.id, error: error.message || '과거 기록 작업 실패'});}});});
