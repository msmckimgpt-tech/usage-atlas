'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const LEGACY_ID = 'local-tools.usage-atlas';
const MARKER = '.migrated-from-' + LEGACY_ID;
const skipped = new Set(['-shm']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transient = error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
async function copyFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.copyFile(from, to); return; } catch (error) { if (!transient(error) || attempt >= 4) throw error; await sleep(250 * (attempt + 1)); }
  }
}
async function copyTree(from, to) {
  await fs.mkdir(to, {recursive: true});
  for (const entry of await fs.readdir(from, {withFileTypes: true})) {
    if (entry.isSymbolicLink()) continue;
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (![...skipped].some(suffix => entry.name.endsWith(suffix))) await copyFile(source, target);
  }
}
// Marketplace 게시자 변경으로 globalStorage 폴더 이름(게시자.확장)이 바뀌므로 이전 기록을 한 번 복사한다.
// 임시 폴더에 전부 복사한 뒤 마커와 함께 교체하므로 중간에 실패해도 반쪽짜리 폴더가 남지 않는다.
// 마커가 없는 기존 새 폴더는 지우지 않고 .pre-migration-* 으로 옮기며, 이전 폴더는 항상 보존한다.
async function migrateLegacyStorage(dir, legacyId = LEGACY_ID) {
  const legacyDir = path.join(path.dirname(dir), legacyId), temp = dir + '.migrating';
  if (path.basename(dir) === legacyId) return {status: 'same'};
  let source;
  try { source = await fs.readdir(legacyDir); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {status: 'none'}; throw error; }
  if (!source.length) return {status: 'none'};
  try { await fs.stat(path.join(dir, MARKER)); return {status: 'done'}; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rm(temp, {recursive: true, force: true});
  try {
    await copyTree(legacyDir, temp);
    await fs.writeFile(path.join(temp, MARKER), new Date().toISOString() + '\n', {flag: 'wx'});
    let aside = null;
    try {
      if ((await fs.readdir(dir)).length) { aside = dir + '.pre-migration-' + Date.now(); await fs.rename(dir, aside); } else await fs.rmdir(dir);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temp, dir);
    return {status: 'migrated', files: source.length, aside};
  } catch (error) {
    await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
    return {status: 'error', error: error.code || error.message};
  }
}
module.exports = {migrateLegacyStorage, LEGACY_ID, MARKER};
