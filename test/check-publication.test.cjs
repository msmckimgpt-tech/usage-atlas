'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'check-publication.cjs');

// 배포 저장소와 같은 모양의 최소 저장소를 만들어 검사 스크립트를 그 안에서 실행한다.
async function fixture(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ua-publication-'));
  const write = async (name, text) => {
    await fs.mkdir(path.dirname(path.join(dir, name)), {recursive: true});
    await fs.writeFile(path.join(dir, name), text);
  };
  await write('scripts/check-publication.cjs', await fs.readFile(script));
  await write('package.json', JSON.stringify({name: 'fixture', version: '1.0.0'}));
  await write('package-lock.json', JSON.stringify({version: '1.0.0', packages: {'': {version: '1.0.0'}}}));
  await write('src/extension.cjs', "'use strict';\n");
  await write('.vscodeignore', '**\n!package.json\n!README.md\n!src/**\n!media/**\n');
  for (const name of ['.gitignore', '.gitattributes', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'VALIDATION.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'SECURITY.md']) await write(name, 'fixture\n');
  for (const dirName of ['media', 'licenses', 'test', 'docs', '.github']) await fs.mkdir(path.join(dir, dirName), {recursive: true});
  for (const [name, text] of Object.entries(extra)) await write(name, text);
  execFileSync('git', ['init', '-q'], {cwd: dir});
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-A'], {cwd: dir});
  return dir;
}
const check = dir => spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-publication.cjs')], {cwd: dir, encoding: 'utf8'});

test('deploy-only agent guides are allowed tracked files', async () => {
  const dir = await fixture({'AGENTS.md': '# 배포 지침\n', 'CLAUDE.md': '참조\n', 'GEMINI.md': '참조\n', '.agent/skills/review-panel/SKILL.md': '# skill\n'});
  try {
    const result = check(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"PASS"/);
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});

test('other unexpected tracked files are still rejected', async () => {
  const dir = await fixture({'AGENTS.md': '# 배포 지침\n', 'notes/todo.md': 'x\n'});
  try {
    const result = check(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected tracked file: notes\/todo\.md/);
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});

test('agent guides still get the personal path and secret scan', async () => {
  const home = 'C:' + '\\Users\\' + 'someone\\project';
  const dir = await fixture({'.agent/skills/x/SKILL.md': 'path ' + home + '\n'});
  try {
    const result = check(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Personal home path in: \.agent\/skills\/x\/SKILL\.md/);
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});

test('without agent guides the check passes as before', async () => {
  const dir = await fixture();
  try {assert.equal(check(dir).status, 0);} finally {await fs.rm(dir, {recursive: true, force: true});}
});

test('root guide files get the credential scan', async () => {
  const dir = await fixture({'AGENTS.md': 'token ' + 'ghp_' + 'a'.repeat(36) + '\n'});
  try {
    const result = check(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Potential credential in: AGENTS\.md/);
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});

test('only markdown and plugin.json are accepted under .agent', async () => {
  for (const name of ['.agent/run.sh', '.agent/settings.json']) {
    const dir = await fixture({[name]: 'echo\n'});
    try {
      const result = check(dir);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /Unexpected agent guide file/);
    } finally {await fs.rm(dir, {recursive: true, force: true});}
  }
});

test('.vscodeignore must not re-include agent guides', async () => {
  for (const extra of ['!**/*.md', '!AGENTS.md', '!.agent/**']) {
    const dir = await fixture({'.vscodeignore': '**\n!package.json\n' + extra + '\n'});
    try {
      const result = check(dir);
      assert.notEqual(result.status, 0, extra);
      assert.match(result.stderr, /\.vscodeignore would package agent guides/);
    } finally {await fs.rm(dir, {recursive: true, force: true});}
  }
});

test('a symlinked guide directory is rejected', async t => {
  const dir = await fixture();
  try {
    const target = path.join(dir, 'docs', 'guide');
    await fs.mkdir(target, {recursive: true});
    try {await fs.symlink(target, path.join(dir, '.agent'), 'junction');} catch (error) {return t.skip('symlink not permitted: ' + error.code);}
    const result = check(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Symbolic links are not publication inputs: \.agent/);
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});
