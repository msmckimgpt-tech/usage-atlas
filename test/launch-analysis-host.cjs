'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {runTests} = require('@vscode/test-electron');
const root = path.resolve(__dirname, '..');
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
(async () => {
  const user = await fs.mkdtemp(path.join(root, '.test-analysis-user-'));
  for (const name of ['.test-analysis-extensions', '.test-analysis-workspace']) await fs.mkdir(path.join(root, name), {recursive: true});
  await fs.mkdir(path.join(user, 'User'), {recursive: true});
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({'usageAtlas.enabled': false, 'usageAtlas.intervalSeconds': 60, 'usageAtlas.analysisEnabled': true, 'usageAtlas.diagnosticsEnabled': true, 'extensions.autoUpdate': false, 'update.mode': 'none', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false}));
  const debugPort = String(await port());
  const env = {...process.env, CODEX_HOME: path.join(root, '.test-analysis-input/codex'), CLAUDE_CONFIG_DIR: path.join(root, '.test-analysis-input/claude'), USAGE_ATLAS_TEST_DEBUG_PORT: debugPort};
  env.VSCODE_PORTABLE = path.join(user, 'portable');
  await fs.mkdir(path.join(env.VSCODE_PORTABLE, 'user-data', 'User'), {recursive: true});
  await fs.copyFile(path.join(user, 'User/settings.json'), path.join(env.VSCODE_PORTABLE, 'user-data', 'User/settings.json'));
  env.ELECTRON_RUN_AS_NODE = undefined; env.VSCODE_IPC_HOOK_CLI = undefined;
  const installed = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe') : null;
  const executable = process.env.USAGE_ATLAS_VSCODE_PATH || (installed && await fs.access(installed).then(() => true, () => false) ? installed : undefined);
  const code = await runTests({
      version: process.env.USAGE_ATLAS_VSCODE_VERSION || 'stable'
    , ...(executable ? {vscodeExecutablePath: executable} : {})
    , extensionDevelopmentPath: root
    , extensionTestsPath: path.join(__dirname, 'analysis-host.cjs')
    , extensionTestsEnv: env
    , launchArgs: ['--new-window', '--user-data-dir', user, '--extensions-dir', path.join(root, '.test-analysis-extensions'), '--remote-debugging-port=' + debugPort, '--disable-workspace-trust', '--disable-updates', path.join(root, '.test-analysis-workspace')]
  });
  process.exitCode = code ?? 0;
})().catch(error => {console.error(error); process.exitCode = 1;});
