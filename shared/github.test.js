import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIssueTool, repository, searchIssuesTool } from './github.js';

for (const value of [undefined, '', 'floe', 'https://github.com/owner/repo', 'owner/repo/issues', 'owner/repo repo:other/repo', 'owner/..', 'owner/.']) {
  test(`rejects repository ${JSON.stringify(value)}`, async () => {
    assert.throws(() => repository(value), /owner\/name/);
    let calls = 0;
    const client = async () => { calls++; };
    await assert.rejects(searchIssuesTool(client).execute({ repo: value, query: 'workflow' }), /owner\/name/);
    await assert.rejects(createIssueTool(client).execute({ repo: value, title: 'Feature', description: 'Body' }), /owner\/name/);
    assert.equal(calls, 0);
  });
}

test('searches only the repository supplied on each call, including open and closed issues', async () => {
  const queries = [];
  const tool = searchIssuesTool(async (path) => {
    queries.push(new URL(path, 'https://api.github.com').searchParams.get('q'));
    return { items: [], incomplete_results: false };
  });
  await tool.execute({ repo: 'first/project', query: 'workflow' });
  await tool.execute({ repo: 'second/another.project', query: 'schedule' });
  assert.deepEqual(queries, [
    'repo:first/project is:issue ("workflow")',
    'repo:second/another.project is:issue ("schedule")',
  ]);
});

test('creation passes the explicit repository to its callback', async () => {
  const calls = [];
  const tool = createIssueTool(async (args) => {
    calls.push(args);
    return `https://github.com/${args.repo}/issues/1`;
  });
  for (const repo of ['first/project', 'second/project']) {
    const result = await tool.execute({ repo, title: 'Feature', description: 'Body' });
    assert.equal(result.output[0].text, `https://github.com/${repo}/issues/1`);
  }
  assert.deepEqual(calls.map(({ repo }) => repo), ['first/project', 'second/project']);
});
