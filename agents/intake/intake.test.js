import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, ToolResultEntry } from '@earendil-works/pi-durable';
import { createIntake } from './index.js';

for (const fail of [false, true]) {
  test(`intake allows one filing attempt per input, including failed attempts (${fail})`, async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    const filing = () => fauxToolCall('create_feature_issue', { title: 'Feature', description: 'Description' });
    faux.setResponses([
      // Two calls in the same round, then a retry in the next round.
      fauxAssistantMessage([filing(), filing()], { stopReason: 'toolUse' }),
      fauxAssistantMessage(filing(), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Check GitHub.'),
      fauxAssistantMessage(filing(), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Filed a new request.'),
    ]);
    let attempts = 0;
    const agent = createIntake({ github: async () => {
      attempts++;
      if (fail) throw new Error('Ambiguous network failure');
      return { html_url: 'https://github.com/example/repo/issues/1' };
    } });
    const registry = createRegistry();
    for (const extension of agent.extensions) registry.install(extension);
    const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
    const openStorage = () => openNodeSqliteStorage(join(directory, 'durable.sqlite'));
    const options = { models, registry, settings: { toolExecution: 'sequential' } };
    let harness = await Harness.open(await openStorage(), options, context);
    try {
      const model = faux.getModel();
      let root = await harness.root(context, { agent: {
        model: { provider: model.provider, modelId: model.id }, maxTurns: 5,
      } });
      const first = await (await root.submit({ type: 'input', content: 'File the feature' }, context)).wait(context);
      assert.equal(first.status, 'done');
      assert.equal(attempts, 1);
      const { items } = await root.entries({ order: 'ascending' }, 100, undefined, context);
      const blocked = items.filter(ToolResultEntry.is).filter((entry) => JSON.stringify(entry.model).includes('Only one filing attempt'));
      assert.equal(blocked.length, 2);
      // A new input after reopening may file again; no conversation-wide cache.
      await harness.close(context);
      harness = await Harness.open(await openStorage(), options, context);
      root = await harness.root(context);
      const second = await (await root.submit({ type: 'input', content: 'File another feature' }, context)).wait(context);
      assert.equal(second.status, 'done');
      assert.equal(attempts, 2);
    } finally {
      await harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
