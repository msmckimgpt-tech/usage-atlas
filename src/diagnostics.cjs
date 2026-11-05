'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const validProvider = value => ['codex', 'claude', 'shared'].includes(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round = value => Math.round(value * 1000) / 1000;
class Diagnostics {
  constructor(dir, enabled = true) {this.file = path.join(dir, 'diagnostics.json'); this.enabled = enabled; this.events = []; this.lastSave = 0; this.revision = 0;}
  setEnabled(value) {this.enabled = Boolean(value);}
  async measure(provider, stage, operation) {
    if (!this.enabled) return operation();
    const started = performance.now(), cpu = process.cpuUsage();
    let outcome = 'success';
    try {return await operation();}
    catch (error) {outcome = 'failed'; throw error;}
    finally {
      if (this.enabled) {
        const used = process.cpuUsage(cpu), memory = process.memoryUsage();
        this.events.push({time: Date.now(), provider: validProvider(provider) ? provider : 'shared', stage: String(stage).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32), elapsedMs: round(performance.now() - started), cpuMs: round((used.user + used.system) / 1000), rssMiB: round(memory.rss / 1048576), heapMiB: round(memory.heapUsed / 1048576), outcome});
        this.events = this.events.slice(-192); this.revision++;
      }
    }
  }
  async load() {
    if (!this.enabled) return;
    try {
      const stat = await fs.stat(this.file); if (stat.size > 256 * 1024) return;
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const known = new Set(this.events.map(e => `${e.time}/${e.provider}/${e.stage}`));
      for (const event of Array.isArray(value.events) ? value.events.slice(-192) : []) {
        if (!validProvider(event.provider) || !/^[a-zA-Z0-9_-]{1,32}$/.test(event.stage) || !['success', 'failed'].includes(event.outcome) || !['time', 'elapsedMs', 'cpuMs', 'rssMiB', 'heapMiB'].every(k => finite(event[k]))) continue;
        const key = `${event.time}/${event.provider}/${event.stage}`;
        if (!known.has(key)) {known.add(key); this.events.push(Object.fromEntries(['time', 'provider', 'stage', 'elapsedMs', 'cpuMs', 'rssMiB', 'heapMiB', 'outcome'].map(k => [k, event[k]])));}
      }
      this.events.sort((a, b) => a.time - b.time); this.events = this.events.slice(-192);
    } catch {}
  }
  snapshot(provider) {
    if (!this.enabled) return {enabled: false};
    const events = this.events.filter(e => e.provider === provider || e.provider === 'shared').slice(-48);
    const reads = events.filter(e => e.stage === 'query'), ordered = reads.map(e => e.elapsedMs).sort((a, b) => a - b);
    return {
        enabled: true
      , scope: 'extension-host-process'
      , note: 'CPU·메모리는 확장 호스트 전체이며 다른 확장과 동시 작업을 포함합니다. Codex 자식 프로세스는 포함하지 않습니다.'
      , summary: {samples: reads.length, lastMs: reads.at(-1)?.elapsedMs ?? null, meanMs: reads.length ? round(reads.reduce((sum, e) => sum + e.elapsedMs, 0) / reads.length) : null, p95Ms: ordered.length ? ordered[Math.max(0, Math.ceil(ordered.length * .95) - 1)] : null, cpuMs: reads.at(-1)?.cpuMs ?? null, rssMiB: events.at(-1)?.rssMiB ?? null, heapMiB: events.at(-1)?.heapMiB ?? null}
      , events
    };
  }
  async save(force = false) {
    if (!this.enabled || !this.events.length || !force && Date.now() - this.lastSave < 60000) return;
    await fs.mkdir(path.dirname(this.file), {recursive: true});
    const temporary = this.file + `.${process.pid}.tmp`;
    try {await fs.writeFile(temporary, JSON.stringify({version: 1, events: this.events}), {mode: 0o600}); await fs.rename(temporary, this.file); this.lastSave = Date.now();}
    finally {await fs.unlink(temporary).catch(() => {});}
  }
}
module.exports = {Diagnostics};
