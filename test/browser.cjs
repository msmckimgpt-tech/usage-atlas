'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const edge = process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe') : null;
const executablePath = process.env.USAGE_ATLAS_BROWSER || (edge && fs.existsSync(edge) ? edge : undefined);
module.exports = {chromium, browserOptions: {headless: true, ...(executablePath ? {executablePath} : {})}};
