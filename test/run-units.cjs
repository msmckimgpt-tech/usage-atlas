'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
(async () => {
  if (process.platform === 'win32') await new Promise((resolve, reject) => {const build = spawn(process.execPath, ['scripts/build-windows.cjs'], {cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'inherit'});build.once('error', reject);build.once('exit', code => code === 0 ? resolve() : reject(new Error('Windows host build failed')));});
  const files = (await fs.readdir(__dirname)).filter(file => file.endsWith('.test.cjs')).sort().map(file => path.join(__dirname, file));
  const child = spawn(process.execPath, ['--test', ...files], {cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'inherit'});
  child.once('error', error => {console.error(error.message); process.exitCode = 1;});
  child.once('exit', code => {process.exitCode = code ?? 1;});
})().catch(error => {console.error(error); process.exitCode = 1;});
