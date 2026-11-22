// Operator step: publish an agent in the fleet's LiteLLM A2A gateway, or withdraw it.
// Uses LiteLLM's administrative key, which the running agents never read.
//   node register.js <intake|investigator> [--withdraw]
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { liteLLMRegistry } from 'pi-durable-a2a/litellm';
import { card, listenerToken, stateDirectory, tailscaleAddress } from './agent-host/index.js';
import { identity as intake } from './agents/intake/index.js';
import { identity as investigator } from './agents/investigator/index.js';

const identities = { intake, investigator };
const identity = identities[process.argv.slice(2).find((arg) => !arg.startsWith('-'))];
if (!identity) throw new Error(`Usage: node register.js <${Object.keys(identities).join('|')}> [--withdraw]`);

const directory = stateDirectory(identity);
const registry = liteLLMRegistry({
  url: process.env.LITELLM_URL ?? 'http://bigbertha:4000',
  adminKeyFile: process.env.LITELLM_ADMIN_KEY_FILE ?? join(homedir(), '.config/pi-a2a/admin-key'),
  teamId: process.env.LITELLM_TEAM_ID ?? '045b989a-4ed3-4492-b7a4-ca1884cd876f',
  // Shared by all agents here: grants on the same team must be updated one at a time.
  grantLockDirectory: join(dirname(directory), 'grant-lock'),
});
const agent = { ...card(identity), listener: `http://${tailscaleAddress()}:${identity.port}`, token: listenerToken(directory) };
const file = join(directory, 'registration.json');
let saved;
try {
  saved = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (process.argv.includes('--withdraw')) {
  await registry.withdraw(agent, saved);
  writeFileSync(file, 'null\n', { mode: 0o600 });
  console.log(`Withdrew ${agent.name} from the gateway`);
} else {
  const registration = await registry.publish(agent, saved ?? undefined, (value) => {
    writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  });
  console.log(`Published ${registration.name} (${registration.id}) for ${agent.listener}`);
}
