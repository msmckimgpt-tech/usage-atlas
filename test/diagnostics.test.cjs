'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Diagnostics} = require('../src/diagnostics.cjs');
test('disabled diagnostics execute normally without retaining performance samples', async () => {
  const diagnostics = new Diagnostics(__dirname, false);
  assert.equal(await diagnostics.measure('codex', 'query', async () => 7), 7);
  await assert.rejects(diagnostics.measure('claude', 'query', async () => {throw new Error('secret fixture');}));
  assert.deepEqual(diagnostics.snapshot('claude'), {enabled: false}); assert.equal(diagnostics.events.length, 0);
});
test('bounded diagnostics separate failures and never persist exception text', async () => {
  const diagnostics = new Diagnostics(__dirname);
  for (let i = 0; i < 210; i++) await diagnostics.measure(i % 2 ? 'codex' : 'claude', 'query', async () => i);
  await assert.rejects(diagnostics.measure('codex', 'query', async () => {throw new Error('AUTH-TOKEN-DO-NOT-PERSIST');}));
  assert.equal(diagnostics.events.length, 192);
  const report = diagnostics.snapshot('codex'); assert.equal(report.events.length, 48);
  assert.equal(report.events.at(-1).outcome, 'failed'); assert.equal(report.scope, 'extension-host-process');
  assert.ok(report.events.every(e => e.elapsedMs >= 0 && e.cpuMs >= 0 && e.rssMiB > 0));
  assert.equal(JSON.stringify(report).includes('AUTH-TOKEN'), false);
  diagnostics.setEnabled(false); assert.deepEqual(diagnostics.snapshot('codex'), {enabled: false});
});
