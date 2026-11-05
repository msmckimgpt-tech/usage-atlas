'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
(async () => {
  let count = 0;
  async function scan(dir) {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (/\.(?:js|cjs)$/.test(entry.name)) {new vm.Script(await fs.readFile(file, 'utf8'), {filename: file}); count++;}
    }
  }
  await scan(path.join(root, 'src')); await scan(path.join(root, 'media'));
  console.log(JSON.stringify({status: 'PASS', syntaxFiles: count}));
})().catch(error => {console.error(error); process.exitCode = 1;});
