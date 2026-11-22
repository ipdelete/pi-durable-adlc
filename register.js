// Operator step: publish Floe's backlog agent in the fleet's LiteLLM A2A gateway, or withdraw it.
// Uses LiteLLM's administrative key, which the running agent never reads.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { liteLLMRegistry } from 'pi-durable-a2a/litellm';
import { directory, identity, listenerToken, port, tailscaleAddress } from './backlog.js';

const registry = liteLLMRegistry({
  url: process.env.LITELLM_URL ?? 'http://bigbertha:4000',
  adminKeyFile: process.env.LITELLM_ADMIN_KEY_FILE ?? join(homedir(), '.config/pi-a2a/admin-key'),
  teamId: process.env.LITELLM_TEAM_ID ?? '045b989a-4ed3-4492-b7a4-ca1884cd876f',
  grantLockDirectory: join(directory, 'grant-lock'),
});
const agent = { ...identity, listener: `http://${tailscaleAddress()}:${port}`, token: listenerToken() };
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
