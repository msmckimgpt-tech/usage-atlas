'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const manifest = require('../package.json');
async function verify(dir, expected = manifest) {
  const filename = expected.name + '-' + expected.version + '.vsix';
  const checksum = (await fs.readFile(path.join(dir, filename + '.sha256'), 'utf8')).trim();
  const bytes = await fs.readFile(path.join(dir, filename));
  const actual = crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + filename;
  if (checksum !== actual) throw new Error('VSIX checksum does not match');
  const required = new Set(['package.json', 'readme.md', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.md', 'licenses/Codexon-LICENSE.txt', 'media/D3-LICENSE', 'media/D3-NOTICES', 'src/extension.cjs', 'bin/collector-host.exe']);
  const allowed = /^(?:package\.json|readme\.md|changelog\.md|LICENSE\.txt|THIRD-PARTY-NOTICES\.md|VALIDATION\.md|PRIVACY\.md|licenses\/Codexon-LICENSE\.txt|src\/(?:[a-z0-9-]+\.(?:cjs|json)|windows\/CollectorHost\.cs)|media\/[a-zA-Z0-9.-]+|bin\/collector-host\.exe)$/;
  const entries = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, {lazyEntries: true}, (error, zip) => {
    if (error) return reject(error);
    const values = new Map();
    const fail = error => {zip.close(); reject(error);};
    zip.on('error', reject); zip.on('end', () => resolve(values));
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) {zip.readEntry(); return;}
      if (!entry.fileName.startsWith('extension/')) {
        if (!['[Content_Types].xml', 'extension.vsixmanifest'].includes(entry.fileName)) return fail(new Error('Unexpected ZIP entry'));
        zip.readEntry(); return;
      }
      const relative = entry.fileName.slice('extension/'.length);
      if (!allowed.test(relative) || /(?:^|\/)\.\.(?:\/|$)/.test(relative) || values.has(relative) || entry.uncompressedSize > 2 * 1024 * 1024) return fail(new Error('Unexpected VSIX payload: ' + relative));
      zip.openReadStream(entry, (error, stream) => {
        if (error) return fail(error);
        const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', fail);
        stream.on('end', () => {values.set(relative, Buffer.concat(chunks)); zip.readEntry();});
      });
    }); zip.readEntry();
  }));
  for (const file of required) if (!entries.has(file)) throw new Error('Required artifact file missing: ' + file);
  const embedded = JSON.parse(entries.get('package.json'));
  if (embedded.name !== expected.name || embedded.version !== expected.version || embedded.publisher !== expected.publisher) throw new Error('Artifact identity/version does not match checked-out source');
  const host = entries.get('bin/collector-host.exe');
  if (host[0] !== 0x4d || host[1] !== 0x5a) throw new Error('Windows collector is not a PE executable');
  return {filename, sha256: actual.slice(0, 64), verifiedFiles: entries.size};
}
if (require.main === module) verify(path.resolve(process.argv[2] || '.')).then(result => console.log(JSON.stringify(result))).catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {verify};
