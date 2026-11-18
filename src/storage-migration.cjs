'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const LEGACY_ID = 'local-tools.usage-atlas';
const MARKER = '.migrated-from-' + LEGACY_ID;
// Marketplace 게시자 변경으로 globalStorage 폴더 이름(게시자.확장)이 바뀌므로, 새 폴더가 비어 있을 때 한 번만 이전 기록을 복사한다.
// 이전 폴더는 지우지 않고, 새 폴더에 이미 데이터가 있으면 합치지 않는다.
async function migrateLegacyStorage(dir, legacyId = LEGACY_ID) {
  const legacyDir = path.join(path.dirname(dir), legacyId);
  if (path.basename(dir) === legacyId) return {status: 'same'};
  let source;
  try { source = await fs.readdir(legacyDir); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {status: 'none'}; throw error; }
  if (!source.length) return {status: 'none'};
  await fs.mkdir(dir, {recursive: true});
  if ((await fs.readdir(dir)).length) return {status: 'skipped'};
  await fs.cp(legacyDir, dir, {recursive: true, force: false, dereference: false});
  await fs.writeFile(path.join(dir, MARKER), new Date().toISOString() + '\n', {flag: 'wx'});
  return {status: 'migrated', files: source.length};
}
module.exports = {migrateLegacyStorage, LEGACY_ID, MARKER};
