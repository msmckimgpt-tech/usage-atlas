'use strict';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const catalog = require('./billing-catalog.json');
function monthlyPrice(provider, plan, rates = catalog) {
  const entry = rates.providers?.[provider];
  const monthlyUsd = entry && Object.hasOwn(entry.plans, plan) ? entry.plans[plan] : null;
  return finite(monthlyUsd) && monthlyUsd > 0 ? {monthlyUsd, usdPerCredit: entry.usdPerCredit, verifiedAt: rates.verifiedAt || rates.version} : null;
}
function enricher(rates = catalog) {
  return (provider, records, _windows, ledger) => {
    let usage = 0, total = 0, usageKnown = true, totalKnown = true, previous, segment = 0;
    for (let i = 0; i < records.length; i++) {
      const row = records[i], point = ledger[i], credit = point.credit, profile = monthlyPrice(provider, row.plan, rates);
      const key = profile ? JSON.stringify(profile) : null, changed = i > 0 && previous !== key; previous = key;
      if (changed) segment++;
      const unitUsd = provider === 'claude' ? 1 : profile?.usdPerCredit;
      const deltaUsd = point.delta === 0 || i === 0 ? 0 : finite(point.delta) && finite(unitUsd) ? point.delta * unitUsd : null;
      const delta = finite(deltaUsd) && profile ? deltaUsd / profile.monthlyUsd * 100 : null;
      if (i && point.delta > 0) {if (finite(deltaUsd)) total += deltaUsd; else totalKnown = false;}
      if (credit.cycleStart) {usage = 0; usageKnown = true;} else if (point.delta > 0) {if (finite(deltaUsd)) usage += deltaUsd; else usageKnown = false;}
      point.billing = {
          usage: profile && finite(credit.usage) && usageKnown ? usage / profile.monthlyUsd * 100 : null
        , delta: profile && finite(credit.delta) ? delta : null
        , total: profile && finite(credit.total) && totalKnown ? total / profile.monthlyUsd * 100 : null
        , usageContinuous: credit.usageContinuous && usageKnown && !changed
        , deltaContinuous: credit.deltaContinuous && finite(delta) && !changed
        , totalContinuous: credit.totalContinuous && totalKnown && !changed
        , segment, monthlyUsd: profile?.monthlyUsd ?? null, usdPerCredit: profile?.usdPerCredit ?? null, priceVerifiedAt: profile?.verifiedAt ?? null
      };
    }
  };
}
module.exports = {monthlyPrice, enricher, catalog};
