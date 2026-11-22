// Agent host: serves one agent definition as a persistent Durable conversation over A2A.
// The host owns state, the listener token, the Harness, the A2A listener and shutdown;
// the definition supplies identity, instructions, tools/hooks (extensions) and its working directory.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { A2AExtension, A2AHandler, createA2AServer } from 'pi-durable-a2a';
import { liteLLMTaskHandler } from 'pi-durable-a2a/litellm';

const stateRoot = fileURLToPath(new URL('../.agents/', import.meta.url));

/** An agent's private state directory: its Durable store, listener token and registration. */
export function stateDirectory(identity, root = stateRoot) {
  const directory = join(root, identity.name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** The listener binds the machine's Tailscale address, which the fleet's LiteLLM gateway reaches. */
export function tailscaleAddress() {
  const addresses = [...new Set(Object.values(networkInterfaces()).flat().filter((entry) => {
    const [first, second] = entry.address.split('.').map(Number);
    return entry.family === 'IPv4' && !entry.internal && first === 100 && second >= 64 && second <= 127;
  }).map((entry) => entry.address))];
  if (addresses.length !== 1) throw new Error('Expected one Tailscale IPv4 address; check that Tailscale is connected');
  return addresses[0];
}

/** The listener token, created once per agent. LiteLLM stores it with the registration. */
export function listenerToken(directory) {
  const file = join(directory, 'listener-token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('base64url');
    writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
    return token;
  }
}

/** The Agent Card fields shared by the listener and gateway registration. */
export function card({ name, description, skills }) {
  return { name, description, skills };
}

/**
 * Serve `agent` until `close()`.
 * `agent`: { name, port, description, skills, instructions, maxTurns, cwd, extensions }.
 */
export async function startAgent(agent, { models, model, host = tailscaleAddress(), directory = stateDirectory(agent) }) {
  const token = listenerToken(directory);
  const registry = createRegistry();
  registry.install(A2AExtension);
  for (const extension of agent.extensions) registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'durable.sqlite')), {
    models, registry,
    env: () => new NodeExecutionEnv({ cwd: agent.cwd }),
    settings: { toolExecution: 'sequential', stream: { timeoutMs: 60_000 } },
  }, context);
  let a2a;
  let server;
  let closing;
  // Stop admission first; A2A joins accepted Durable calls before the Harness closes.
  // The HTTP close callback also joins response writes before the host can exit.
  function close() {
    return closing ??= (async () => {
      const httpClosed = server ? new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }) : Promise.resolve();
      try {
        await a2a?.close();
      } finally {
        try {
          await harness.close(context);
        } finally {
          await httpClosed;
        }
      }
    })();
  }
  try {
    const settings = { model, instructions: agent.instructions, maxTurns: agent.maxTurns };
    const conversation = await harness.root(context, { agent: settings });
    // Root options apply only when the conversation is created; refresh them on every start.
    await conversation.configure(settings, context);
    a2a = new A2AHandler({
      harness, conversation,
      card: { ...card(agent), url: `http://${host}:${agent.port}/a2a` },
    });
    harness.resume();
    server = createA2AServer(a2a, {
      token, extraRoutes: { '/': liteLLMTaskHandler(a2a) },
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(agent.port, host, resolve));
    console.log(`${agent.name} listening at http://${host}:${agent.port}/a2a`);
    return { close };
  } catch (error) {
    // Preserve the startup failure even if cleanup also fails.
    await close().catch(() => {});
    throw error;
  }
}
