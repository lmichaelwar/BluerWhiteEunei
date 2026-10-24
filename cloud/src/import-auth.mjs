import { resolve, join } from 'node:path';
import { defaultDataDir, hostId, readJSON, writeJSON } from './storage.mjs';
import { REQUIRED_SCOPE } from './siwc.mjs';

const sourcePath = process.argv[2];
if (!sourcePath) { console.error('Usage: npm run import-auth -- /secure/path/credentials.json'); process.exit(1); }
const source = await readJSON(resolve(sourcePath));
if (!source?.client_id || source.client_id === 'dynamic_agent_client' || !source.access_token || !source.refresh_token || !source.subject || !source.scopes?.includes(REQUIRED_SCOPE)) {
  console.error('Not a complete SIWC plan-usage credential record. No import performed.'); process.exit(1);
}
const host = await hostId(defaultDataDir);
await writeJSON(join(defaultDataDir, 'credentials.json'), { ...source, ext_agent_host_id: host });
console.log('Protected credentials imported; VM host identity retained. This VM must own future refreshes.');
