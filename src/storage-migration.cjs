'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const LEGACY_ID = 'local-tools.usage-atlas';
const MARKER = '.migrated-from-' + LEGACY_ID;
const LOCK_STALE_MS = 5 * 60 * 1000, WAIT_MS = 120000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transient = error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
const exists = file => fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function copyFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.copyFile(from, to); return; } catch (error) { if (!transient(error) || attempt >= 4) throw error; await sleep(250 * (attempt + 1)); }
  }
}
async function copyTree(from, to) {
  await fs.mkdir(to, {recursive: true});
  for (const entry of await fs.readdir(from, {withFileTypes: true})) {
    if (entry.isSymbolicLink() || entry.name.endsWith('-shm')) continue;
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target); else await copyFile(source, target);
  }
}
// 같은 폴더를 쓰는 창(프로필·WSL 포함)이 동시에 활성화돼도 한 곳만 이전하도록 잠금 폴더를 쓴다.
async function acquire(lock) {
  for (;;) {
    try { await fs.mkdir(lock); return true; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - (await fs.stat(lock).catch(() => ({mtimeMs: 0}))).mtimeMs;
      if (age > LOCK_STALE_MS) { await fs.rmdir(lock).catch(() => {}); continue; }
      return false;
    }
  }
}
// Marketplace 게시자 변경으로 globalStorage 폴더 이름(게시자.확장)이 바뀌므로 이전 기록을 한 번 복사한다.
// 임시 폴더에 전부 복사한 뒤 마커와 함께 교체하므로 중간에 실패해도 반쪽짜리 폴더가 남지 않는다.
// 마커가 없는 기존 새 폴더는 지우지 않고 .pre-migration-* 으로 옮기며, 이전 폴더는 항상 보존한다.
async function migrateLegacyStorage(dir, legacyId = LEGACY_ID) {
  const legacyDir = path.join(path.dirname(dir), legacyId), marker = path.join(dir, MARKER), lock = dir + '.migrate-lock', temp = dir + '.migrating-' + process.pid;
  if (path.basename(dir) === legacyId) return {status: 'same'};
  let source;
  try { source = await fs.readdir(legacyDir); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {status: 'none'}; throw error; }
  if (!source.length) return {status: 'none'};
  if (await exists(marker)) return {status: 'done'};
  if (!await acquire(lock)) {
    for (const start = Date.now(); Date.now() - start < WAIT_MS; await sleep(500)) if (await exists(marker)) return {status: 'done'};
    return {status: 'error', error: 'LOCK_TIMEOUT'};
  }
  try {
    if (await exists(marker)) return {status: 'done'};
    await fs.rm(temp, {recursive: true, force: true});
    await copyTree(legacyDir, temp);
    await fs.writeFile(path.join(temp, MARKER), new Date().toISOString() + '\n', {flag: 'wx'});
    let aside = null;
    if (await exists(dir) && (await fs.readdir(dir)).length) { aside = dir + '.pre-migration-' + Date.now(); await fs.rename(dir, aside); } else await fs.rm(dir, {recursive: true, force: true});
    await fs.rename(temp, dir);
    return {status: 'migrated', files: source.length, aside};
  } catch (error) {
    await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
    return {status: 'error', error: error.code || error.message};
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}
module.exports = {migrateLegacyStorage, LEGACY_ID, MARKER};
