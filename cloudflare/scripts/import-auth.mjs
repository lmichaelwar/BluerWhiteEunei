import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This helper is run explicitly in the owner's private terminal. Never accept
// OAuth tokens or private keys as command-line flags, which expose them in ps.
export async function importCredentials({ url, file, bridgeKey, adminKey, accessClientId, accessClientSecret, fetchImpl = fetch, readFileImpl = readFile }) {
  let origin;
  try { origin = new URL(url); } catch { throw new Error('Provide the private office HTTPS origin'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Provide an HTTPS origin without a path, credentials, query or fragment');
  if (typeof bridgeKey !== 'string' || bridgeKey.length < 24 || typeof adminKey !== 'string' || adminKey.length < 24 || bridgeKey === adminKey) throw new Error('Set distinct BRIDGE_KEY and ADMIN_KEY values of at least 24 characters in this private terminal');
  const hasAccessId = typeof accessClientId === 'string' && accessClientId.length > 0;
  const hasAccessSecret = typeof accessClientSecret === 'string' && accessClientSecret.length > 0;
  if (hasAccessId !== hasAccessSecret) throw new Error('Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither');
  if (!file) throw new Error('Provide the explicit protected credential file path');
  const raw = await readFileImpl(resolve(file), 'utf8');
  if (Buffer.byteLength(raw) > 256_000) throw new Error('Credential record exceeds the allowed size');
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error('The credential file is not valid JSON'); }
  if (!record || typeof record !== 'object' || !record.access_token || !record.refresh_token || !record.client_id || record.client_id === 'dynamic_agent_client' || !record.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('The file is not a complete Eunnei ChatGPT plan registration');
  let response;
  try {
    response = await fetchImpl(new URL('/admin/import', origin), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeKey}`, 'X-Eunnei-Admin-Key': adminKey, 'Content-Type': 'application/json',
        ...(hasAccessId ? { 'CF-Access-Client-Id': accessClientId, 'CF-Access-Client-Secret': accessClientSecret } : {}),
      },
      body: JSON.stringify(record),
      // Never forward credentials to a redirect destination.
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new Error('Credential import could not reach the private HTTPS endpoint; nothing was printed'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Credential import was rejected (HTTP ${response.status}); check private access, import key and server status`);
  }
  await response.body?.cancel();
  return { imported: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || !args.includes('--url') || !args.includes('--file')) throw new Error('Usage: node scripts/import-auth.mjs --url https://private-host --file /protected/credentials.json');
    const get = name => args[args.indexOf(name) + 1];
    await importCredentials({ url: get('--url'), file: get('--file'), bridgeKey: process.env.BRIDGE_KEY, adminKey: process.env.ADMIN_KEY, accessClientId: process.env.CF_ACCESS_CLIENT_ID, accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET });
    console.log('Protected registration imported. Cloudflare now owns refreshes; no inference was requested.');
  } catch (error) {
    // File errors can contain private paths, so avoid printing arbitrary errors.
    console.error(error.code ? 'Could not read the protected credential file.' : error.message);
    process.exitCode = 1;
  }
}
