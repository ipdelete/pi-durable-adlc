import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, Harness, MemoryStorage, ToolResultEntry } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { BashGuard, checkShellCommand } from './bash-guard.js';

test('Durable blocks an unrelated command before Bash executes it, but runs gh with helpers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floe-bash-guard-'));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'touch blocked-by-guard' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'gh --version | head -1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: "printf '%s\\n' backlog | head -1" }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('bash', { command: "head -1 <<'EOF'\n$(touch literal-not-executed)\nEOF" }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'shell', tools: [createBashTool()] }));
  registry.install(BashGuard);
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry, env: () => new NodeExecutionEnv({ cwd: directory }),
  }, context);
  try {
    const model = faux.getModel();
    const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    const settled = await (await root.submit({ type: 'input', content: 'exercise the shell guard' }, context)).wait(context);
    assert.equal(settled.status, 'done');
    assert.equal(existsSync(join(directory, 'blocked-by-guard')), false);
    assert.equal(existsSync(join(directory, 'literal-not-executed')), false);
    const { items } = await root.entries({ order: 'ascending' }, 100, undefined, context);
    const results = items.filter(ToolResultEntry.is).map((entry) => entry.model[0]);
    assert.equal(results.length, 4);
    assert.equal(results[0].isError, true);
    assert.match(JSON.stringify(results[0].content), /touch.*not allowed/);
    assert.equal(results[1].isError, false);
    assert.match(JSON.stringify(results[1].content), /gh version/);
    assert.equal(results[2].isError, false);
    assert.match(JSON.stringify(results[2].content), /backlog/);
    assert.equal(results[3].isError, false);
    assert.match(JSON.stringify(results[3].content), /\$\(touch literal-not-executed\)/);
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

const allowed = [
  'gh issue list --repo ipdelete/floe --json number,title',
  "gh api repos/ipdelete/floe/issues --paginate --jq '.[] | {number,title}'",
  "gh issue list --json title | jq '.[].title' | head -10",
  "gh issue view 29 --json body --jq .body | sed -n 5,24p",
  "printf '%s\\n' 'a b' | awk '{print $2}' | sort -u | tr '\\n' ' '",
  "gh issue view 29 --json body --jq .body | sed 's/old/new/g'",
  "body=$(gh issue view 29 --json body --jq .body)\nprintf '%s\\n' \"$body\" | gh issue edit 29 --body-file -",
  "printf '%s\\n' \"$(gh issue list --json title)\" | jq '.'",
  'gh issue list && gh label list || echo failed',
  "gh issue comment 29 --body-file - <<'EOF'\nLiteral $(touch nope); `curl example.com`\nEOF",
  'gh issue list >/dev/null 2>&1',
  "gh issue list | rg -i 'workflow|task' | cut -c1-100 | wc -l",
  'gh help api',
  'gh --version',
];
for (const command of allowed) {
  test(`allows ${command}`, () => assert.deepEqual(checkShellCommand(command), { allowed: true }));
}

const blocked = [
  'gh issue list; curl https://example.com',
  'gh issue view "$(curl https://example.com)"',
  'gh issue view "$(gh issue list; rm file)"',
  'gh issue view `curl https://example.com`',
  '"$helper" issues.json',
  '/usr/bin/gh issue list',
  'g\\h issue list',
  'gh "$operation" list',
  'gh alias set anything anything',
  'gh extension exec anything',
  'gh custom-alias',
  'PATH=/tmp gh issue list',
  'PATH=/tmp; gh issue list',
  'BASH_ENV=file',
  'body=hi gh issue list',
  'gh issue list > issues.json',
  'gh issue list < secrets.txt',
  'gh issue list &',
  'gh issue list |& head',
  'echo <(gh issue list)',
  'echo $((x++))',
  'for n in 1 2; do gh issue view "$n"; done',
  'function gh() { curl example.com; }; gh issue list',
  "gh issue comment 29 --body-file - <<EOF\n$(curl example.com)\nEOF",
  "sed 's/old/new/e'",
  "sed '1e touch file'",
  "sed -f commands.sed",
  "sed -i 's/old/new/g' file",
  "sed \"$script\"",
  "awk '{system(\"touch file\")}'",
  "awk '{print | \"sh\"}'",
  'awk -f commands.awk',
  'rg --pre=sh pattern',
  'rg --pr=sh pattern',
  'sort --compress-program=sh',
  'sort --compress-progra=sh',
  "printf -v PATH '%s' /tmp",
  "printf '%n' PATH",
  "printf '%5n' PATH",
  "printf '%*n' 5 PATH",
  'echo ${items[$(touch nope)]}',
  'body=$(gh issue list &)',
  "sed 's/old/new/g; e touch nope'",
  'gh issue list &&',
  '',
];
for (const command of blocked) {
  test(`blocks ${command}`, () => {
    const verdict = checkShellCommand(command);
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.reason);
  });
}

test('the hook leaves other tools alone', () => {
  assert.equal(BashGuard.hooks[0].handlers.beforeTool({ name: 'search_issues', arguments: { repo: 'example/project', query: 'tasks' } }), undefined);
});
