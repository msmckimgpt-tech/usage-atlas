'use strict';
const manifest = require('../package.json');
const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || process.argv[2];
if (tag !== 'v' + manifest.version || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Tag must match the package version: v' + manifest.version);
if (process.argv.includes('--marketplace') && (!process.env.MARKETPLACE_PUBLISHER || process.env.MARKETPLACE_PUBLISHER !== manifest.publisher)) throw new Error('Confirm Marketplace publisher ownership and match MARKETPLACE_PUBLISHER to package.json');
console.log('Verified release tag: ' + tag);
