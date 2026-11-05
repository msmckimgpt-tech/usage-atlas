const fs = require('node:fs/promises');
const path = require('node:path');
const {build} = require('esbuild');
(async () => {
  const root = path.resolve(__dirname, '..');
  const version = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'd3', 'package.json'), 'utf8')).version;
  const result = await build({
    absWorkingDir: root
    , entryPoints: ['scripts/d3-entry.mjs']
    , outfile: 'media/d3.min.js'
    , bundle: true
    , minify: true
    , format: 'iife'
    , globalName: 'd3'
    , platform: 'browser'
    , target: 'es2022'
    , metafile: true
    , banner: {js: `// D3 ${version} subset. See D3-LICENSE and D3-NOTICES.`}
  });
  const packages = [...new Set(Object.keys(result.metafile.inputs).filter(p => p.startsWith('node_modules/')).map(p => p.split('/')[1]))].sort();
  const notices = [];
  for (const name of packages) notices.push(`${name}\n${await fs.readFile(path.join(root, 'node_modules', name, 'LICENSE'), 'utf8')}`);
  await fs.writeFile(path.join(root, 'media', 'D3-NOTICES'), notices.join('\n\n'));
  console.log(`D3 subset: ${(await fs.stat(path.join(root, 'media', 'd3.min.js'))).size} bytes, ${packages.length} package notices.`);
})().catch(e => {console.error(e); process.exitCode = 1;});
