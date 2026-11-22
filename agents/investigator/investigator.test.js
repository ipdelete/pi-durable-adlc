import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInvestigator } from './index.js';

test('works from its own workspace with the coding tools and no hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'investigator-'));
  try {
    const workspace = join(root, 'workspace');
    const agent = createInvestigator({ workspace });
    assert.equal(agent.cwd, workspace);
    assert.ok(existsSync(workspace));
    assert.match(agent.instructions, new RegExp(`git worktree add .* ${workspace}/worktrees/`));
    const tools = agent.extensions.flatMap((extension) => extension.tools ?? []).map((tool) => tool.name);
    assert.deepEqual(tools.sort(), ['bash', 'edit', 'read', 'write']);
    assert.equal(agent.extensions.some((extension) => extension.hooks?.length), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
