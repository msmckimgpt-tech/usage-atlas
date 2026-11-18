'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {migrateLegacyStorage, LEGACY_ID, MARKER} = require('../src/storage-migration.cjs');
async function root() { return fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-migrate-')); }
const exists = file => fs.stat(file).then(() => true, () => false);
test('복사 후 이전 폴더를 보존하고 한 번만 실행한다', async () => {
  const base = await root(), legacy = path.join(base, LEGACY_ID), dir = path.join(base, 'publisher.usage-atlas');
  await fs.mkdir(path.join(legacy, 'sub'), {recursive: true});
  await fs.writeFile(path.join(legacy, 'metadata.json'), '{"a":1}');
  await fs.writeFile(path.join(legacy, 'sub', 'x.txt'), 'x');
  await fs.writeFile(path.join(legacy, 'history-archive.sqlite-shm'), 'shm');
  assert.equal((await migrateLegacyStorage(dir)).status, 'migrated');
  assert.equal(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'), '{"a":1}');
  assert.equal(await fs.readFile(path.join(dir, 'sub', 'x.txt'), 'utf8'), 'x');
  assert.equal(await exists(path.join(dir, 'history-archive.sqlite-shm')), false);
  assert.ok(await exists(path.join(dir, MARKER)));
  assert.ok(await exists(path.join(legacy, 'metadata.json')));
  assert.equal(await exists(dir + '.migrating'), false);
  await fs.writeFile(path.join(dir, 'metadata.json'), 'changed');
  assert.equal((await migrateLegacyStorage(dir)).status, 'done');
  assert.equal(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'), 'changed');
  await fs.rm(base, {recursive: true, force: true});
});
test('마커 없는 새 폴더는 지우지 않고 옆으로 옮긴 뒤 이전한다', async () => {
  const base = await root(), legacy = path.join(base, LEGACY_ID), dir = path.join(base, 'publisher.usage-atlas');
  await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'metadata.json'), 'old');
  await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'partial.json'), 'partial');
  const result = await migrateLegacyStorage(dir);
  assert.equal(result.status, 'migrated');
  assert.equal(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'), 'old');
  assert.equal(await exists(path.join(dir, 'partial.json')), false);
  assert.equal(await fs.readFile(path.join(result.aside, 'partial.json'), 'utf8'), 'partial');
  await fs.rm(base, {recursive: true, force: true});
});
test('이전 폴더가 없거나 같은 폴더면 아무것도 하지 않는다', async () => {
  const base = await root(), legacy = path.join(base, LEGACY_ID), dir = path.join(base, 'publisher.usage-atlas');
  assert.equal((await migrateLegacyStorage(dir)).status, 'none');
  await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'metadata.json'), 'old');
  assert.equal((await migrateLegacyStorage(legacy)).status, 'same');
  assert.equal(await exists(dir), false);
  await fs.rm(base, {recursive: true, force: true});
});
