'use strict';
const {hash, series} = require('../src/core.cjs');
const hour = 3600000;
function records(anchor = Date.parse('2026-09-21T11:00:00+09:00'), provider = 'codex', resetHours = 5) {
  const result = [], rates = [10, 0, 20, 0, 20];
  for (const weeks of [2, 1]) {
    const start = anchor - weeks * 7 * 24 * hour - hour;
    let used = 0;
    for (let i = 0; i <= 10; i++) {
      if (i) used += rates[Math.floor((i - 1) / 2)] / 2;
      const time = start + i * hour / 2, reset = start + 6 * hour;
      result.push({v: 1, provider, account: hash('pattern-' + provider), plan: 'pattern', time, windows: {five: {used, reset}, week: {used, reset}}});
    }
  }
  for (let i = 0; i <= 2; i++) {
    const time = anchor - hour + i * hour / 2, reset = anchor + resetHours * hour, used = 30 + i * 10;
    result.push({v: 1, provider, account: hash('pattern-' + provider), plan: 'pattern', time, windows: {five: {used, reset}, week: {used, reset}}});
  }
  return result;
}
function points(anchor, provider = 'codex', resetHours) {return series(records(anchor, provider, resetHours), provider, 'five');}
module.exports = {records, points};
