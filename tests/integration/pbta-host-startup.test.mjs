import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Api } from '../../gm-agent/src/api.mjs';

const base = process.env.API_BASE || 'http://localhost:18081';
const cli = fileURLToPath(new URL('../../gm-agent/src/cli.mjs', import.meta.url));

test('run prepares a pre-created PbtA channel, waits through restart, and hosts after GM approval', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pbta-attached-'));
  const trace = join(dir, 'calls.jsonl');
  const world = join(dir, 'world.md');
  await writeFile(world, 'Mail pilots exchange voices between the floating islands.');
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map((host) => host.stop()));
    await rm(dir, { recursive: true, force: true });
  });
  const gm = new Api(base);
  const username = 'mail' + Date.now().toString(36);
  await gm.register(username, 'password', 'GM');
  const server = await gm.createServer('Air mail');
  const { id } = await gm.createChannel(server.id, { name: 'Pilots', rule_system: 'pbta' });
  const window = (await gm.windows(id))[0].id;
  const start = (channel, ...args) => {
    const proc = spawn(
      process.execPath,
      [
        cli,
        'run',
        '--channel',
        channel,
        '--username',
        username,
        '--api',
        base,
        '--state-dir',
        dir,
        '--llm-provider',
        'mock',
        '--llm-trace',
        trace,
        '--planner',
        'false',
        '--autonomy',
        'false',
        ...args,
      ],
      {
        cwd: dir,
        env: { ...process.env, GM_PASSWORD: 'password' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const closed = once(proc, 'close');
    let output = '';
    for (const stream of [proc.stdout, proc.stderr]) stream.on('data', (data) => (output += data));
    const host = {
      async waitFor(text) {
        const deadline = Date.now() + 15000;
        while (!output.includes(text)) {
          assert.ok(proc.exitCode === null && proc.signalCode === null && Date.now() < deadline, output);
          await delay(50);
        }
      },
      async stop() {
        proc.kill('SIGTERM');
        await closed;
        children.delete(host);
      },
      closed,
    };
    children.add(host);
    return host;
  };

  const first = start(id, '--world', world, '--coplayers', '1', '--kickoff');
  await first.waitFor('Waiting for your decision.');
  const draft = await gm.pbtaDraft(id);
  assert.equal(draft.status, 'pending');
  assert.deepEqual(await gm.characters(id), []);
  assert.deepEqual(await gm.messages(id, window), []);
  const competing = start(id);
  await competing.waitFor('already keeps this channel');
  await first.stop();

  // No world path, cast count or separate setup command on recovery.
  const resumed = start(id);
  await resumed.waitFor('Waiting for your decision.');
  assert.equal((await gm.pbtaDraft(id)).version, draft.version);
  const oldBook = draft.pack.books[0].id;
  draft.pack.books[0].id = 'courier';
  for (const move of draft.pack.moves) if (move.book === oldBook) move.book = 'courier';
  await gm.reviewPbta(id, {
    op: 'activate',
    version: draft.version,
    revision: draft.revision,
    pack: draft.pack,
  });
  await resumed.waitFor('keeping "Pilots"');
  const cast = await gm.characters(id);
  assert.equal(cast.length, 1);
  assert.equal(cast[0].role_card.pbta.book, 'courier');
  await resumed.stop();
  const playAgain = start(id);
  await playAgain.waitFor('keeping "Pilots"');
  await playAgain.stop();
  assert.deepEqual(
    (await gm.characters(id)).map((c) => c.id),
    [cast[0].id],
  );
  assert.deepEqual(
    (await gm.channels(server.id)).map((c) => c.id),
    [id],
  );
  const calls = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).purpose);
  assert.deepEqual(
    calls.filter((p) => p.startsWith('pbta_')),
    ['pbta_design', 'pbta_card'],
  );

  // A channel whose earlier one-shot setup failed can retry under the attached host, then keep the starter.
  const retryTable = await gm.createChannel(server.id, { name: 'Retry', rule_system: 'pbta' });
  const original = await gm.pbtaRules(retryTable.id);
  const claim = await gm.reviewPbta(retryTable.id, { op: 'start', world_hash: 'd'.repeat(64), version: 0 });
  const failed = await gm.reviewPbta(retryTable.id, {
    op: 'fail',
    version: claim.version,
    error: 'design interrupted',
  });
  const waiting = start(retryTable.id, '--world', world, '--coplayers', '0');
  await waiting.waitFor('design interrupted');
  await gm.reviewPbta(retryTable.id, { op: 'retry', version: failed.version });
  await waiting.waitFor('· pending');
  const replacement = await gm.pbtaDraft(retryTable.id);
  await gm.reviewPbta(retryTable.id, { op: 'keep', version: replacement.version });
  await waiting.waitFor('keeping "Retry"');
  assert.deepEqual(await gm.pbtaRules(retryTable.id), original);
  await waiting.stop();

  // The GM may keep the official pack while a design request is still in flight.
  const busy = await gm.createChannel(server.id, { name: 'In flight', rule_system: 'pbta' });
  const provider = createServer();
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => {
    provider.closeAllConnections();
    provider.close();
  });
  const request = once(provider, 'request', { signal: AbortSignal.timeout(15000) });
  const late = start(
    busy.id,
    '--world',
    world,
    '--coplayers',
    '0',
    '--llm-provider',
    'openai_compatible',
    '--llm-model',
    'test',
    '--llm-api-base',
    'http://127.0.0.1:' + provider.address().port,
    '--llm-api-key',
    'test-only',
  );
  const [, response] = await request;
  const designing = await gm.pbtaDraft(busy.id);
  assert.equal(designing.status, 'designing');
  await gm.reviewPbta(busy.id, { op: 'keep', version: designing.version });
  response.writeHead(503).end();
  await late.waitFor('keeping "In flight"');
  assert.equal((await gm.pbtaDraft(busy.id)).status, 'kept');
  await late.stop();

  const starter = await gm.createChannel(server.id, { name: 'Starter', rule_system: 'pbta' });
  const noWorld = start(starter.id, '--coplayers', '0');
  await noWorld.waitFor('keeping "Starter"');
  assert.equal((await gm.pbtaDraft(starter.id)).status, 'none');
  await noWorld.stop();
  const inherited = await gm.pbtaRules(starter.id);
  inherited.pack.name = 'A hand-written game';
  await gm.put('/api/channels/' + starter.id + '/pbta', inherited);
  const adopted = start(starter.id, '--world', world);
  await adopted.waitFor('keeping "Starter"');
  assert.equal((await gm.pbtaRules(starter.id)).pack.name, 'A hand-written game');
  assert.equal((await gm.pbtaDraft(starter.id)).status, 'none');
  await adopted.stop();

  const coc = await gm.createChannel(server.id, { name: 'Existing CoC', rule_system: 'coc7e' });
  const mismatch = start(coc.id, '--rules', 'pbta', '--world', world);
  await mismatch.waitFor('Select PbtA under GM workspace');
  assert.equal((await mismatch.closed)[0], 1);
  assert.equal((await gm.channel(coc.id)).rule_system, 'coc7e');
  assert.equal((await gm.characters(coc.id)).length, 0);
});
