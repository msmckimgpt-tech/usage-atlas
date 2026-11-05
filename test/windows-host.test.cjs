'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile), root = path.resolve(__dirname, '..');
test('Windows collector and descendants inherit a hidden console; argument quoting is lossless', {skip: process.platform !== 'win32'}, async t => {
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), probe = path.join(__dirname, '.windows-probe.exe');
  t.after(() => fs.rm(probe, {force: true, maxRetries: 3, retryDelay: 100}));
  await run(compiler, ['/nologo', '/target:exe', '/r:System.Web.Extensions.dll', '/out:' + probe, path.join(__dirname, 'WindowsProbe.cs')], {windowsHide: true});
  const args = ['space value', '한글', 'a"b', 'last\\'];
  const result = JSON.parse((await run(path.join(root, 'bin/collector-host.exe'), [probe, ...args], {windowsHide: true})).stdout);
  assert.equal(result.visible, false); assert.notEqual(result.console, 0); assert.equal(result.child.visible, false); assert.equal(result.child.console, result.console); assert.deepEqual(result.args, args);
  const searched = JSON.parse((await run(path.join(root, 'bin/collector-host.exe'), [path.basename(probe)], {windowsHide: true, env: {...process.env, PATH: __dirname + path.delimiter + process.env.PATH}})).stdout);
  assert.equal(searched.visible, false, 'bare executable names resolve from the supplied PATH');
  const child = spawn(path.join(root, 'bin/collector-host.exe'), [probe, 'hold'], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  let info;
  try {
    info = await new Promise((resolve, reject) => {let text = ''; const timer = setTimeout(() => reject(new Error('probe timeout')), 5000); child.once('error', reject); child.stdout.on('data', chunk => {text += chunk; if (text.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(text));}});});
  } finally {child.kill();}
  const deadline = Date.now() + 3000;
  let alive;
  do {alive = [info.pid, info.child].filter(pid => {try {process.kill(pid, 0); return true;} catch {return false;}}); if (alive.length) await new Promise(resolve => setTimeout(resolve, 25));} while (alive.length && Date.now() < deadline);
  assert.deepEqual(alive, [], 'killing the owned launcher cleans up its collector and command tree');
});
