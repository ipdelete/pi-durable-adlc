// Starts the agents over A2A.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { startAgent } from './agent-host/index.js';
import { createBacklog } from './agents/backlog/index.js';
import { createInvestigator } from './agents/investigator/index.js';
import { githubClient } from './shared/github.js';

const model = {
  provider: process.env.PI_PROVIDER ?? 'github-copilot',
  modelId: process.env.AGENT_MODEL ?? process.env.PI_MODEL ?? 'gpt-6.2-sol',
};
const models = await ModelRuntime.create();
if (!(await models.getAvailable(model.provider)).some(({ id }) => id === model.modelId)) {
  throw new Error(`${model.provider}/${model.modelId} is unavailable; check Pi's /login and /model`);
}
process.umask(0o077);

const github = githubClient(execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8' }).trim());
const agents = [
  createBacklog({ github }),
  createInvestigator({
    workspace: process.env.INVESTIGATOR_WORKSPACE ?? fileURLToPath(new URL('.agents/investigator/workspace/', import.meta.url)),
  }),
];

const running = [];
let stopping = false;
const startupDone = Promise.withResolvers();
let shutdown;
// Register before opening any agent. A signal during start waits for that attempt
// to finish, then closes everything it opened; don't start the next agent.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    shutdown ??= startupDone.promise.then(() => Promise.all(running.map((agent) => agent.close())));
    shutdown.then(() => process.exit(0), () => process.exit(1));
  });
}
try {
  for (const agent of agents) {
    if (stopping) break;
    running.push(await startAgent(agent, { models, model }));
  }
} catch (error) {
  await Promise.allSettled(running.map((agent) => agent.close()));
  throw error;
} finally {
  startupDone.resolve();
}
