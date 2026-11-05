'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {ConversationReader, messages, limits} = require('../src/conversations.cjs');
const {SessionIndex} = require('../src/session-index.cjs');
const {hash: accountHash} = require('../src/core.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = Date.now(), time = i => new Date(now - (100 - i) * 1000).toISOString();
const event = (provider, i, content = '한글 대화 ' + i) => provider === 'codex'
  ? {type: 'response_item', timestamp: time(i), payload: {type: 'message', role: i % 2 ? 'assistant' : 'user', content: [{type: i % 2 ? 'output_text' : 'input_text', text: content}]}}
  : {type: i % 2 ? 'assistant' : 'user', timestamp: time(i), uuid: 'uuid-' + i, message: {id: 'message-' + i, role: i % 2 ? 'assistant' : 'user', content: [{type: 'text', text: content}]}};
async function fixture(provider, events, work) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-conversation-'));
  const root = path.join(dir, provider === 'codex' ? 'sessions' : 'projects'), file = path.join(root, 'nested', 'session.jsonl');
  const reader = new ConversationReader();
  try {
    await fs.mkdir(path.dirname(file), {recursive: true});
    const bytes = Buffer.from(events.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n'); await fs.writeFile(file, bytes);
    const hint = {key: hash(`${provider}:${file}`), provider, account: accountHash(provider), homeKey: hash(dir), path: file, headLength: Math.min(256, bytes.length), headHash: hash(bytes.subarray(0, 256))};
    const options = {hints: [hint], roots: [root], start: now - 50000, end: now, earliest: now - 200000};
    await work({reader, options, dir, file, root, bytes});
  } finally {
    await reader.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('usage-atlas-conversation-'));
    await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
}
test('Codex and Claude expose only user/assistant text, never tool, system, stream or image bytes', () => {
  for (const provider of ['codex', 'claude']) {
    assert.equal(messages(event(provider, 1, '<script>alert(1)</script>'), provider)[0].text, '<script>alert(1)</script>');
    const tool = provider === 'codex' ? {type: 'response_item', timestamp: time(1), payload: {type: 'function_call', role: 'assistant', arguments: 'SECRET'}} : {type: 'user', timestamp: time(1), message: {role: 'user', content: [{type: 'tool_result', content: 'SECRET'}]}};
    assert.deepEqual(messages(tool, provider), []);
    assert.deepEqual(messages({...event(provider, 1), timestamp: 'bad'}, provider), []);
  }
  assert.deepEqual(messages({type: 'stream_event', timestamp: time(1), event: {type: 'message_start', message: {content: [{type: 'text', text: 'partial'}]}}}, 'claude'), []);
  const multi = messages({type: 'response.completed', timestamp: time(1), response: {id: 'r', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'one'}]}, {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'two'}]}]}}, 'codex');
  assert.equal(multi[0].text, 'one\ntwo');
});
test('both providers page newest first, preserve Korean, label prior context and leave files unchanged', async () => {
  for (const provider of ['codex', 'claude']) await fixture(provider, Array.from({length: 101}, (_, i) => event(provider, i)), async ({reader, options, file, bytes}) => {
    const first = await reader.open(options), second = await reader.page(first.next), third = await reader.page(second.next);
    const rows = [...first.items, ...second.items, ...third.items];
    assert.equal(first.items.length, 40); assert.equal(rows.length, 101); assert.equal(new Set(rows.map(row => row.id)).size, 101);
    assert.equal(rows[0].text, '한글 대화 100'); assert.equal(rows.at(-1).text, '한글 대화 0');
    assert.ok(rows.every((row, i) => !i || row.time <= rows[i - 1].time));
    assert.equal(first.items[0].context, false); assert.equal(third.items.at(-1).context, true);
    assert.equal(third.hasMore, false); assert.equal(third.next, null); assert.ok(bytes.equals(await fs.readFile(file)));
    await assert.rejects(reader.page('forged-token'));
    await reader.close(); assert.equal(reader.states.length, 0); await assert.rejects(reader.page());
  });
});
test('timestamps are sorted before pagination even when source events are written out of order', () => fixture('codex', Array.from({length: 101}, (_, i) => event('codex', (i * 37) % 101)), async ({reader, options}) => {
  let page = await reader.open(options), rows = [...page.items];
  while (page.next) {page = await reader.page(page.next); rows.push(...page.items);}
  assert.equal(rows.length, 101); assert.ok(rows.every((row, i) => !i || row.time <= rows[i - 1].time));
  assert.equal(rows[0].text, '한글 대화 100'); assert.equal(rows.at(-1).text, '한글 대화 0');
  assert.ok(reader.index.every(entry => !Object.hasOwn(entry, 'text')), 'only offsets and hashes survive page retrieval');
}));
test('large conversations retain only the latest bounded offset metadata even if newest messages occur first in the file', () => fixture('claude', Array.from({length: limits.metadata + 5}, (_, i) => ({...event('claude', i % 100, 'bounded-' + i), uuid: 'unique-' + i, timestamp: new Date(now - i).toISOString()})), async ({reader, options}) => {
  let page = await reader.open(options); while (page.loading) page = await reader.page(page.next);
  assert.equal(page.items[0].text, 'bounded-0'); assert.equal(reader.index.length, limits.metadata); assert.equal(page.limited, true);
  assert.equal(reader.index.at(-1).time, now - limits.metadata + 1);
  assert.ok(reader.index.every(row => !Object.hasOwn(row, 'text')));
}));
test('cache-restored paths are found by file hash and expired or changed source heads cannot be read', () => fixture('claude', [event('claude', 1)], async ({reader, options, file}) => {
  options.hints[0].path = null; assert.equal((await reader.open(options)).items.length, 1);
  await reader.close(); await fs.writeFile(file, JSON.stringify(event('claude', 1, 'changed')) + '\n');
  await assert.rejects(reader.open(options), /변경/);
}));
test('Codex event fallback duplicates collapse but distinct messages with equal text remain', () => fixture('codex', [
    event('codex', 1, 'one')
  , {type: 'event_msg', timestamp: time(1), payload: {type: 'agent_message', message: 'one'}}
  , {...event('codex', 2, 'repeat'), payload: {...event('codex', 2, 'repeat').payload, id: 'a'}}
  , {...event('codex', 3, 'repeat'), payload: {...event('codex', 3, 'repeat').payload, id: 'b'}}
], async ({reader, options}) => {assert.equal((await reader.open(options)).items.length, 3);}));
test('long text, oversized lines, malformed rows and incomplete tails stay bounded and explicit', () => fixture('claude', [
    event('claude', 0, 'x'.repeat(20000))
  , event('claude', 1, 'x'.repeat(limits.line + 10))
  , '{bad'
  , event('claude', 2, 'end')
], async ({reader, options, file}) => {
  await fs.appendFile(file, '{"type":"unfinished');
  const page = await reader.open(options);
  assert.equal(page.items.length, 2); assert.ok(page.items.some(row => row.clipped && row.text.length === limits.text));
  assert.ok(page.oversizedLines > 0); assert.ok(page.malformedLines > 0); assert.equal(page.incompleteTail, true);
}));
test('a tool-heavy file stops at the per-page read budget and resumes without indexing its body', () => fixture('codex', [event('codex', 0), ...Array.from({length: 150}, () => JSON.stringify({type: 'response_item', timestamp: time(1), payload: {type: 'function_call_output', output: 'x'.repeat(64000)}}))], async ({reader, options}) => {
  const first = await reader.open(options); assert.ok(first.scannedBytes <= limits.bytes); assert.equal(first.limited, true); assert.equal(first.items.length, 0);
  const second = await reader.page(first.next); assert.equal(second.items[0].text, '한글 대화 0'); assert.ok(second.scannedBytes <= limits.bytes);
}));
test('source account changes and cancellation cannot return another account or stale text', () => fixture('codex', [event('codex', 0), {...event('codex', 1), account_hash: accountHash('other')}], async ({reader, options}) => {
  await assert.rejects(reader.open(options), /계정/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(reader.open({...options, signal: controller.signal}), /취소/);
}));
test('a bound session cannot display another session from a mixed file', () => fixture('claude', [{...event('claude', 0), sessionId: 'other'}], async ({reader, options}) => {
  options.hints[0].sessionId = 'selected'; await assert.rejects(reader.open(options), /세션/);
  options.hints[0].parentSessionId = 'other'; assert.equal((await reader.open(options)).items.length, 1, 'a subagent file may carry its known parent session ID');
}));
test('a symlink cannot expose a file outside the approved log root', async t => fixture('claude', [event('claude', 1)], async ({reader, options, dir, file}) => {
  const outside = path.join(dir, 'outside.jsonl'), link = file + '-link.jsonl'; await fs.writeFile(outside, JSON.stringify(event('claude', 1, 'OUTSIDE')) + '\n');
  try {await fs.symlink(outside, link, 'file');} catch (error) {if (['EPERM', 'EACCES'].includes(error.code)) {t.skip('symlink privilege unavailable'); return;} throw error;}
  options.hints[0] = {...options.hints[0], key: hash('claude:' + link), path: link};
  await assert.rejects(reader.open(options), /경로/);
}));
test('session source lookup respects provider/account/home and never persists transcript text', () => fixture('codex', [
    {type: 'session_meta', timestamp: time(0), payload: {id: 'session', account_hash: accountHash('codex')}}
  , event('codex', 1, 'PRIVATE-CONVERSATION-MUST-NOT-BE-INDEXED')
  , {type: 'response.completed', timestamp: time(2), response: {id: 'r', model: 'gpt-6.1-sol', usage: {input_tokens: 1, cached_input_tokens: 0, output_tokens: 1}}}
], async ({dir, root, file}) => {
  const index = new SessionIndex({dir: path.join(dir, 'cache')});
  try {
    for (let i = 0; i < 4 && !index.calls.length; i++) await index.scan({codexHome: path.dirname(root), claudeDir: [], accounts: {codex: accountHash('codex')}});
    const call = index.calls[0]; assert.ok(call);
    const hints = await index.conversationSources(call); assert.equal(hints.length, 1); assert.equal(hints[0].path, file);
    assert.equal((await index.conversationSources({...call, account: accountHash('other')})).length, 0);
    assert.equal((await index.conversationSources({...call, homeKey: hash('other')})).length, 0);
    assert.equal((await fs.readFile(index.file, 'utf8')).includes('PRIVATE-CONVERSATION'), false);
  } finally {await index.dispose();}
}));
