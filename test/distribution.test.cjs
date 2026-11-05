'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {ZipFile} = require('yazl');
const {verify} = require('../scripts/verify-artifact.cjs');
const manifest = require('../package.json');
async function fixture(t, {extra, identity = manifest, omit} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-atlas-distribution-'));
  t.after(async () => {assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('usage-atlas-distribution-')); await fs.rm(dir, {recursive: true, force: true});});
  const zip = new ZipFile(), entries = {'package.json': JSON.stringify(identity), 'readme.md': 'synthetic', 'LICENSE.txt': 'MIT', 'THIRD-PARTY-NOTICES.md': 'jisoq', 'licenses/Codexon-LICENSE.txt': 'jisoq', 'media/D3-LICENSE': 'ISC', 'media/D3-NOTICES': 'synthetic', 'src/extension.cjs': 'synthetic', 'bin/collector-host.exe': 'MZ synthetic fixture'};
  if (extra) entries[extra] = 'not publishable';
  for (const [name, text] of Object.entries(entries)) if (name !== omit) zip.addBuffer(Buffer.from(text), 'extension/' + name);
  const data = new Promise((resolve, reject) => {const chunks = [];zip.outputStream.on('data', c => chunks.push(c));zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));zip.outputStream.on('error', reject);});
  zip.end(); const bytes = await data, filename = manifest.name + '-' + manifest.version + '.vsix';
  await fs.writeFile(path.join(dir, filename), bytes); await fs.writeFile(path.join(dir, filename + '.sha256'), crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + filename + '\n');
  return {dir, filename};
}
test('distribution verifier accepts expected identity and required license/runtime payload', async t => {const {dir} = await fixture(t);assert.equal((await verify(dir)).verifiedFiles, 9);});
test('distribution verifier rejects modified downloads even with the same filename', async t => {const {dir, filename} = await fixture(t);await fs.appendFile(path.join(dir, filename), 'changed');await assert.rejects(verify(dir), /checksum/);});
test('distribution verifier rejects raw history hidden in an otherwise checksummed package', async t => {const {dir} = await fixture(t, {extra: 'history.jsonl'});await assert.rejects(verify(dir), /Unexpected VSIX payload/);});
test('distribution verifier rejects a package for another publisher and missing attribution', async t => {const wrong = await fixture(t, {identity: {...manifest, publisher: 'another-publisher'}});await assert.rejects(verify(wrong.dir), /identity/);const missing = await fixture(t, {omit: 'licenses/Codexon-LICENSE.txt'});await assert.rejects(verify(missing.dir), /Required artifact file/);});
