'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const visibility = require('../media/provider-visibility.js');
test('model buttons independently hide and restore any subset without switching peers', () => {
  const ids = ['codex', 'claude', 'future-third', 'future-fourth'];
  let hidden = []; assert.deepEqual(visibility.visible(ids, hidden), ids);
  hidden = visibility.toggle(ids, hidden, 'codex'); assert.deepEqual(visibility.visible(ids, hidden), ids.slice(1));
  hidden = visibility.toggle(ids, hidden, 'future-third'); assert.deepEqual(visibility.visible(ids, hidden), ['claude', 'future-fourth']);
  hidden = visibility.toggle(ids, hidden, 'codex'); assert.deepEqual(visibility.visible(ids, hidden), ['codex', 'claude', 'future-fourth']);
  assert.deepEqual(visibility.toggle(ids, hidden, 'unknown'), hidden); assert.deepEqual(ids, ['codex', 'claude', 'future-third', 'future-fourth']);
});
test('all-off and single model registries stay off until explicitly re-enabled', () => {
  const ids = ['codex', 'claude']; let hidden = [];
  for (const id of ids) hidden = visibility.toggle(ids, hidden, id);
  assert.deepEqual(visibility.visible(ids, hidden), []); assert.deepEqual(visibility.visible([], hidden), []);
  assert.deepEqual(visibility.visible(['codex'], ['codex']), []);
  assert.deepEqual(visibility.toggle(ids, hidden, 'claude'), ['codex']);
});
test('version six preserves empty/multiple selections and absent model choices with safe bounds', () => {
  const id = 'antigravity-5d72436256ada538';
  assert.deepEqual(visibility.restore(['codex', 'claude'], {version: 6, hiddenProviders: ['codex', id, 'codex', null, {}, 'unknown']}), ['codex', id]);
  assert.deepEqual(visibility.restore(['codex', 'claude'], {version: 6, hiddenProviders: ['codex', 'claude']}), ['codex', 'claude']);
  assert.deepEqual(visibility.restore([], {version: 6, hiddenProviders: []}), []);
});
test('previous exclusive focus migrates to an independent subset without losing other saved preferences', () => {
  const ids = ['codex', 'claude', 'antigravity'];
  assert.deepEqual(visibility.restore(ids, {version: 5, focusedProvider: 'claude'}), ['codex', 'antigravity']);
  assert.deepEqual(visibility.restore(ids, {version: 5, focusedProvider: 'removed'}), []);
  assert.deepEqual(visibility.restore(['codex', 'claude'], {version: 4, codex: true, claude: false}), ['claude']);
  for (const saved of [null, {version: 4, codex: true, claude: true}, {version: 4, codex: false, claude: false}, {version: 4, codex: true}]) assert.deepEqual(visibility.restore(['codex', 'claude'], saved), []);
});
test('service settings override model settings; other providers and unknown future groups remain independent', () => {
  const model = {last: {label: 'Gemini'}};
  assert.equal(visibility.enabled('codex', {}, {showCodex: false}), false);
  assert.equal(visibility.enabled('claude', {}, {showCodex: false}), true);
  assert.equal(visibility.enabled('antigravity-5d72436256ada538', model, {showAntigravity: false, showAntigravityGemini: true}), false);
  assert.equal(visibility.enabled('antigravity-5d72436256ada538', model, {showAntigravityGemini: false}), false);
  assert.equal(visibility.enabled('antigravity-70e9d05c2321d220', {}, {showAntigravityGemini: false}), true);
  assert.equal(visibility.enabled('antigravity-752d865b3431c7da', {}, {showAntigravityArgon: false}), false);
  assert.equal(visibility.enabled('antigravity-1111111111111111', {last: {label: 'future'}}, {showAntigravityArgon: false}), true);
  const config = visibility.settings((key, fallback) => key === 'display.codex' ? false : fallback);
  assert.equal(config.showCodex, false); assert.equal(config.showAntigravityGemini, true);
});

test('display switches live together in the ordered native settings category with backward-compatible defaults', () => {
  const manifest = require('../package.json'), category = manifest.contributes.configuration.find(c => c.id === 'usageAtlas.display');
  assert.equal(category.title, '서비스·모델 표시'); const props = category.properties;
  assert.equal(Object.keys(props).length, 6);
  for (const key of Object.values(visibility.displaySettings)) {const property = props['usageAtlas.' + key]; assert.equal(property.type, 'boolean'); assert.equal(property.default, true); assert.ok(Number.isFinite(property.order));}
});
