'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {migrateLegacyStorage, LEGACY_ID, MARKER} = require('../src/storage-migration.cjs');
async function root() { return fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-migrate-')); }
test('복사 후 이전 폴더를 보존한다', async () => {
  const base = await root(), legacy = path.join(base, LEGACY_ID), dir = path.join(base, 'publisher.usage-atlas');
  await fs.mkdir(path.join(legacy, 'sub'), {recursive: true});
  await fs.writeFile(path.join(legacy, 'metadata.json'), '{"a":1}');
  await fs.writeFile(path.join(legacy, 'sub', 'x.txt'), 'x');
  assert.equal((await migrateLegacyStorage(dir)).status, 'migrated');
  assert.equal(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'), '{"a":1}');
  assert.equal(await fs.readFile(path.join(dir, 'sub', 'x.txt'), 'utf8'), 'x');
  assert.ok(await fs.stat(path.join(dir, MARKER)));
  assert.ok(await fs.stat(path.join(legacy, 'metadata.json')));
  assert.equal((await migrateLegacyStorage(dir)).status, 'skipped');
  await fs.rm(base, {recursive: true, force: true});
});
test('새 폴더에 데이터가 있거나 이전 폴더가 없으면 건드리지 않는다', async () => {
  const base = await root(), legacy = path.join(base, LEGACY_ID), dir = path.join(base, 'publisher.usage-atlas');
  assert.equal((await migrateLegacyStorage(dir)).status, 'none');
  await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'metadata.json'), 'old');
  await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'metadata.json'), 'new');
  assert.equal((await migrateLegacyStorage(dir)).status, 'skipped');
  assert.equal(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'), 'new');
  assert.equal((await migrateLegacyStorage(legacy)).status, 'same');
  await fs.rm(base, {recursive: true, force: true});
});
