'use strict';
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
const analyze = data => data.operation === 'conversion' ? require('./credit-conversion.cjs').buildConversion(data) : require('./analytics.cjs').analyze(data);
const cancelled = () => Object.assign(new Error('상세 분석이 취소되었습니다.'), {code: 'ABORT_ERR'});
async function queryAnalysis(data, {signal, deadlineMs = 10000, threshold = 1500} = {}) {
  if (signal?.aborted) throw cancelled();
  if ((data.calls?.length || 0) <= threshold) return analyze(data);
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {workerData: data, execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16, stackSizeMb: 4}});
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(cancelled());
    const timeout = setTimeout(() => finish(new Error('상세 분석 시간 제한에 도달했습니다. 기간이나 조건을 좁혀 다시 조회하세요.')), deadlineMs);
    signal?.addEventListener('abort', abort, {once: true});
    worker.once('message', result => result.error ? finish(new Error(result.error)) : finish(null, result.data));
    worker.once('error', () => finish(new Error('상세 분석 작업을 완료하지 못했습니다. 기간을 좁혀 다시 조회하세요.')));
    worker.once('exit', code => {if (!settled) finish(new Error(`상세 분석 작업이 종료되었습니다 (${code}).`));});
    if (signal?.aborted) abort();
  });
}
if (!isMainThread) {
  try {parentPort.postMessage({data: analyze(workerData)});}
  catch {parentPort.postMessage({error: '상세 분석을 완료하지 못했습니다. 기간과 필터를 확인하세요.'});}
}
module.exports = {queryAnalysis};
