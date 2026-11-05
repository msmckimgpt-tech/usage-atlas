'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const focus = require('../media/provider-focus.js');
test('focus selects only the clicked provider, switches directly and returns to all on a second click', () => {
  const ids = ['codex', 'claude'];
  assert.deepEqual(focus.visible(ids, null), ids);
  let selected = focus.toggle(ids, null, 'codex'); assert.deepEqual(focus.visible(ids, selected), ['codex']);
  selected = focus.toggle(ids, selected, 'claude'); assert.deepEqual(focus.visible(ids, selected), ['claude']);
  selected = focus.toggle(ids, selected, 'claude'); assert.equal(selected, null); assert.deepEqual(focus.visible(ids, selected), ids);
});
test('focus supports any number of registered providers without pairwise toggle rules', () => {
  const ids = ['first', 'second', 'future-third', 'future-fourth'], original = [...ids];
  for (const id of ids) {assert.deepEqual(focus.visible(ids, focus.toggle(ids, null, id)), [id]); assert.equal(focus.toggle(ids, id, id), null);}
  assert.deepEqual(focus.visible(ids, focus.toggle(ids, 'first', 'future-fourth')), ['future-fourth']); assert.deepEqual(ids, original);
});
test('removed or unknown focus providers safely fall back to the full current registry', () => {
  const ids = ['codex', 'claude'];
  assert.deepEqual(focus.visible(ids, 'removed'), ids); assert.equal(focus.toggle(ids, 'codex', 'unknown'), 'codex');
  assert.equal(focus.restore(ids, {version: 5, focusedProvider: 'removed'}), null); assert.deepEqual(focus.visible([], 'removed'), []);
});
test('saved focus and previous single-provider selections migrate without leaving an empty chart', () => {
  const ids = ['codex', 'claude'];
  assert.equal(focus.restore(ids, {version: 5, focusedProvider: 'claude'}), 'claude');
  assert.equal(focus.restore(ids, {version: 4, codex: true, claude: false}), 'codex');
  assert.equal(focus.restore(ids, {version: 3, codex: false, claude: true}), 'claude');
  for (const saved of [null, {version: 4, codex: true, claude: true}, {version: 4, codex: false, claude: false}, {version: 4, codex: true}]) assert.equal(focus.restore(ids, saved), null);
});
