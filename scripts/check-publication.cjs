'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const root = path.resolve(__dirname, '..'), run = promisify(execFile);
const directories = ['src', 'media', 'licenses', 'scripts', 'test', 'docs', '.github'];
const rootFiles = ['package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.vscodeignore', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'VALIDATION.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'SECURITY.md'];
const sensitiveName = /(^|\/)(?:\.env(?:\..*)?|auth\.json|credentials[^/]*|history\.jsonl|metadata\.json|session-index\.json|forecast-learning\.json|settings\.json|id_rsa|id_ed25519)$|\.(?:pem|key|jsonl|vsix|log|exe)$/i;
const secrets = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/, /\bsk-(?:proj-|ant-)[A-Za-z0-9_-]{40,}\b/];
const privateHome = /[A-Z]:[\\/]+Users[\\/]+[^\\/\s'"<>]+|\/(?:home|Users)\/(?!private(?:\/|\b)|fixture(?:\/|\b)|test(?:\/|\b))[^\/\s'"<>]+/i;
async function files(dir) {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, dir), {withFileTypes: true})) {
    const name = dir + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not publication inputs: ' + name);
    if (entry.isDirectory()) result.push(...await files(name)); else result.push(name);
  }
  return result;
}
(async () => {
  const inputs = [...rootFiles];
  for (const dir of directories) inputs.push(...await files(dir));
  const allowed = new Set(inputs);
  try {
    const result = await run('git', ['ls-files', '-z'], {cwd: root, windowsHide: true, maxBuffer: 2000000});
    for (const file of result.stdout.split('\0').filter(Boolean)) if (!allowed.has(file)) throw new Error('Unexpected tracked file: ' + file);
  } catch (error) {if (!/not a git repository/.test(error.stderr || '')) throw error;}
  for (const file of inputs) {
    if (sensitiveName.test(file)) throw new Error('Sensitive/generated publication file: ' + file);
    const bytes = await fs.readFile(path.join(root, file));
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Unexpected large source file: ' + file);
    const text = bytes.toString('utf8');
    if (secrets.some(pattern => pattern.test(text))) throw new Error('Potential credential in: ' + file);
    if (privateHome.test(text)) throw new Error('Personal home path in: ' + file);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  if (manifest.version !== lock.version || manifest.version !== lock.packages[''].version) throw new Error('Extension and lock versions differ');
  for (const [name, pkg] of Object.entries(lock.packages)) {
    const version = pkg.resolved?.match(/\/-\/[^/]+-(\d[^/]*)\.tgz$/)?.[1];
    if (version && pkg.version !== version) throw new Error('Lock version differs from resolved tarball: ' + name);
  }
  console.log(JSON.stringify({status: 'PASS', checkedSourceFiles: inputs.length, personalHistoryIncluded: false}));
})().catch(error => {console.error(error.message); process.exitCode = 1;});
