'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function main() {
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const result = {version, status: 'RUNNING', steps: [], fixturesOnly: true};
  await fs.mkdir(path.join(root, 'screenshots'), {recursive: true});
  const checks = [
      ['publication', ['scripts/check-publication.cjs']]
    , ['syntax', ['test/check-syntax.cjs']]
    , ['units', ['--test', ...(await fs.readdir(path.join(root, 'test'))).filter(file => file.endsWith('.test.cjs')).map(file => 'test/' + file)]]
    , ...['ui', 'credit-conversion-ui', 'credit-gap-ui', 'credit-basis-ui', 'preview-parity-ui', 'forecast-ui', 'time-axis-ui', 'page-size-ui', 'history-range-ui', 'amount-format-ui', 'details-ui'].map(file => [file, ['test/' + file + '.cjs']])
    , ...(process.platform === 'win32' ? [['vscode-native', ['test/launch-analysis-host.cjs']]] : [])
  ];
  const receipt = path.join(root, 'test-release-regression-' + version + '.json');
  try {
    for (const [name, args] of checks) {
      const started = Date.now(), log = path.join(root, 'test-release-' + version + '-' + name + '.log');
      const output = await fs.open(log, 'w');
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, args, {cwd: root, windowsHide: true, stdio: ['ignore', output.fd, output.fd]});
          child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? -1 : code));
        });
      } finally {await output.close();}
      result.steps.push({name, code, elapsedMs: Date.now() - started, log: path.basename(log)});
      console.log(name + ': ' + (code === 0 ? 'PASS' : 'FAIL'));
      if (code !== 0) {console.error((await fs.readFile(log, 'utf8')).slice(-5000)); throw new Error('Release regression failed: ' + name);}
    }
    result.status = 'PASS';
  } catch (error) {result.status = 'FAIL'; result.error = error.message; throw error;} finally {await fs.writeFile(receipt, JSON.stringify(result, null, 2));}
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
