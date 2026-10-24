import { spawn } from 'node:child_process';

export const localAuthUrl = port => `http://127.0.0.1:${port}/`;

// Return false only for a validated callback request, whose OAuth handling
// remains in auth.mjs. This module never exchanges codes or reads credentials.
export function handleAuthNavigation(req, res, { port, authorizationUrl }) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const reply = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
    return true;
  };
  if (req.headers.host !== `127.0.0.1:${port}`) return reply(403, 'Open this helper using its printed 127.0.0.1 address.');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return reply(405, 'This helper accepts GET requests only.');
  }
  let url;
  try { url = new URL(req.url, localAuthUrl(port)); } catch { return reply(400, 'Invalid local request.'); }
  if (url.origin !== new URL(localAuthUrl(port)).origin) return reply(403, 'The request must target this local helper.');
  if (url.pathname === '/auth/callback') return false;
  if (url.pathname === '/auth/start') {
    res.writeHead(302, { Location: authorizationUrl });
    res.end();
    return true;
  }
  if (url.pathname !== '/') return reply(404, 'Not found.');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Eunnei</title>
<style>body{font:18px/1.55 system-ui,sans-serif;background:#f4f3ee;color:#183754;margin:0;padding:8vh 24px}main{max-width:36rem;margin:auto}h1{font-size:2rem;line-height:1.2}a{display:inline-block;margin:1rem 0;background:#183754;color:white;padding:14px 22px;border-radius:6px;text-decoration:none}small{display:block;color:#526476}</style></head>
<body><main><p>A Bluer White Eunnei</p><h1>Connect your ChatGPT plan</h1><p>This local helper is ready. Continue to OpenAI to sign in and approve plan usage for your private office.</p><a href="/auth/start">Continue with ChatGPT</a><small>Keep the setup terminal open. After sign-in, your browser returns here. This helper expires after ten minutes.</small></main></body></html>`);
  return true;
}

export function launchAuthBrowser(url, { spawnImpl = spawn, platform = process.platform, report = console.log } = {}) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  let reported = false;
  const fallback = detail => {
    if (reported) return;
    reported = true;
    report(`The browser launcher ${detail}. Open ${url} in this computer's browser.`);
  };
  try {
    const child = spawnImpl(command, [url], { stdio: 'ignore' });
    child.on('error', () => fallback('could not start'));
    child.on('close', (code, signal) => {
      if (signal || (code !== null && code !== 0)) fallback('did not complete successfully');
    });
    child.unref();
    return child;
  } catch { fallback('could not start'); return null; }
}
