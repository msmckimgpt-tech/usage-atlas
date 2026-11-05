'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {sanitize} = require('./core.cjs');
class ObservationQueue {
  constructor(dir, {maxItems = 4096, maxBytes = 8 * 1024 * 1024} = {}) {
    this.dir = dir; this.file = path.join(dir, 'pending-observations.jsonl'); this.maxItems = maxItems; this.maxBytes = maxBytes;
    this.memory = []; this.pending = []; this.bytes = 0; this.stamp = null; this.issue = ''; this.recovered = 0;
  }
  key(value) {return `${value.provider}/${value.account}/${value.time}`;}
  status() {return {pending: this.pending.length + this.memory.length, memory: this.memory.length, bytes: this.bytes, issue: this.issue, recovered: this.recovered};}
  async load() {
    try {
      const stat = await fs.stat(this.file), stamp = `${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;
      if (stamp === this.stamp) return;
      if (stat.size > this.maxBytes) throw new Error('미저장 관측 대기 공간이 가득 찼습니다.');
      const raw = await fs.readFile(this.file, 'utf8'), pending = [];
      let damaged = false;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {const envelope = JSON.parse(line); if (envelope.v !== 1) throw new Error(); pending.push(sanitize(envelope.snapshot));}
        catch {damaged = true;}
      }
      if (pending.length > this.maxItems) throw new Error('미저장 관측 개수 제한에 도달했습니다.');
      if (damaged) {
        const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20), preserved = path.join(this.dir, `pending-damaged-${digest}.jsonl`);
        const existing = (await fs.readdir(this.dir)).filter(name => /^pending-damaged-[a-f0-9]{20}\.jsonl$/.test(name));
        if (existing.some(name => name !== path.basename(preserved))) throw new Error('손상된 대기 기록이 이미 보존되어 있습니다. 기존 기록을 확인한 뒤 복구하세요.');
        await fs.copyFile(this.file, preserved, require('node:fs').constants.COPYFILE_EXCL).catch(error => {if (error.code !== 'EEXIST') throw error;});
        this.issue = '손상된 대기 기록 원본을 별도 보존했습니다. 읽을 수 있는 관측을 복구합니다.';
      }
      this.pending = pending; this.bytes = stat.size; this.stamp = stamp; this.damaged = damaged;
    } catch (error) {
      if (error.code === 'ENOENT') {this.pending = []; this.bytes = 0; this.stamp = null; this.damaged = false; return;}
      throw error;
    }
  }
  async flush(store, recovering = false) {
    await this.load();
    const values = [...this.pending, ...this.memory];
    if (!values.length && !this.damaged) {this.issue = ''; return await store.read();}
    const data = await store.commit(values);
    // Commit is durable before acknowledgment; replay after a crash is deduplicated by Store.
    const temporary = this.file + `.${process.pid}.tmp`;
    let handle;
    try {handle = await fs.open(temporary, 'w', 0o600); await handle.sync(); await handle.close(); handle = null; await fs.rename(temporary, this.file);}
    finally {await handle?.close(); await fs.unlink(temporary).catch(() => {});}
    if (recovering) this.recovered += values.length;
    this.pending = []; this.memory = []; this.bytes = 0; this.stamp = null; this.damaged = false; this.issue = '';
    return data;
  }
  async ready(store) {
    try {await this.flush(store, true); return true;}
    catch (error) {this.issue = `관측 저장 복구 대기: ${error.code || '저장 오류'}. 새 조회를 중지합니다.`; return false;}
  }
  async accept(additions, store) {
    if (this.memory.length) throw new Error('미저장 관측을 복구한 뒤 다시 조회해야 합니다.');
    const clean = additions.map(sanitize);
    this.memory = clean;
    try {await this.load();}
    catch (error) {this.issue = `관측 저장 복구 대기: ${error.code || '대기 기록 확인 필요'}. 새 조회를 중지합니다.`; throw error;}
    const known = new Set(this.pending.map(s => this.key(s)));
    const fresh = clean.filter(s => {const key = this.key(s); if (known.has(key)) return false; known.add(key); return true;});
    this.memory = fresh;
    const encoded = fresh.map(snapshot => JSON.stringify({v: 1, snapshot}) + '\n').join('');
    if (this.pending.length + fresh.length > this.maxItems || this.bytes + Buffer.byteLength(encoded) > this.maxBytes) {this.memory = fresh; this.issue = '미저장 관측 대기 공간이 가득 찼습니다. 새 조회를 중지합니다.'; throw new Error(this.issue);}
    if (fresh.length) {
      let handle;
      try {await fs.mkdir(this.dir, {recursive: true}); handle = await fs.open(this.file, 'a', 0o600); await handle.writeFile(encoded); await handle.sync(); this.pending.push(...fresh); this.memory = []; this.bytes += Buffer.byteLength(encoded); this.stamp = null;}
      catch (error) {this.memory = fresh; this.issue = '관측 임시 저장 실패: 저장 공간을 확인하세요. 새 조회를 중지합니다.'; throw error;}
      finally {await handle?.close();}
    }
    try {return await this.flush(store);}
    catch (error) {this.issue ||= `관측 저장 복구 대기: ${error.code || '저장 오류'}. 새 조회를 중지합니다.`; throw error;}
  }
}
module.exports = {ObservationQueue};
