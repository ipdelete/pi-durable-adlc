import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import { listenerToken, startAgent, stateDirectory } from './index.js';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('serves an agent definition over A2A with its tools and instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-'));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const seen = [];
  faux.setResponses([
    (context) => {
      seen.push(JSON.stringify(context)); // the instructions reach the model with the request
      return fauxAssistantMessage(fauxToolCall('echo', { text: 'ping' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('pong'),
  ]);
  const agent = {
    name: 'test-agent', port: await freePort(),
    description: 'A test agent', skills: [{ id: 'echo', name: 'Echo', description: 'Echo', tags: [] }],
    instructions: 'You are the test agent.', maxTurns: 3, cwd: root,
    extensions: [defineExtension({ name: 'echo', tools: [defineTool({
      name: 'echo', description: 'Echo text', parameters: obj({ text: str() }),
      async execute({ text }) { return { output: [{ type: 'text', text }] }; },
    })] })],
  };
  const directory = stateDirectory(agent, root);
  const model = faux.getModel();
  const running = await startAgent(agent, {
    models, model: { provider: model.provider, modelId: model.id }, host: '127.0.0.1', directory,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${agent.port}/a2a`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${listenerToken(directory)}`,
        'content-type': 'application/json',
        'a2a-version': '1.0',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'SendMessage',
        params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'ping' }] } },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.result?.task?.status?.state, 'TASK_STATE_COMPLETED', JSON.stringify(body));
    assert.match(JSON.stringify(body.result.task), /pong/);
    assert.match(seen[0] ?? '', /You are the test agent\./);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
