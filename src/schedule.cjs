'use strict';
// Adaptive collection adapted from https://github.com/jisoq/Codexon; Copyright (c) 2026 jisoq.
// See licenses/Codexon-LICENSE.txt. Usage Atlas preserves user intervals and server backoff.
function intervalSeconds(value) {return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(3600, value)) : 300;}
function wakeDelay(collectors, now = Date.now(), enabled = true) {
  if (!enabled) return 60000;
  const next = Math.min(...['codex', 'claude'].map(id => collectors[id]?.next || now));
  return Math.max(25, Math.min(60000, next - now));
}
function retime(collectors, interval) {
  let changed = false;
  for (const c of Object.values(collectors)) if (Number.isFinite(c.last) && !c.errors && c.message === '정상') {
    const next = c.last + intervalSeconds(interval) * 1000;
    if (c.next !== next) {c.next = next; changed = true;}
  }
  return changed;
}
function adaptiveInterval(base, {active = true, lastActivity, idleMultiplier = 4, idleAfterMs = 60000} = {}, now = Date.now(), multiplier = idleMultiplier) {
  const seconds = intervalSeconds(base);
  const recent = Number.isFinite(lastActivity) && now - lastActivity < Math.max(0, idleAfterMs);
  if (active || recent) return seconds;
  const factor = Number.isFinite(multiplier) ? Math.max(1, Math.min(60, multiplier)) : 4;
  return Math.max(60, seconds, seconds * factor);
}
function advanceOnWake(collectors, now = Date.now(), minimumFetchSeconds = 5) {
  let changed = false;
  const minimum = Math.max(5, Number.isFinite(minimumFetchSeconds) ? minimumFetchSeconds : 5) * 1000;
  for (const c of Object.values(collectors)) {
    if (c.errors || Number.isFinite(c.retryAfter) && c.retryAfter > now || Number.isFinite(c.backoffUntil) && c.backoffUntil > now) continue;
    const next = Math.max(now, Number.isFinite(c.last) ? c.last + minimum : now);
    if (!Number.isFinite(c.next) || c.next > next) {c.next = next; changed = true;}
  }
  return changed;
}
module.exports = {intervalSeconds, wakeDelay, retime, adaptiveInterval, advanceOnWake};
