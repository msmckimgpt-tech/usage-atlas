'use strict';
const path = require('node:path');
const {Worker} = require('node:worker_threads');
class HistoryArchive {
  constructor(dir, retentionDays = 365, reader = false) {this.dir = dir; this.retentionDays = retentionDays; this.serial = 0; this.pending = new Map(); this.closed = false; this.isReader = reader;}
  request(type, values = {}, {signal} = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(Error('과거 기록 조회가 취소되었습니다.'));
    clearTimeout(this.idle);
    if (!this.worker) {
      const worker = new Worker(path.join(__dirname, 'history-archive-worker.cjs'), {workerData: {dir: this.dir, reader: this.isReader}, execArgv: [], resourceLimits: {maxOldGenerationSizeMb: this.isReader ? 128 : 32}});
      this.worker = worker; worker.unref();
      worker.on('message', message => {
        const job = this.pending.get(message.id); if (!job) return;
        this.pending.delete(message.id); job.cleanup();
        message.error ? job.reject(Error(message.error)) : job.resolve(message.value);
        if (!this.pending.size) {worker.unref(); this.idle = setTimeout(() => {if (this.worker === worker && !this.pending.size) {this.worker = null; worker.terminate();}}, 120000); this.idle.unref?.();}
      });
      const failed = () => {if (this.worker !== worker) return; this.worker = null; for (const job of this.pending.values()) {job.cleanup(); job.reject(Error('과거 기록 작업이 종료되었습니다. 다시 시도해주세요.'));} this.pending.clear();};
      worker.on('error', failed); worker.on('exit', failed);
    }
    const id = ++this.serial, cancel = new Int32Array(new SharedArrayBuffer(4));
    return new Promise((resolve, reject) => {
      const abort = () => Atomics.store(cancel, 0, 1);
      signal?.addEventListener('abort', abort, {once: true});
      this.pending.set(id, {resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort)});
      this.worker.ref();
      this.worker.postMessage({id, type, retentionDays: this.retentionDays, ...values, cancel: cancel.buffer});
    });
  }
  async append(records) {let inserted = 0; for (let i = 0; i < Math.max(1, records.length); i += 2048) inserted += (await this.request('append', {records: records.slice(i, i + 2048)})).inserted; return {inserted};}
  async reader() {if (this.isReader) return this; await this.append([]); this.readClient ||= new HistoryArchive(this.dir, this.retentionDays, true); this.readClient.retentionDays = this.retentionDays; return this.readClient;}
  async query(values, options) {return (await this.reader()).request('query', values, options);}
  async details(values, options) {return (await this.reader()).request('details', values, options);}
  release() {if (this.readClient) return this.readClient.release(); if (this.isReader && this.worker) return this.request('release'); return Promise.resolve();}
  dispose() {this.closed = true; clearTimeout(this.idle); const worker = this.worker; this.worker = null; for (const job of this.pending.values()) {job.cleanup(); job.reject(Error('과거 기록 작업이 종료되었습니다.'));} this.pending.clear(); return Promise.all([worker?.terminate(), this.readClient?.dispose()]);}
}
module.exports = {HistoryArchive};
