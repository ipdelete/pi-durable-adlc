import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { listenerToken, startAgent, stateDirectory } from './index.js';

function fixture(root, port) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const agent = {
    name: 'lifecycle-test', port, description: 'Lifecycle test',
    skills: [{ id: 'chat', name: 'Chat', description: 'Chat', tags: [] }],
    instructions: 'Answer.', maxTurns: 2, cwd: root, extensions: [],
  };
  const options = {
    models, model: { provider: model.provider, modelId: model.id },
    host: '127.0.0.1', directory: stateDirectory(agent, root),
  };
  return { agent, options, faux };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
}

async function stop(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('failed listen cleans up and the same store/port can be opened again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lifecycle-'));
  const occupied = createServer();
  await listen(occupied, 0);
  const { agent, options } = fixture(root, occupied.address().port);
  let running;
  try {
    await assert.rejects(startAgent(agent, options), { code: 'EADDRINUSE' });
    await stop(occupied);
    running = await startAgent(agent, options);
    // Shutdown is idempotent, including callers arriving before it finishes.
    assert.equal(running.close(), running.close());
    await running.close();
    running = await startAgent(agent, options);
  } finally {
    await running?.close();
    if (occupied.listening) await stop(occupied);
    await rm(root, { recursive: true, force: true });
  }
});

test('shutdown joins an in-flight A2A request before closing Durable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lifecycle-'));
  const probe = createServer();
  await listen(probe, 0);
  const port = probe.address().port;
  await stop(probe);
  const { agent, options, faux } = fixture(root, port);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  faux.setResponses([async () => {
    entered.resolve();
    await release.promise;
    return fauxAssistantMessage('done');
  }]);
  const running = await startAgent(agent, options);
  const request = fetch(`http://127.0.0.1:${port}/a2a`, {
    method: 'POST',
    headers: { authorization: `Bearer ${listenerToken(options.directory)}`, 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {
      message: { messageId: 'shutdown', role: 'ROLE_USER', parts: [{ text: 'work' }] },
    } }),
  }).then((response) => response.text()).catch(() => undefined); // shutdown may close the HTTP connection
  try {
    await entered.promise;
    const closing = running.close();
    release.resolve();
    await closing;
    await request;
    // Reopening verifies the store was released even with work in progress.
    const restarted = await startAgent(agent, options);
    await restarted.close();
  } finally {
    release.resolve();
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
