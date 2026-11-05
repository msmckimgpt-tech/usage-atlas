'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {SessionIndex} = require('../src/session-index.cjs');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const TIME = new Date(NOW - 60000).toISOString();
const A = 'a'.repeat(20);
const B = 'b'.repeat(20);
const SECRET = 'PRIVATE-MESSAGE-AUTH-TOOL-CONTENT';
const jsonl = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';
async function checkpoint(file) {
  const text = await fs.readFile(file, 'utf8');
  if (!text.startsWith('{"version":3,')) return JSON.parse(text);
  const lines = text.trimEnd().split('\n');
  const header = JSON.parse(lines[0]);
  const footer = JSON.parse(lines.at(-1));
  const checksum = crypto.createHash('sha256').update(lines.slice(0, -1).join('\n') + '\n').digest('hex');
  assert.equal(footer.checksum, checksum);
  const values = lines.slice(1, -1).map(line => JSON.parse(line));
  return {
      version: header.version
    , checksum
    , data: {
        revision: header.revision
      , records: values.filter(item => item.kind === 'call').map(item => item.value)
      , files: values.filter(item => item.kind === 'file').map(item => item.value)
    }
  };
}
const codex = (type, payload, timestamp = TIME) => ({type, timestamp, payload});
const usage = (input = 100, cached = 20, output = 10) => ({
    input_tokens: input
  , cached_input_tokens: cached
  , output_tokens: output
  , reasoning_output_tokens: 3
});
const claude = (id, overrides = {}) => ({
    type: 'assistant'
  , sessionId: 'session-a'
  , requestId: 'request-a'
  , timestamp: TIME
  , cwd: '/private/example/project'
  , parentUuid: 'message-parent-must-not-be-a-session'
  , message: {
      id
    , model: 'claude-sonnet-fixture'
    , role: 'assistant'
    , content: [{type: 'text', text: SECRET}]
    , usage: {
        input_tokens: 100
      , cache_read_input_tokens: 20
      , cache_creation_input_tokens: 12
      , cache_creation: {ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 7}
      , output_tokens: 30
    }
  }
  , ...overrides
});
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-session-index-'));
  const codexHome = path.join(root, 'codex');
  const claudeDir = path.join(root, 'claude');
  const dir = path.join(root, 'cache');
  const instances = [];
  await fs.mkdir(path.join(codexHome, 'sessions'), {recursive: true});
  await fs.mkdir(path.join(claudeDir, 'projects'), {recursive: true});
  const create = () => {
    const index = new SessionIndex({dir, ...options});
    instances.push(index);
    return index;
  };
  const write = async (relative, events, provider = 'codex') => {
    const file = path.join(provider === 'codex' ? codexHome : claudeDir, relative);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, typeof events === 'string' ? events : jsonl(events));
    return file;
  };
  const scan = async (index, extra = {}) => await index.scan({
      codexHome
    , claudeDir
    , accounts: {codex: A, claude: A}
    , now: NOW
    , ...extra
  });
  const until = async (index, predicate, extra = {}) => {
    let result;
    for (let i = 0; i < 150; i++) {
      result = await scan(index, extra);
      if (predicate(result)) return result;
    }
    assert.fail('incremental scan failed to converge');
  };
  t.after(async () => {
    for (const index of instances) await index.dispose();
    await fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
  });
  return {root, dir, codexHome, claudeDir, create, write, scan, until};
}

test('Codex modern metadata: inclusive input, explicit context, no invented completion or text', async t => {
  const f = await fixture(t);
  await f.write('sessions/2026/10/rollout.jsonl', [
      codex('session_meta', {id: 'session-a', cwd: '/private/example/project', account_hash: B, instructions: SECRET})
    , codex('event_msg', {type: 'task_started', turn_id: 'turn-a'})
    , codex('turn_context', {turn_id: 'turn-a', model: 'gpt-fixture', effort: 'high', service_tier: 'priority', model_context_window: 400000})
    , codex('token_usage_record', {thread_id: 'session-a', turn_id: 'turn-a', response_id: 'response-a', usage: usage(300000, 200000, 40), text: SECRET})
  ]);
  const result = await f.until(f.create(), result => result.calls.length === 1);
  const call = result.calls[0];
  assert.equal(call.input, 300000);
  assert.equal(call.cached, 200000);
  assert.equal(call.output, 40);
  assert.equal(call.reasoning, 3);
  assert.equal(call.account, B);
  assert.equal(call.accountSource, 'source-metadata');
  assert.equal(call.turnId, 'turn-a');
  assert.equal(call.contextWindowTokens, 400000);
  assert.equal(call.mode, 'Fast');
  assert.equal(call.effort, 'high');
  assert.equal(call.startedAt, null);
  assert.equal(call.completedAt, null);
  assert.equal(call.completionState, 'unknown');
  assert.equal(call.cacheWrite5m, null);
  assert.equal(call.cacheWrite1h, null);
  assert.equal(result.activity.codex.active, true);
  assert.ok(call.missingFields.includes('cacheWrite5m'));
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes('/private'), false);
  assert.match(call.project, /^[a-f0-9]{64}$/);
});

test('Claude inclusive input with separate TTL, explicit zeros, and reasoning remains unknown', async t => {
  const f = await fixture(t);
  const zero = claude('msg-zero');
  zero.message.usage.cache_creation = {ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0};
  zero.message.usage.cache_creation_input_tokens = 0;
  zero.message.usage.cache_read_input_tokens = 0;
  zero.message.stop_reason = 'end_turn';
  await f.write('projects/project/session-a.jsonl', [claude('msg-a'), zero], 'claude');
  const result = await f.until(f.create(), r => r.calls.length === 2);
  const call = result.calls.find(c => c.input === 132);
  assert.equal(call.cached, 20);
  assert.equal(call.cacheWrite5m, 5);
  assert.equal(call.cacheWrite1h, 7);
  assert.equal(call.reasoning, null);
  assert.equal(call.requestId, 'request-a');
  assert.equal(call.parentSessionId, null);
  assert.equal(call.completionState, 'unknown');
  const completed = result.calls.find(c => c.input === 100);
  assert.equal(completed.cacheWrite5m, 0);
  assert.equal(completed.cacheWrite1h, 0);
  assert.equal(completed.cached, 0);
  assert.equal(completed.completionState, 'completed');
  assert.equal(completed.completedAt, Date.parse(TIME));
  assert.equal(completed.mode, 'unknown');
});

test('Claude aggregate-only cache creation preserves input but marks unknown TTL; absent breakdown stays null', async t => {
  const f = await fixture(t);
  const aggregate = claude('aggregate');
  delete aggregate.message.usage.cache_creation;
  const missing = claude('missing');
  missing.message.usage = {input_tokens: 100, output_tokens: 10};
  await f.write('projects/project/session-a.jsonl', [aggregate, missing], 'claude');
  const result = await f.until(f.create(), r => r.calls.length === 2);
  const a = result.calls.find(c => c.provenance.cacheWriteTotal === 12);
  assert.equal(a.input, 132);
  assert.equal(a.cacheWrite5m, null);
  assert.equal(a.cacheWrite1h, null);
  assert.ok(a.missingFields.includes('cacheWriteTTL'));
  const b = result.calls.find(c => c.provenance.cacheWriteTotal === null);
  assert.equal(b.input, null);
  assert.equal(b.cached, null);
  assert.ok(b.missingFields.includes('inputCacheBreakdown'));
});

test('nested Claude subagents derive parent session from directory, never parentUuid', async t => {
  const f = await fixture(t);
  await f.write('projects/project/parent-session/subagents/child-one/subagents/child-two.jsonl', [
    claude('child-message', {sessionId: 'child-two', parentUuid: 'unrelated-message'})
  ], 'claude');
  const result = await f.until(f.create(), r => r.calls.length === 1);
  assert.equal(result.calls[0].sessionId, 'child-two');
  assert.equal(result.calls[0].parentSessionId, 'child-one');
});

test('Codex cumulative fallback uses deltas and drops repeated snapshots, including after restart', async t => {
  const f = await fixture(t);
  const token = (input, cached, output) => codex('event_msg', {
      type: 'token_count'
    , info: {total_token_usage: usage(input, cached, output), last_token_usage: usage(99999, 99999, 99999)}
  });
  const file = await f.write('sessions/legacy.jsonl', [
      codex('session_meta', {id: 'legacy'})
    , token(100, 20, 10)
    , token(100, 20, 10)
    , token(160, 40, 15)
  ]);
  const index = f.create();
  let result = await f.until(index, r => r.calls.length === 2);
  assert.deepEqual(result.calls.map(c => c.input), [100, 60]);
  assert.deepEqual(result.calls.map(c => c.cached), [20, 20]);
  assert.deepEqual(result.calls.map(c => c.output), [10, 5]);
  assert.ok(result.calls.every(c => c.completedAt === null && c.completionState === 'unknown'));
  await fs.appendFile(file, jsonl([token(160, 40, 15), token(200, 50, 22)]));
  const restarted = f.create();
  result = await f.until(restarted, r => r.calls.length === 3);
  assert.deepEqual(result.calls.map(c => c.input), [100, 60, 40]);
});

test('modern response IDs replace fallback and duplicate modern updates do not add calls', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/mixed.jsonl', [
      codex('session_meta', {id: 'mixed'})
    , codex('event_msg', {type: 'token_count', info: {total_token_usage: usage()}})
    , codex('token_usage_record', {response_id: 'response-a', thread_id: 'mixed', usage: usage()})
    , codex('event_msg', {type: 'token_count', info: {total_token_usage: usage(999)}})
    , codex('token_usage_record', {response_id: 'response-a', thread_id: 'mixed', usage: usage(120, 30, 15)})
    , codex('token_usage_record', {response_id: 'foreign', thread_id: 'different-session', usage: usage(900)})
  ]);
  const index = f.create();
  let result = await f.until(index, r => r.calls.length === 1);
  assert.equal(result.calls[0].input, 120);
  assert.equal(result.calls[0].output, 15);
  await fs.appendFile(file, jsonl([codex('token_usage_record', {response_id: 'response-a', thread_id: 'mixed', usage: usage(121, 30, 16)})]));
  result = await f.until(f.create(), r => r.calls.length === 1 && r.calls[0].input === 121);
  assert.equal(result.calls[0].output, 16);
});

test('Claude message.id plus requestId deduplicates updates, copies, and restart', async t => {
  const f = await fixture(t);
  const first = claude('message-a');
  const update = claude('message-a');
  update.message.usage.output_tokens = 44;
  update.message.stop_reason = 'end_turn';
  const differentRequest = claude('message-a', {requestId: 'different-request'});
  const file = await f.write('projects/project/session-a.jsonl', [first, update, differentRequest], 'claude');
  const index = f.create();
  let result = await f.until(index, r => r.calls.length === 2);
  assert.ok(result.calls.some(c => c.output === 44));
  await f.write('projects/other/copy.jsonl', [update], 'claude');
  result = await f.scan(index);
  assert.equal(result.calls.length, 2);
  await fs.appendFile(file, jsonl([update]));
  result = await f.until(f.create(), r => r.calls.length === 2);
  assert.equal(result.calls.reduce((sum, c) => sum + c.input, 0), 264);
});

test('partial lines persist no fragments and resume after restart with UTF-8 intact', async t => {
  const f = await fixture(t);
  const full = JSON.stringify(claude('partial-message', {cwd: '/한글/project', text: SECRET}));
  const split = Buffer.from(full).indexOf(Buffer.from('글')) + 1;
  const bytes = Buffer.from(full);
  const file = await f.write('projects/project/session-a.jsonl', '', 'claude');
  await fs.writeFile(file, bytes.subarray(0, split));
  const first = f.create();
  let result = await f.until(first, r => r.coverage.claude.files === 1);
  assert.equal(result.calls.length, 0);
  const cache = await fs.readFile(path.join(f.dir, 'session-index.json'), 'utf8');
  assert.equal(cache.includes(SECRET), false);
  assert.equal(cache.includes('partial-message'), false);
  await fs.appendFile(file, Buffer.concat([bytes.subarray(split), Buffer.from('\n')]));
  result = await f.until(f.create(), r => r.calls.length === 1);
  assert.equal(result.calls[0].input, 132);
  assert.equal(result.calls[0].sessionId, 'session-a');
});

test('truncation and same-length rewrite replace stale calls and reset cumulative baseline', async t => {
  const f = await fixture(t);
  const initial = claude('message-one');
  const replacement = claude('message-two');
  const file = await f.write('projects/project/session-a.jsonl', [initial], 'claude');
  const index = f.create();
  let result = await f.until(index, r => r.calls.length === 1);
  const originalId = result.calls[0].id;
  assert.equal(jsonl([initial]).length, jsonl([replacement]).length);
  await fs.writeFile(file, jsonl([replacement]));
  result = await f.until(index, r => r.calls.length === 1 && r.calls[0].id !== originalId);
  assert.equal(result.coverage.claude.rewrites, 1);
  await fs.writeFile(file, '\n');
  result = await f.until(index, r => r.calls.length === 0);
  assert.equal(result.coverage.claude.rewrites, 2);
});

test('file binding is fixed across account switches, unknown stays unknown; new files get new account', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/old.jsonl', [codex('token_usage_record', {response_id: 'old', usage: usage()})]);
  const index = f.create();
  await f.until(index, r => r.calls.length === 1);
  await fs.appendFile(file, jsonl([codex('token_usage_record', {response_id: 'append', usage: usage()})]));
  await f.write('sessions/new.jsonl', [codex('token_usage_record', {response_id: 'new', usage: usage()})]);
  const result = await f.until(index, r => r.calls.length === 3, {accounts: {codex: B}});
  assert.equal(result.calls.filter(c => c.account === A).length, 2);
  assert.equal(result.calls.filter(c => c.account === B).length, 1);
  assert.equal(result.coverage.codex.accountSwitchFiles, 1);
  const restarted = f.create();
  const restored = await f.scan(restarted, {accounts: {codex: B}});
  assert.equal(restored.calls.filter(c => c.account === A).length, 2);
  assert.equal(restored.coverage.codex.accountSwitchFiles, 1);
});

test('first observation without an account does not claim earlier history on later login', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/unknown.jsonl', [codex('token_usage_record', {response_id: 'unknown', usage: usage()})]);
  const index = f.create();
  let result = await f.until(index, r => r.calls.length === 1, {accounts: {}});
  assert.equal(result.calls[0].account, null);
  await fs.appendFile(file, jsonl([codex('token_usage_record', {response_id: 'still-unknown', usage: usage()})]));
  result = await f.until(index, r => r.calls.length === 2);
  assert.ok(result.calls.every(c => c.account === null && c.accountSource === 'unknown'));
  assert.ok(result.coverage.codex.notes.includes('unknown-account-binding-preserved'));
});

test('sanitized cache, reader reload no-op, writer load preserves pending cursors', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/live.jsonl', [
      codex('session_meta', {id: 'live', cwd: '/private/full/path', credentials: SECRET})
    , codex('token_usage_record', {response_id: 'first', usage: usage(), message: SECRET})
  ]);
  const writer = f.create();
  await f.until(writer, r => r.calls.length === 1);
  const reader = f.create();
  const loaded = await reader.load();
  assert.equal(loaded.calls.length, 1);
  const rev = reader.revision;
  assert.equal((await reader.load()).revision, rev);
  const partial = JSON.stringify(codex('token_usage_record', {response_id: 'second', usage: usage()}));
  await fs.appendFile(file, partial.slice(0, 25));
  await f.scan(writer);
  await writer.load();
  await fs.appendFile(file, partial.slice(25) + '\n');
  await f.until(writer, r => r.calls.length === 2);
  assert.equal((await reader.load()).calls.length, 2);
  assert.deepEqual(reader.calls, reader.snapshot().calls);
  const cache = await fs.readFile(path.join(f.dir, 'session-index.json'), 'utf8');
  assert.equal(cache.includes(SECRET), false);
  assert.equal(cache.includes('/private'), false);
  assert.equal(cache.includes(f.root.replaceAll('\\', '\\\\')), false);
  assert.ok(reader.revision > rev);
});

test('corrupt cache recovers through bounded source discovery and atomic valid rewrite', async t => {
  const f = await fixture(t);
  await f.write('sessions/recover.jsonl', [codex('token_usage_record', {response_id: 'recover', usage: usage()})]);
  const index = f.create();
  await f.until(index, r => r.calls.length === 1);
  await fs.writeFile(path.join(f.dir, 'session-index.json'), '{broken');
  const restarted = f.create();
  const result = await f.until(restarted, r => r.calls.length === 1);
  assert.equal(result.coverage.codex.cacheRecovered, true);
  const envelope = await checkpoint(path.join(f.dir, 'session-index.json'));
  assert.equal(envelope.version, 3);
  assert.deepEqual((await fs.readdir(f.dir)).filter(name => name.endsWith('.tmp')), []);
});

test('unknowns and invalid token values remain null; orphan usage does not invent identity/completion', async t => {
  const f = await fixture(t);
  await f.write('sessions/orphan.jsonl', [
    {type: 'token_usage_record', payload: {usage: {input_tokens: -1, cached_input_tokens: '0', output_tokens: null}, message: SECRET}}
  ]);
  const result = await f.until(f.create(), r => r.calls.length === 1);
  const call = result.calls[0];
  for (const key of ['time', 'startedAt', 'completedAt', 'input', 'cached', 'cacheWrite5m', 'cacheWrite1h', 'output', 'reasoning']) assert.equal(call[key], null);
  assert.equal(call.sessionId, null);
  assert.equal(call.model, null);
  assert.equal(call.effort, null);
  assert.equal(call.mode, 'unknown');
  assert.equal(call.provenance.orphan, true);
  assert.equal(call.completionState, 'unknown');
});

test('per-scan byte budget handles oversized records without keeping text; discovery and reads resume', async t => {
  const f = await fixture(t);
  const oversized = codex('response_item', {message: SECRET.repeat(100000)});
  await f.write('sessions/large.jsonl', [oversized, codex('token_usage_record', {response_id: 'after-large', usage: usage()})]);
  const index = f.create();
  let result = await f.scan(index);
  assert.ok(result.coverage.codex.bytesRead <= 2 * 1024 * 1024);
  assert.ok(result.coverage.codex.entriesVisited <= 512);
  assert.equal(result.calls.length, 0);
  result = await f.until(index, r => r.calls.length === 1);
  assert.equal(result.coverage.codex.oversizedLines, 1);
  assert.ok(result.coverage.codex.bytesRead <= 2 * 1024 * 1024);
  const cache = await fs.readFile(path.join(f.dir, 'session-index.json'), 'utf8');
  assert.equal(cache.includes(SECRET), false);
});

test('bounded resumable discovery finds deeply nested and newly added files without replaying old bytes', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 90; i++) await f.write(`projects/project-${i}/session-${i}.jsonl`, [claude(`message-${i}`)], 'claude');
  await f.write('archived_sessions/2026/archive.jsonl', [codex('token_usage_record', {response_id: 'archived', usage: usage()})]);
  const index = f.create();
  let result = await f.until(index, r => r.calls.length === 91);
  await f.write('projects/project-0/new-nested/subagents/child.jsonl', [claude('new-child', {sessionId: 'child'})], 'claude');
  result = await f.until(index, r => r.calls.length === 92);
  assert.equal(result.calls.find(c => c.sessionId === 'child').parentSessionId, 'new-nested');
  result = await f.scan(index);
  assert.equal(result.coverage.codex.bytesRead, 0);
  assert.equal(result.calls.length, 92);
});

test('retention and maxCalls remain bounded, including unknown times', async t => {
  const f = await fixture(t, {maxCalls: 3, retentionDays: 1});
  await f.write('sessions/retained.jsonl', [
      codex('token_usage_record', {response_id: 'too-old', usage: usage()}, new Date(NOW - 3 * 86400000).toISOString())
    , ...Array.from({length: 8}, (_, i) => codex('token_usage_record', {response_id: `recent-${i}`, usage: usage(i)}, new Date(NOW - 10000 + i).toISOString()))
  ]);
  const result = await f.until(f.create(), r => r.calls.length === 3);
  assert.deepEqual(result.calls.map(c => c.input).sort((a, b) => a - b), [5, 6, 7]);
  assert.equal(result.coverage.codex.limited, true);
});

test('explicit response lifecycle, compaction/reset and context window are carried as metadata', async t => {
  const f = await fixture(t);
  await f.write('sessions/response.jsonl', [
      codex('session_meta', {id: 'session-response'})
    , codex('turn_context', {turn_id: 'turn-response', model: 'gpt-fixture', mode: 'Ultrafast', effort: 'low'})
    , {type: 'response.created', timestamp: TIME, response: {id: 'response-lifecycle', usage: usage()}}
    , codex('compacted', {})
    , {type: 'response.completed', timestamp: new Date(NOW - 30000).toISOString(), response: {id: 'response-lifecycle', usage: usage(150), status: 'completed'}}
  ]);
  const result = await f.until(f.create(), r => r.calls.length === 1);
  const call = result.calls[0];
  assert.equal(call.input, 150);
  assert.equal(call.startedAt, Date.parse(TIME));
  assert.equal(call.completedAt, NOW - 30000);
  assert.equal(call.mode, 'Ultrafast');
  assert.equal(call.compactionEpoch, 1);
  assert.equal(call.provenance.compaction, true);
  assert.equal(call.turnId, 'turn-response');
  assert.equal(call.completionState, 'completed');
});

test('cancelled and disposed scans touch no user files and do not leak raw errors', async t => {
  const f = await fixture(t);
  const index = f.create();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.scan(index, {signal: controller.signal}), {name: 'AbortError'});
  assert.deepEqual(await fs.readdir(f.codexHome), ['sessions']);
  await index.dispose();
  await assert.rejects(f.scan(index), /disposed/);
});

test('Claude streaming usage and lifecycle resume across restart without counting fragments as calls', async t => {
  const f = await fixture(t);
  const start = {
      type: 'stream_event'
    , timestamp: TIME
    , sessionId: 'stream-session'
    , event: {type: 'message_start', message: claude('stream-message').message}
  };
  const file = await f.write('projects/project/stream-session.jsonl', [start], 'claude');
  const writer = f.create();
  let result = await f.until(writer, r => r.calls.length === 1);
  const id = result.calls[0].id;
  assert.equal(result.calls[0].completionState, 'in_progress');
  assert.equal(result.activity.claude.active, true);
  await fs.appendFile(file, jsonl([
      {type: 'stream_event', timestamp: TIME, sessionId: 'stream-session', event: {type: 'message_delta', usage: {output_tokens: 77}, delta: {stop_reason: 'end_turn'}}}
    , {type: 'stream_event', timestamp: TIME, sessionId: 'stream-session', event: {type: 'message_stop'}}
    , claude('stream-message', {sessionId: 'stream-session', requestId: 'newly-known-request'})
  ]));
  result = await f.until(f.create(), r => r.calls.length === 1 && r.calls[0].completionState === 'completed');
  assert.equal(result.calls[0].id, id);
  assert.equal(result.calls[0].requestId, 'newly-known-request');
  assert.equal(result.calls[0].input, 132);
  assert.equal(result.calls[0].output, 77);
  assert.equal(result.calls[0].messageId, 'stream-message');
  assert.equal(result.calls[0].provenance.orphan, false);
  assert.equal(result.activity.claude.active, false);
});

test('modern response lifecycle supersedes token_count across archived copies of the same session', async t => {
  const f = await fixture(t);
  await f.write('sessions/modern.jsonl', [
      codex('session_meta', {id: 'common-session'})
    , {type: 'response.completed', timestamp: TIME, response: {id: 'response-modern', usage: usage()}}
  ]);
  await f.write('archived_sessions/legacy.jsonl', [
      codex('session_meta', {id: 'common-session'})
    , codex('event_msg', {type: 'token_count', info: {total_token_usage: usage(300)}})
  ]);
  const index = f.create();
  let result = await f.until(index, r => r.coverage.codex.files === 2 && r.calls.some(c => c.provenance.source === 'codex-response'));
  result = await f.scan(index);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].input, 100);
  assert.equal(result.calls[0].provenance.source, 'codex-response');
});

test('an archived duplicate observed under a new account never relabels the original call', async t => {
  const f = await fixture(t);
  const events = [codex('token_usage_record', {response_id: 'shared-response', usage: usage()})];
  await f.write('sessions/before-switch.jsonl', events);
  const index = f.create();
  await f.until(index, r => r.calls.length === 1);
  await f.write('archived_sessions/after-switch.jsonl', events);
  const result = await f.until(index, r => r.coverage.codex.files === 2, {accounts: {codex: B}});
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].account, A);
  assert.equal(result.calls[0].accountSource, 'local-root-assumption');
});

test('cumulative resets and compaction have explicit epochs; absent tier never supplies Standard', async t => {
  const f = await fixture(t);
  await f.write('sessions/epochs.jsonl', [
      codex('session_meta', {id: 'epochs'})
    , codex('turn_context', {turn_id: 'first-turn', model: 'gpt-fixture', effort: 'high', service_tier: 'priority'})
    , codex('event_msg', {type: 'token_count', info: {total_token_usage: usage(100, 20, 10)}})
    , codex('compacted', {})
    , codex('turn_context', {turn_id: 'second-turn', model: 'gpt-fixture'})
    , codex('event_msg', {type: 'token_count', info: {total_token_usage: usage(10, 0, 2)}})
  ]);
  const result = await f.until(f.create(), r => r.calls.length === 2);
  assert.equal(result.calls[0].mode, 'Fast');
  assert.equal(result.calls[1].mode, 'unknown');
  assert.equal(result.calls[1].effort, null);
  assert.equal(result.calls[1].input, 10);
  assert.equal(result.calls[1].resetEpoch, 1);
  assert.equal(result.calls[1].compactionEpoch, 1);
  assert.equal(result.calls[1].provenance.compaction, true);
  assert.equal(result.calls[1].provenance.contextReset, true);
});

test('multiple roots are distinct, array [] disables provider discovery, and source errors reveal no paths', async t => {
  const f = await fixture(t);
  await f.write('sessions/a.jsonl', [codex('token_usage_record', {response_id: 'same-id', usage: usage()})]);
  const other = path.join(f.root, 'second-home');
  await fs.mkdir(path.join(other, 'sessions'), {recursive: true});
  await fs.writeFile(path.join(other, 'sessions', 'b.jsonl'), jsonl([codex('token_usage_record', {response_id: 'same-id', usage: usage()})]));
  const result = await f.until(f.create(), r => r.calls.length === 2, {codexHome: [f.codexHome, other], claudeDir: []});
  assert.equal(result.coverage.codex.roots, 2);
  assert.equal(result.coverage.claude.roots, 0);
  assert.equal(new Set(result.calls.map(c => c.homeKey)).size, 2);
  assert.equal(new Set(result.calls.map(c => c.id)).size, 2);
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test('a large historical file cannot prevent a recent Codex date directory from being indexed', async t => {
  const f = await fixture(t);
  await f.write('sessions/old-large.jsonl', [codex('response_item', {content: SECRET.repeat(100000)})]);
  await f.write('sessions/2026/10/22/recent.jsonl', [
      codex('session_meta', {id: 'recent-session'})
    , codex('event_msg', {type: 'task_started', turn_id: 'recent-turn'})
    , codex('token_usage_record', {response_id: 'recent-response', usage: usage()})
  ]);
  const index = f.create();
  let result;
  for (let i = 0; i < 4; i++) {
    result = await f.scan(index);
    if (result.calls.length) break;
  }
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].sessionId, 'recent-session');
  assert.equal(result.activity.codex.active, true);
  assert.ok(result.coverage.codex.bytesRead <= 2 * 1024 * 1024);
  assert.ok(result.coverage.codex.filesVisited <= 64);
});

test('Claude subagent logs that repeat the parent sessionId still keep a distinct child session', async t => {
  const f = await fixture(t);
  await f.write('projects/project/parent-session/subagents/agent-child.jsonl', [
    claude('child-log', {sessionId: 'parent-session', agentId: 'child-agent', parentUuid: 'message-parent'})
  ], 'claude');
  const result = await f.until(f.create(), r => r.calls.length === 1);
  assert.equal(result.calls[0].parentSessionId, 'parent-session');
  assert.equal(result.calls[0].sessionId, 'child-agent');
});

test('call snapshots are deeply immutable, reused unchanged, and replaced without mutating earlier snapshots', async t => {
  const f = await fixture(t);
  const event = codex('token_usage_record', {response_id: 'stable-response', usage: usage()});
  const file = await f.write('sessions/immutable.jsonl', [event]);
  const writer = f.create();
  const before = await f.until(writer, r => r.calls.length === 1);
  assert.equal(writer.calls, before.calls);
  assert.equal(writer.snapshot().calls, before.calls);
  assert.equal((await f.scan(writer)).calls, before.calls);
  assert.throws(() => before.calls.push(before.calls[0]), TypeError);
  assert.throws(() => { before.calls[0].input = 999; }, TypeError);
  assert.throws(() => { before.calls[0].provenance.cacheWriteTotal = 999; }, TypeError);
  assert.throws(() => before.calls[0].missingFields.push('fake'), TypeError);
  assert.throws(() => before.calls[0].provenance.unsupportedTokenCategories.push('fake'), TypeError);
  await fs.appendFile(file, jsonl([codex('token_usage_record', {response_id: 'stable-response', usage: usage(200)})]));
  const after = await f.until(writer, r => r.calls[0].input === 200);
  assert.notEqual(after.calls, before.calls);
  assert.equal(before.calls[0].input, 100);
  assert.equal(after.calls[0].input, 200);
  const reader = f.create();
  const loaded = await reader.load();
  assert.equal((await reader.load()).calls, loaded.calls);
  assert.equal(Object.isFrozen(loaded.calls[0]), true);
});

test('version 1 cache remains readable and the next changed checkpoint migrates atomically to version 3', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/migrate.jsonl', [codex('token_usage_record', {response_id: 'before-migration', usage: usage()})]);
  const writer = f.create();
  await f.until(writer, r => r.calls.length === 1);
  const envelope = await checkpoint(writer.file);
  assert.equal(envelope.version, 3);
  const data = JSON.stringify(envelope.data);
  await fs.writeFile(writer.file, JSON.stringify({version: 1, data, checksum: crypto.createHash('sha256').update(data).digest('hex')}));
  const restarted = f.create();
  const restored = await restarted.load();
  assert.equal(restored.calls.length, 1);
  await fs.appendFile(file, jsonl([codex('token_usage_record', {response_id: 'after-migration', usage: usage()})]));
  const changed = await f.until(restarted, r => r.calls.length === 2);
  assert.equal(changed.calls.filter(call => call.account === A).length, 2);
  const migrated = await checkpoint(writer.file);
  assert.equal(migrated.version, 3);
});

test('failed atomic checkpoint keeps the previous account bindings and cursor recoverable', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/checkpoint.jsonl', [codex('token_usage_record', {response_id: 'checkpoint-before', usage: usage()})]);
  const writer = f.create();
  await f.until(writer, r => r.calls.length === 1);
  const previous = await fs.readFile(writer.file, 'utf8');
  const rename = fs.rename;
  const failure = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === writer.file) throw Object.assign(new Error('fixture failure'), {code: 'EACCES'});
    return await rename(from, to);
  });
  await fs.appendFile(file, jsonl([codex('token_usage_record', {response_id: 'checkpoint-after', usage: usage()})]));
  const pending = await f.until(writer, r => r.calls.length === 2, {accounts: {codex: B}});
  assert.equal(pending.coverage.codex.cacheWriteFailed, true);
  assert.equal(await fs.readFile(writer.file, 'utf8'), previous);
  assert.deepEqual((await fs.readdir(f.dir)).filter(name => name.endsWith('.tmp')), []);
  failure.mock.restore();
  const restarted = f.create();
  const recovered = await f.until(restarted, r => r.calls.length === 2, {accounts: {codex: B}});
  assert.ok(recovered.calls.every(call => call.account === A));
  assert.equal(recovered.coverage.codex.cacheWriteFailed, false);
});

test('project labels use only an explicit path basename, normalize NFKC, strip controls, and keep distinct project IDs', async t => {
  const f = await fixture(t);
  await f.write('projects/labels/session-a.jsonl', [
      claude('unicode-label', {cwd: '/private/Ｃａｆｅ\u0301\u202e\u0001'})
    , claude('windows-label', {cwd: 'C:\\private\\windows-project\\'})
    , claude('long-label', {cwd: '/private/' + '界'.repeat(100)})
    , claude('astral-label', {cwd: '/private/' + '🙂'.repeat(90)})
    , claude('same-basename-one', {cwd: '/private/one/shared'})
    , claude('same-basename-two', {cwd: '/private/two/shared'})
    , claude('dot-label', {cwd: '/private/..'})
    , claude('unsafe-label', {cwd: '/private/fullwidth：slash／name\u2028'})
  ], 'claude');
  const index = f.create();
  const result = await f.until(index, r => r.calls.length === 8);
  const call = id => result.calls.find(c => c.messageId === id);
  assert.equal(call('unicode-label').projectName, 'Café');
  assert.equal(call('windows-label').projectName, 'windows-project');
  assert.equal(call('long-label').projectName, '界'.repeat(80));
  assert.equal(call('astral-label').projectName, '🙂'.repeat(80));
  assert.equal(call('same-basename-one').projectName, 'shared');
  assert.equal(call('same-basename-two').projectName, 'shared');
  assert.notEqual(call('same-basename-one').project, call('same-basename-two').project);
  assert.equal(call('dot-label').projectName, null);
  assert.equal(call('unsafe-label').projectName, 'fullwidthslashname');
  for (const item of result.calls) {
    if (item.projectName !== null) {
      assert.ok(Array.from(item.projectName).length <= 80);
      assert.doesNotMatch(item.projectName, /[\\/:\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    }
  }
  const persisted = await fs.readFile(index.file, 'utf8');
  assert.equal(persisted.includes('/private'), false);
  assert.equal(persisted.includes('C:\\\\private'), false);
  const reader = f.create();
  const restored = await reader.load();
  assert.equal(restored.calls.find(c => c.messageId === 'unicode-label').projectName, 'Café');
});

test('project names are never recovered from IDs or arbitrary projectName fields; explicit project paths are supported', async t => {
  const f = await fixture(t);
  await f.write('sessions/explicit-project.jsonl', [
      codex('session_meta', {id: 'looks-like-project-name', projectName: SECRET})
    , codex('token_usage_record', {response_id: 'no-path', usage: usage()})
    , codex('token_usage_record', {response_id: 'explicit-path', project_path: '/private/explicit-basename', usage: usage()})
  ]);
  const result = await f.until(f.create(), r => r.calls.length === 2);
  assert.equal(result.calls[0].project, null);
  assert.equal(result.calls[0].projectName, null);
  assert.equal(result.calls[1].projectName, 'explicit-basename');
  assert.match(result.calls[1].project, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes('/private'), false);
});

test('version 2 streams Unicode metadata across chunk boundaries and migrates without a new source event', async t => {
  const f = await fixture(t);
  await f.write('projects/legacy/session-a.jsonl', Array.from({length: 260}, (_, i) => claude(`legacy-${i}`, {cwd: '/private/프로젝트🙂'})), 'claude');
  const writer = f.create();
  await f.until(writer, r => r.calls.length === 260);
  const data = (await checkpoint(writer.file)).data;
  const encoded = JSON.stringify(data);
  assert.ok(Buffer.byteLength(encoded) > 65536);
  await fs.writeFile(writer.file, JSON.stringify({checksum: crypto.createHash('sha256').update(encoded).digest('hex'), data, version: 2}));
  const reader = f.create();
  const loaded = await reader.load();
  assert.equal(loaded.calls.length, 260);
  assert.ok(loaded.calls.every(call => call.projectName === '프로젝트🙂' && call.account === A));
  const first = loaded.calls[0];
  await f.scan(reader);
  assert.equal((await checkpoint(writer.file)).version, 3);
  assert.equal(reader.calls[0], first);
});

test('version 1 escaped Unicode and escaped JSON survive a decoder boundary without retaining original text', async t => {
  const f = await fixture(t);
  await f.write('projects/legacy/session-a.jsonl', Array.from({length: 90}, (_, i) => claude(`escaped-${i}`, {cwd: '/private/프로젝트🙂'})), 'claude');
  const writer = f.create();
  await f.until(writer, r => r.calls.length === 90);
  const encoded = JSON.stringify((await checkpoint(writer.file)).data);
  const envelope = JSON.stringify({version: 1, checksum: crypto.createHash('sha256').update(encoded).digest('hex'), data: encoded});
  const escaped = envelope.replace(/[^\x20-\x7e]/gu, value => value.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
  const pair = escaped.indexOf('\\ud83d\\ude42');
  assert.ok(pair > 0);
  const padding = (16384 - (pair + 4) % 16384) % 16384;
  await fs.writeFile(writer.file, ' '.repeat(padding) + escaped);
  const reader = f.create();
  const loaded = await reader.load();
  assert.equal(loaded.calls.length, 90);
  assert.ok(loaded.calls.every(call => call.projectName === '프로젝트🙂'));
  assert.equal(JSON.stringify(loaded).includes(SECRET), false);
});

test('v3 checksum/truncation failures cannot publish a partial replacement snapshot', async t => {
  const f = await fixture(t);
  await f.write('sessions/guard.jsonl', [codex('token_usage_record', {response_id: 'guard', usage: usage()})]);
  const writer = f.create();
  await f.until(writer, r => r.calls.length === 1);
  const reader = f.create();
  const original = await reader.load();
  const raw = await fs.readFile(writer.file, 'utf8');
  const lines = raw.trimEnd().split('\n');
  const callIndex = lines.findIndex(line => JSON.parse(line).kind === 'call');
  const changed = JSON.parse(lines[callIndex]);
  changed.value.call.input = 999;
  lines[callIndex] = JSON.stringify(changed);
  const replacement = writer.file + '.replacement';
  await fs.writeFile(replacement, lines.join('\n') + '\n');
  await fs.rename(replacement, writer.file);
  const invalid = await reader.load();
  assert.equal(invalid.calls, original.calls);
  assert.equal(invalid.calls[0].input, 100);
  assert.equal(invalid.coverage.codex.cacheRecovered, true);
  await fs.writeFile(writer.file, raw.slice(0, raw.lastIndexOf('{"kind":"checksum"')));
  assert.equal((await reader.load()).calls, original.calls);
  const fresh = f.create();
  assert.equal((await fresh.load()).calls.length, 0);
  const rebuilt = await f.until(fresh, r => r.calls.length === 1);
  assert.equal(rebuilt.calls[0].account, A);
});

test('reader checkpoint refresh shares unchanged frozen calls and preserves previous snapshots', async t => {
  const f = await fixture(t);
  const file = await f.write('sessions/reuse.jsonl', [
      codex('token_usage_record', {response_id: 'unchanged', usage: usage()})
    , codex('token_usage_record', {response_id: 'updated', usage: usage(200)})
  ]);
  const writer = f.create();
  await f.until(writer, r => r.calls.length === 2);
  const reader = f.create();
  const before = await reader.load();
  const unchanged = before.calls.find(call => call.input === 100);
  const changed = before.calls.find(call => call.input === 200);
  await fs.appendFile(file, jsonl([codex('token_usage_record', {response_id: 'updated', usage: usage(300)})]));
  await f.until(writer, r => r.calls.some(call => call.input === 300));
  const after = await reader.load();
  assert.equal(after.calls.find(call => call.input === 100), unchanged);
  assert.notEqual(after.calls.find(call => call.input === 300), changed);
  assert.equal(changed.input, 200);
});

test('v3 loading yields between bounded reads while returning all canonical records', async t => {
  const f = await fixture(t);
  await f.write('projects/yield/session-a.jsonl', Array.from({length: 350}, (_, i) => claude(`yield-${i}`)), 'claude');
  const writer = f.create();
  await f.until(writer, r => r.calls.length === 350);
  const reader = f.create();
  let yielded = 0;
  let active = true;
  const tick = () => { if (active) { yielded++; setImmediate(tick); } };
  setImmediate(tick);
  let loaded;
  try { loaded = await reader.load(); }
  finally { active = false; }
  assert.equal(loaded.calls.length, 350);
  assert.ok(yielded > 1);
  assert.equal(reader.calls[0], reader._records.get(reader.calls[0].id).call);
});
