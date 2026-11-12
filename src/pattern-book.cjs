'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('../media/provider-visibility.js');
const quarter = 900000, day = 86400000, maxBytes = 8 * 1024 * 1024, maxCells = 150000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const emptyCapacityKey = digest([]);
const reset = point => ['scheduled-reset', 'early-reset'].includes(point.event?.kind);
function summarize(points) {
  const cells = new Map(); let peak = points[0]?.value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dt = b.time - a.time, changed = reset(b) || a.plan !== b.plan || a.mult !== b.mult;
    const recovering = !changed && (finite(a.value) && a.value < peak || finite(b.value) && b.value < peak);
    if (changed) peak = b.value; else if (finite(b.value)) peak = finite(peak) ? Math.max(peak, b.value) : b.value;
    if (!b.continuous || !finite(a.value) || a.value >= 100 || !finite(b.delta) || b.delta < 0 || b.estimatedDelta || b.recoveryExcluded > 0 || recovering || changed || dt <= 0) continue;
    let time = a.time;
    while (time < b.time) {
      const key = Math.floor(time / quarter), end = Math.min((key + 1) * quarter, b.time), ms = end - time;
      const scope = JSON.stringify([a.plan, a.mult]), id = key + '/' + scope, cycle = Math.floor(a.reset / 60000);
      const cell = cells.get(id) || {key, plan: a.plan, mult: a.mult, ms: 0, consumed: 0, cycle, conflict: false};
      cell.conflict ||= cell.cycle !== cycle; cell.ms += ms; cell.consumed += b.delta * ms / dt;
      cells.set(id, cell); time = end;
    }
  }
  return [...cells.values()].filter(cell => !cell.conflict && cell.ms <= quarter + 1);
}
class PatternBook {
  constructor(dir) {this.file = path.join(dir, 'forecast-patterns.json'); this.scopes = new Map(); this.anchors = new Map(); this.revision = 0; this.dirty = false; this.capacityKey = null;}
  clear() {this.scopes.clear(); this.anchors.clear(); this.dirty = true; this.revision++;}
  configure(capacities, retentionDays = 90, epoch = null) {
    this.capacityScopes = new Map();
    for (const value of capacities) {const id = JSON.stringify([value.provider, value.account, value.plan, value.window]); const list = this.capacityScopes.get(id) || []; list.push(value); this.capacityScopes.set(id, list);}
    for (const [id, values] of this.capacityScopes) this.capacityScopes.set(id, digest(values));
    const key = digest([capacities, epoch]), retention = Math.min(365, Math.max(7, retentionDays || 90));
    if (retention !== this.retentionDays) {this.retentionDays = retention; this.trim(); this.dirty = true; this.revision++;}
    if (this.capacityKey !== null && this.capacityKey !== key) {
      if ((this.epoch ?? null) !== epoch) this.clear();
      else {for (const [id, group] of this.scopes) if (group.scope.capKey !== this.capKey(group.scope)) this.scopes.delete(id); this.anchors.clear(); this.dirty = true; this.revision++;}
    }
    this.epoch = epoch; this.capacityKey = key;
  }
  capKey(scope) {return this.capacityScopes?.get(JSON.stringify([scope.provider, scope.account, scope.plan, scope.window])) || emptyCapacityKey;}
  async load() {
    try {
      const stat = await fs.stat(this.file), stamp = [stat.ino, stat.size, stat.mtimeMs].join('/');
      if (stamp === this.stamp) return;
      if (stat.size > maxBytes) throw new Error('size');
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || !/^[a-f\d]{64}$/.test(data.capacityKey) || !Array.isArray(data.scopes) || data.scopes.length > 4096 || !Array.isArray(data.cells) || data.cells.length > maxCells) throw new Error('format');
      const scopes = new Map(), keys = [];
      for (const scope of data.scopes) {
        if (!scope || !catalog.valid(scope.provider) || !['five', 'week'].includes(scope.window) || !/^[a-f\d]{20}$/.test(scope.account) || !/^[a-f\d]{64}$/.test(scope.capKey || '') || typeof scope.plan !== 'string' || scope.plan.length > 100 || scope.mult !== null && (!finite(scope.mult) || scope.mult <= 0)) throw new Error('scope');
        const key = JSON.stringify(scope); if (scopes.has(key)) throw new Error('duplicate'); keys.push(key); scopes.set(key, {scope, cells: new Map()});
      }
      for (const row of data.cells) {
        if (!Array.isArray(row) || row.length !== 5 || !Number.isInteger(row[0]) || row[0] < 0 || !Number.isInteger(row[1]) || !keys[row[1]] || !finite(row[2]) || row[2] <= 0 || row[2] > quarter + 1 || !finite(row[3]) || row[3] < 0 || row[3] > 100 || !Number.isInteger(row[4])) throw new Error('cell');
        const group = scopes.get(keys[row[1]]); if (group.cells.has(row[0])) throw new Error('duplicate-cell'); group.cells.set(row[0], {key: row[0], ms: row[2], consumed: row[3], cycle: row[4]});
      }
      if (this.dirty && this.capacityKey === data.capacityKey) {
        for (const [key, group] of scopes) {const local = this.scopes.get(key); if (!local) this.scopes.set(key, group); else for (const [time, cell] of group.cells) if (!local.cells.has(time)) local.cells.set(time, cell);}
      } else if (!this.dirty) {this.scopes = scopes; this.capacityKey = data.capacityKey; this.epoch = data.epoch ?? null; this.anchors.clear();}
      this.stamp = stamp; this.revision++;
    } catch (error) {if (error.code !== 'ENOENT') this.recovered = true;}
  }
  update(provider, records, windows, since = null) {
    if (!records.length) return;
    const last = records.at(-1);
    if ([...this.scopes.values()].some(group => group.scope.provider === provider && group.scope.account !== last.account)) {for (const [key, group] of this.scopes) if (group.scope.provider === provider) this.scopes.delete(key); for (const key of this.anchors.keys()) if (key.startsWith(provider + '/')) this.anchors.delete(key); this.dirty = true; this.revision++;}
    if (finite(since)) for (const group of this.scopes.values()) if (group.scope.provider === provider && group.scope.account === last.account) for (const key of group.cells.keys()) if (key * quarter <= since) {group.cells.delete(key); this.dirty = true; this.revision++;}
    const anchorKey = provider + '/' + last.account, signature = digest([records.length, records[0].time, last.time, last.plan, last.windows, since]);
    const previousAnchor = this.anchors.get(anchorKey); if (previousAnchor?.signature === signature) return;
    const first = Math.floor(records[0].time / quarter), through = Math.floor(last.time / quarter);
    this.anchors.set(anchorKey, {signature, through, since});
    if (previousAnchor?.through === through && previousAnchor.since === since) return;
    for (const [window, points] of Object.entries(windows)) {
      const previousBoundary = new Map();
      for (const [key, group] of this.scopes) if (group.scope.provider === provider && group.scope.account === last.account && group.scope.window === window) {
        if (group.cells.has(first)) previousBoundary.set(key, group.cells.get(first));
        for (const time of group.cells.keys()) if (time >= first) group.cells.delete(time);
      }
      for (const cell of summarize(finite(since) ? points.filter(point => point.time > since) : points)) {
        const scope = {provider, account: last.account, window, plan: cell.plan, mult: cell.mult ?? null}; scope.capKey = this.capKey(scope); const key = JSON.stringify(scope);
        let group = this.scopes.get(key); if (!group) {group = {scope, cells: new Map()}; this.scopes.set(key, group);}
        if (cell.key < through) group.cells.set(cell.key, {key: cell.key, ms: cell.ms, consumed: cell.consumed, cycle: cell.cycle});
      }
      for (const [key, cell] of previousBoundary) this.scopes.get(key).cells.set(first, cell);
    }
    this.trim(last.time); this.revision++; this.dirty = true;
  }
  older(provider, account, window, last, firstTime, since = -Infinity) {
    const scope = {provider, account, window, plan: last?.plan, mult: last?.mult ?? null}; scope.capKey = this.capKey(scope); const group = this.scopes.get(JSON.stringify(scope));
    return group ? [...group.cells.values()].filter(cell => (cell.key + 1) * quarter <= firstTime && cell.key * quarter >= since).map(cell => ({...cell, segment: 'archived:' + cell.cycle})).sort((a, b) => a.key - b.key) : [];
  }
  trim(now = Date.now()) {
    const cutoff = (now - (this.retentionDays || 90) * day) / quarter;
    for (const [key, group] of this.scopes) {for (const time of group.cells.keys()) if (time < cutoff) group.cells.delete(time); if (!group.cells.size) this.scopes.delete(key);}
    const all = [...this.scopes].flatMap(([scope, group]) => [...group.cells.keys()].map(time => ({scope, time})));
    if (all.length > maxCells) for (const cell of all.sort((a, b) => b.time - a.time).slice(maxCells)) this.scopes.get(cell.scope).cells.delete(cell.time);
    if (this.scopes.size > 4096) for (const [key] of [...this.scopes].sort((a, b) => [...b[1].cells.keys()].reduce((a,b)=>Math.max(a,b),-Infinity) - [...a[1].cells.keys()].reduce((a,b)=>Math.max(a,b),-Infinity)).slice(4096)) this.scopes.delete(key);
  }
  async save() {
    if (!this.dirty || !this.capacityKey) return;
    this.trim(); const revision = this.revision, capacityKey = this.capacityKey, scopes = [...this.scopes.values()];
    let cells = scopes.flatMap((group, index) => [...group.cells.values()].map(cell => [cell.key, index, cell.ms, cell.consumed, cell.cycle])).sort((a, b) => b[0] - a[0]).slice(0, maxCells);
    let bytes;
    do {bytes = JSON.stringify({version: 1, capacityKey: this.capacityKey, epoch: this.epoch ?? null, scopes: scopes.map(group => group.scope), cells}); if (Buffer.byteLength(bytes) > maxBytes) cells = cells.slice(0, Math.floor(cells.length * .8)); else break;} while (cells.length);
    const file = this.file + '.' + process.pid + '.tmp'; await fs.mkdir(path.dirname(this.file), {recursive: true});
    await fs.writeFile(file, bytes, {mode: 0o600}); await fs.rename(file, this.file); if (revision === this.revision && capacityKey === this.capacityKey) this.dirty = false;
    const stat = await fs.stat(this.file); this.stamp = [stat.ino, stat.size, stat.mtimeMs].join('/');
  }
}
module.exports = {PatternBook, summarize};
