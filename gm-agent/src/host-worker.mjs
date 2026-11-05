import { parentPort, workerData } from 'node:worker_threads';
import { run } from './cli.mjs';
let runtime, stopping = false;
parentPort.on('message', async msg => {
  if (msg !== 'stop' || stopping) return;
  stopping = true;
  if (runtime) { await runtime.stop(); parentPort.close(); }
});
try {
  runtime = await run(workerData, { managed: true, onLock: () => parentPort.postMessage('locked') });
  if (stopping) { await runtime.stop(); parentPort.close(); }
  else parentPort.postMessage('ready');
} catch { parentPort.postMessage('failed'); process.exitCode = 1; parentPort.close(); }
