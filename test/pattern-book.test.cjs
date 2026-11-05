'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {PatternBook, summarize} = require('../src/pattern-book.cjs');
const {project, hash} = require('../src/core.cjs');
const forecast = require('../media/forecast.js');
const quarter = 900000, start = Math.floor((Date.now() - 86400000) / quarter) * quarter;
const records = Array.from({length: 97}, (_, i) => ({v: 1, provider: 'claude', account: hash('pattern-book'), plan: 'one', time: start + i * 60000, windows: {five: {used: i / 5, reset: start + 18000000}, week: {used: i / 10, reset: start + 604800000}}}));
const data = (rows, capacities = []) => project(rows, capacities).claude;
async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-pattern-book-'));
  try {await fn(dir);} finally {assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('usage-atlas-pattern-book-')); await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});}
}
test('quarter-hour archive retains observed growth as raw records rotate, without double-counting a partial first cell', () => temporary(async dir => {
  const book = new PatternBook(dir); book.configure([], 90); const before = JSON.stringify(records);
  book.update('claude', records, data(records).windows);
  const full = book.older('claude', records[0].account, 'week', data(records).windows.week.at(-1), Infinity);
  for (let index = 1; index < 30; index++) {const rows = records.slice(index); book.update('claude', rows, data(rows).windows);}
  const rows = records.slice(29), provider = data(rows), older = book.older('claude', rows[0].account, 'week', provider.windows.week.at(-1), rows[0].time);
  assert.equal(older.length, 1); assert.equal(older[0].ms, quarter);
  assert.ok(Math.abs(older[0].consumed - 1.5) < 1e-9);
  const current = book.older('claude', records[0].account, 'week', provider.windows.week.at(-1), Infinity);
  assert.deepEqual(current.map(c => [c.key, c.ms, c.consumed]), full.map(c => [c.key, c.ms, c.consumed]));
  assert.equal(JSON.stringify(records), before);
  await book.save(); const disk = await fs.readFile(book.file, 'utf8'); assert.equal(disk.includes('message'), false);
  const restored = new PatternBook(dir); await restored.load(); restored.configure([], 90);
  assert.deepEqual(restored.older('claude', records[0].account, 'week', provider.windows.week.at(-1), Infinity), current);
}));
test('capacity changes, imported-history epochs and corrupt snapshots cannot reuse unrelated archived samples', () => temporary(async dir => {
  const book = new PatternBook(dir); book.configure([], 90); book.update('claude', records, data(records).windows); await book.save();
  const caps = [{provider: 'claude', account: records[0].account, plan: 'one', window: 'week', time: records[0].time, mult: 5}];
  assert.ok(book.scopes.size); book.configure(caps, 90); assert.ok([...book.scopes.values()].every(group => group.scope.window === 'five'), 'unrelated five-hour archive survives a weekly calibration change');
  book.update('claude', records, data(records, caps).windows); book.configure(caps, 90, 'new-import'); assert.equal(book.scopes.size, 0);
  await fs.writeFile(book.file, '{broken'); const recovered = new PatternBook(dir); await recovered.load(); assert.equal(recovered.scopes.size, 0); assert.equal(recovered.recovered, true);
}));
test('a configuration change during async save stays dirty and never silently marks newer derived state as persisted', () => temporary(async dir => {
  const book = new PatternBook(dir); book.configure([], 90); book.update('claude', records, data(records).windows);
  const saving = book.save(); book.configure([], 30, 'changed-during-write'); await saving;
  assert.equal(book.dirty, true); book.update('claude', records, data(records).windows); await book.save(); assert.equal(book.dirty, false);
  assert.equal(JSON.parse(await fs.readFile(book.file, 'utf8')).capacityKey, book.capacityKey);
}));
test('archive ignores gaps, assumed resets, recovery and exhausted plateaus and isolates all quota scopes', () => {
  const points = data(records).windows.week;
  for (const change of [{continuous: false}, {estimatedDelta: true}, {recoveryExcluded: 1}, {value: 100}, {event: {kind: 'early-reset'}}]) {
    const invalid = points.map(p => ({...p, ...change})); assert.equal(summarize(invalid).length, 0);
  }
  const book = new PatternBook('unused'); book.configure([], 90); book.update('claude', records, data(records).windows);
  assert.equal(book.older('codex', records[0].account, 'week', points.at(-1), Infinity).length, 0);
  assert.equal(book.older('claude', hash('other'), 'week', points.at(-1), Infinity).length, 0);
  assert.equal(book.older('claude', records[0].account, 'week', {...points.at(-1), plan: 'other'}, Infinity).length, 0);
  assert.equal(book.older('claude', records[0].account, 'week', {...points.at(-1), mult: 5}, Infinity).length, 0);
});
test('account switches remove old archive scopes and returning to an account cannot revive pre-switch observations', () => {
  const book = new PatternBook('unused'); book.configure([], 90); book.update('claude', records, data(records).windows);
  const other = records.map(row => ({...row, account: hash('second')})); book.update('claude', other, data(other).windows);
  assert.equal(book.older('claude', records[0].account, 'week', data(records).windows.week.at(-1), Infinity).length, 0);
  const boundary = records.at(-1).time + 3600000, next = Array.from({length: 7}, (_, i) => ({...records.at(-1), time: boundary + 3600000 + i * 300000}));
  const returned = [...records, ...next]; book.update('claude', returned, data(returned).windows, boundary);
  for (const group of book.scopes.values()) for (const cell of group.cells.values()) assert.ok(cell.key * quarter > boundary);
});
test('archived samples supplement only the period before raw records and respect pattern lookback/account boundaries', () => {
  const p = data(records).windows.week, original = JSON.stringify(p);
  const archive = [{key: Math.floor((start - 7 * 86400000) / quarter), ms: quarter, consumed: 1, cycle: 1}];
  const a = forecast.estimate(p, 'week', {archiveCells: archive}), b = forecast.estimate(p, 'week', {archiveCells: archive, patternDays: 0});
  assert.equal(b.pattern, undefined); assert.equal(JSON.stringify(p), original); assert.ok(a.state);
});
