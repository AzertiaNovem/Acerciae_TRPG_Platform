import { parentPort, workerData } from 'node:worker_threads';
import { run } from './cli.mjs';
import { tableSnapshot } from './host-status.mjs';
let runtime, stopping = false;
parentPort.on('message', async msg => {
  // The Web UI's status page: a snapshot of the live table (no secrets), answered by request id.
  if (msg?.type === 'status') {
    let snapshot = null, error = null;
    try { if (runtime) snapshot = tableSnapshot(runtime.table, { cfg: runtime.cfg, channel: runtime.channel, realtime: runtime.realtime }); else error = 'not ready'; }
    catch (e) { error = e.message; }
    parentPort.postMessage({ type: 'status', id: msg.id, snapshot, error });
    return;
  }
  if (msg !== 'stop' || stopping) return;
  stopping = true;
  if (runtime) { await runtime.stop(); parentPort.close(); }
});
try {
  runtime = await run(workerData, { managed: true, onLock: () => parentPort.postMessage('locked') });
  if (stopping) { await runtime.stop(); parentPort.close(); }
  else parentPort.postMessage('ready');
} catch (e) {
  // The manager redacts known secrets before the UI shows this.
  parentPort.postMessage({ type: 'failed', error: String(e?.message ?? e) });
  process.exitCode = 1; parentPort.close();
}
