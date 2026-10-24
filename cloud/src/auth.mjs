import { createServer } from 'node:http';
import { join } from 'node:path';
import { defaultDataDir, hostId, readJSON, writeJSON } from './storage.mjs';
import { makeAuthorization, exchangeCode, BridgeError } from './siwc.mjs';
import { handleAuthNavigation, launchAuthBrowser, localAuthUrl } from './auth-ui.mjs';

// Run on the computer where Michael opens the browser, not on the cloud VM.
const dataDir = defaultDataDir;
const port = Number(process.env.EUNNEI_AUTH_PORT || 1455);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose an unprivileged auth port');
const host = await hostId(dataDir);
const previous = await readJSON(join(dataDir, 'credentials.json'));
const attempt = makeAuthorization({ host, clientId: previous?.client_id, port });
let processing = false;
const server = createServer(async (req, res) => {
  if (handleAuthNavigation(req, res, { port, authorizationUrl: attempt.url })) return;
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }
  if (processing) { res.writeHead(409); res.end('Sign-in already being processed'); return; }
  // Ignore unrelated requests without consuming the pending attempt.
  if (url.searchParams.get('state') !== attempt.state) { res.writeHead(400); res.end('Sign-in state did not match'); return; }
  processing = true;
  try {
    const record = await exchangeCode({ attempt, callback: url.searchParams });
    if (previous && (record.subject !== previous.subject || record.client_id !== previous.client_id)) throw new BridgeError('identity_mismatch', 'This sign-in does not match the saved registration', 401);
    await writeJSON(join(dataDir, 'credentials.json'), { ...record, ext_agent_host_id: host });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end('ChatGPT plan connected. You may close this window. Return to the setup terminal.');
    console.log('ChatGPT plan connected. Protected credentials saved; no inference has run.');
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(error instanceof BridgeError ? error.message : 'Sign-in failed. Retry from the terminal.');
    console.error(error instanceof BridgeError ? `${error.code}: ${error.message}` : 'Sign-in failed; no credentials saved.');
    process.exitCode = 1;
  } finally { clearTimeout(timeout); server.close(); }
});
const timeout = setTimeout(() => { console.error('Sign-in timed out after ten minutes; rerun npm run auth.'); process.exitCode = 1; server.close(); }, 600_000);
server.on('error', () => { clearTimeout(timeout); console.error('Could not bind local callback; choose another EUNNEI_AUTH_PORT.'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  const url = localAuthUrl(port);
  console.log(`Eunnei sign-in helper is ready: ${url}`);
  console.log('Open that local address in this computer’s browser if no window appears. Keep this terminal open.');
  launchAuthBrowser(url);
});
