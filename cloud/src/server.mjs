import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';
import { defaultDataDir } from './storage.mjs';
import { TokenStore, InferenceClient, BridgeError } from './siwc.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon', '.ogg': 'audio/ogg' };
const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

export function createBridge({
  client, store, model = 'gpt-6-luna', staticDir = resolve('static'),
  username = 'michael', password = '', allowedOrigin = '', requestsPerHour = 60, requestsPerMinute = 6, now = Date.now,
} = {}) {
  let blocked = null, busy = false, successes = 0;
  let calls = [], catalog = null, catalogUntil = 0, catalogPromise = null;
  const root = resolve(staticDir);
  function currentBlock() {
    if (blocked?.until && now() >= blocked.until) blocked = null;
    return blocked;
  }
  function rememberBlock(error) {
    if ([401, 403].includes(error.status)) blocked = { error, until: null };
    else if (error.status === 429 && !error.code.startsWith('local_')) blocked = { error, until: now() + (error.retryAfter || 300) * 1000 };
  }
  function pacingError() {
    calls = calls.filter(t => now() - t < 3_600_000);
    const minute = calls.filter(t => now() - t < 60_000);
    if (calls.length >= requestsPerHour) return new BridgeError('local_hour_budget', 'The office is resting until its hourly quota resets', 429, Math.max(1, Math.ceil((calls[0] + 3_600_000 - now()) / 1000)));
    if (minute.length >= requestsPerMinute) return new BridgeError('local_minute_budget', 'The office is resting until its minute quota resets', 429, Math.max(1, Math.ceil((minute[0] + 60_000 - now()) / 1000)));
    return null;
  }
  async function verifiedModels() {
    if (catalog && now() < catalogUntil) return catalog;
    if (catalogPromise) return catalogPromise;
    catalogPromise = client.models().then(models => {
      catalog = models; catalogUntil = now() + 300_000;
      return models;
    }).finally(() => { catalogPromise = null; });
    return catalogPromise;
  }
  const remaining = block => block?.until ? Math.max(1, Math.ceil((block.until - now()) / 1000)) : null;
  const errorStatus = error => error.status === 429 ? 'quota' : [401, 403].includes(error.status) ? 'auth_required' : 'offline';
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    if (origin && allowedOrigin && origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!allowedOrigin || origin !== allowedOrigin) { res.writeHead(403); res.end(); return; }
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' }); res.end(); return;
    }
    if (password) {
      const auth = req.headers.authorization || '';
      let authenticated = false;
      if (auth.startsWith('Basic ')) authenticated = sameSecret(Buffer.from(auth.slice(6), 'base64').toString('utf8'), `${username}:${password}`);
      else if (auth.startsWith('Bearer ')) authenticated = sameSecret(auth.slice(7), password);
      if (!authenticated) { res.setHeader('WWW-Authenticate', 'Basic realm="Eunnei private office"'); json(res, 401, { available: false, model, status: 'auth_required', error: 'Private office sign-in required', code: 'office_auth_required' }); return; }
    }
    const url = new URL(req.url, 'http://bridge.invalid');
    // Cross-origin API access is opt-in for one exact private preview origin.
    if (req.method === 'POST' && origin) {
      const requestHost = req.headers.host;
      const sameOrigin = [ `http://${requestHost}`, `https://${requestHost}` ].includes(origin);
      if (!sameOrigin && origin !== allowedOrigin) { json(res, 403, { error: 'Origin not allowed' }); return; }
    }
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') {
        let error = null;
        const connection = await store.status();
        const block = currentBlock();
        if (!connection.connected) error = new BridgeError('sign_in_required', 'Connect your ChatGPT plan with the local auth helper', 401);
        else if (block) error = block.error;
        else error = pacingError();
        if (!error) {
          try {
            const models = await verifiedModels();
            if (!models.some(m => m.slug === model)) error = new BridgeError('model_unavailable', 'The selected model is not listed for this ChatGPT plan', 403);
          } catch (cause) { error = cause instanceof BridgeError ? cause : new BridgeError('catalog_unavailable', 'Could not verify ChatGPT plan model access'); }
          if (error) rememberBlock(error);
        }
        json(res, 200, { available: !error, model, status: error ? errorStatus(error) : successes ? 'ready' : 'model_verified', credential_present: connection.connected, verified_inference: successes > 0, error: error?.message || null, code: error?.code || null, retry_after: remaining(currentBlock()) || error?.retryAfter || null, billing: 'chatgpt_plan', successful_requests: successes }); return;
      }
      if (url.pathname === '/api/tags' && req.method === 'GET') {
        json(res, 200, { models: [{ name: model, model, modified_at: '2026-10-24T00:00:00Z', size: 0, details: { family: 'chatgpt-plan' } }] }); return;
      }
      if (url.pathname === '/api/models' && req.method === 'GET') { if (currentBlock()) throw currentBlock().error; json(res, 200, { models: await verifiedModels() }); return; }
      if (url.pathname === '/api/resume' && req.method === 'POST') {
        if (currentBlock()?.error.status === 429) { json(res, 429, { resumed: false, status: 'quota', retry_after: remaining(blocked) }); return; }
        blocked = null; catalog = null; json(res, 200, { resumed: true }); return;
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        if (currentBlock()) { const error = currentBlock().error; error.retryAfter = remaining(blocked); throw error; }
        if (busy) throw new BridgeError('busy', 'Another scene is being generated; retry when it completes', 409);
        if (pacingError()) throw pacingError();
        if (!String(req.headers['content-type']).startsWith('application/json')) throw new BridgeError('invalid_content_type', 'Send application/json', 400);
        let text = '';
        for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 256_000) throw new BridgeError('request_too_large', 'Scene request is too large', 413); }
        let body; try { body = JSON.parse(text); } catch { throw new BridgeError('invalid_json', 'Request JSON is malformed', 400); }
        if (busy) throw new BridgeError('busy', 'Another scene is being generated; retry when it completes', 409);
        if (pacingError()) throw pacingError();
        busy = true; calls.push(now());
        try {
          const started = Date.now();
          const result = await client.chat(body);
          successes++;
          const envelope = { model, created_at: new Date().toISOString(), message: { role: 'assistant', content: result.text }, done: true, done_reason: 'stop', total_duration: (Date.now() - started) * 1_000_000, prompt_eval_count: result.usage?.input_tokens || 0, eval_count: result.usage?.output_tokens || 0 };
          // Buffer upstream SSE until terminal success. A late quota failure must
          // never appear as valid partial dialogue to the simulation.
          if (body.stream === true) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' }); res.end(`${JSON.stringify(envelope)}\n`); }
          else json(res, 200, envelope);
        } finally { busy = false; }
        return;
      }
      if (url.pathname.startsWith('/api/')) { json(res, 404, { error: 'Endpoint not found' }); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'Method not allowed' }); return; }
      let relative;
      try { relative = decodeURIComponent(url.pathname); } catch { json(res, 400, { error: 'Invalid path' }); return; }
      const file = resolve(root, `.${relative === '/' ? '/index.html' : relative}`);
      if (!file.startsWith(root + sep)) { json(res, 403, { error: 'Path not allowed' }); return; }
      let info, canonicalFile;
      try {
        canonicalFile = await realpath(file);
        const canonicalRoot = await realpath(root);
        if (!canonicalFile.startsWith(canonicalRoot + sep)) { json(res, 403, { error: 'Path not allowed' }); return; }
        info = await stat(canonicalFile);
      } catch { json(res, 404, { error: 'Static export not found. Copy the Godot web export into static/.' }); return; }
      if (!info.isFile()) { json(res, 404, { error: 'Not found' }); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
      if (req.method === 'HEAD') res.end(); else createReadStream(canonicalFile).pipe(res);
    } catch (error) {
      const safe = error instanceof BridgeError ? error : new BridgeError('bridge_error', 'The office bridge could not complete this request');
      // Never extend an existing cooldown when clients poll while it is active.
      if (!currentBlock()) rememberBlock(safe);
      const retryAfter = remaining(currentBlock()) || safe.retryAfter;
      if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
      if (!res.headersSent) json(res, safe.status, { error: safe.message, code: safe.code, status: errorStatus(safe), paused: !!currentBlock(), retry_after: retryAfter }); else res.end();
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const password = process.env.APP_PASSWORD || '';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && password.length < 24) {
    console.error('Public bind requires APP_PASSWORD of at least 24 characters. Put the service behind HTTPS.'); process.exit(1);
  }
  const model = process.env.EUNNEI_MODEL || 'gpt-6-luna';
  const store = new TokenStore(defaultDataDir);
  const client = new InferenceClient(store, { model });
  const requestsPerHour = Number(process.env.EUNNEI_REQUESTS_PER_HOUR || 60);
  const requestsPerMinute = Number(process.env.EUNNEI_REQUESTS_PER_MINUTE || 6);
  if (!Number.isInteger(requestsPerHour) || requestsPerHour < 1 || requestsPerHour > 3600) throw new Error('Invalid hourly request budget');
  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 60) throw new Error('Invalid minute request budget');
  const server = createBridge({ client, store, model, password, username: process.env.APP_USERNAME || 'michael', allowedOrigin: process.env.EUNNEI_ALLOWED_ORIGIN || '', staticDir: process.env.EUNNEI_STATIC_DIR || resolve('static'), requestsPerHour, requestsPerMinute });
  server.listen(Number(process.env.PORT || 8787), host, () => console.log(`Eunnei bridge listening on ${host}:${process.env.PORT || 8787}; ChatGPT plan only.`));
}
