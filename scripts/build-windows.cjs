'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
(async () => {
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'bin', 'collector-host.exe');
  if (process.platform !== 'win32') {await fs.access(output); return;}
  await fs.mkdir(path.dirname(output), {recursive: true});
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu', '/out:' + output, path.join(root, 'src', 'windows', 'CollectorHost.cs')], {windowsHide: true});
  console.log('Built Windows background collector host.');
})().catch(error => {console.error(error.message); process.exitCode = 1;});
