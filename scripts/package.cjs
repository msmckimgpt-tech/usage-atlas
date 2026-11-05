'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function node(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: root, windowsHide: true, stdio: 'inherit'});
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Build stage failed: ' + args[0])));
  });
}
(async () => {
  await node(['scripts/build-webview.cjs']);
  await node(['scripts/build-windows.cjs']);
  await node(['test/release-regression.cjs']);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const vsce = require('@vscode/vsce/package.json');
  const file = manifest.name + '-' + manifest.version + '.vsix';
  await node([path.resolve(path.dirname(require.resolve('@vscode/vsce/package.json')), vsce.bin.vsce), 'package', '--no-dependencies', '--out', file]);
  const sha = crypto.createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
  await fs.writeFile(path.join(root, file + '.sha256'), sha + '  ' + file + '\n');
  await node(['scripts/verify-artifact.cjs', root]);
  console.log('SHA256: ' + sha);
})().catch(error => {console.error(error.message); process.exitCode = 1;});
