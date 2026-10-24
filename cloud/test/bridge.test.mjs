import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { makeAuthorization, exchangeCode, validateIdToken, TokenStore, InferenceClient, ollamaToResponses, readResponseStream, BridgeError, AUTH_ORIGIN, REQUIRED_SCOPE } from '../src/siwc.mjs';
import { readJSON, writeJSON, hostId } from '../src/storage.mjs';
import { createBridge } from '../src/server.mjs';

const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const sse = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const goodTokenRecord = { access_token: 'mock-access', refresh_token: 'mock-refresh', client_id: 'oaiapp_mock', subject: 'mock-user', scopes: [REQUIRED_SCOPE], expires_at: Date.now() + 3_600_000 };

async function tempStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'eunnei-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' };
function jwt(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: AUTH_ORIGIN, aud: 'oaiapp_mock', sub: 'mock-user', exp: Math.floor(Date.now() / 1000) + 3600, nonce: 'mock-nonce', ...overrides })).toString('base64url');
  return `${header}.${payload}.${sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}
const identityFetch = async url => url.endsWith('openid-configuration') ? response({ issuer: AUTH_ORIGIN, jwks_uri: `${AUTH_ORIGIN}/test-jwks` }) : response({ keys: [jwk] });

test('authorization uses loopback PKCE, actual registration, and plan scopes', () => {
  const attempt = makeAuthorization({ host: 'urn:uuid:test', port: 5544 });
  const url = new URL(attempt.url);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5544/auth/callback');
  assert.ok(url.searchParams.get('scope').includes(REQUIRED_SCOPE));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const returning = new URL(makeAuthorization({ host: 'urn:uuid:test', clientId: 'saved-id' }).url);
  assert.equal(returning.searchParams.get('client_id'), 'saved-id');
  assert.equal(returning.searchParams.has('agent_name_hint'), false);
});

test('ID validation verifies signature and nonce; rejects expired and wrong-audience tokens', async () => {
  const options = { clientId: 'oaiapp_mock', nonce: 'mock-nonce', fetchImpl: identityFetch };
  assert.equal((await validateIdToken(jwt(), options)).sub, 'mock-user');
  for (const changes of [{ nonce: 'other' }, { exp: 1 }, { aud: 'other' }]) await assert.rejects(validateIdToken(jwt(changes), options), { code: 'invalid_identity' });
  const tampered = jwt().split('.'); tampered[1] = Buffer.from(JSON.stringify({ iss: AUTH_ORIGIN, aud: 'oaiapp_mock', sub: 'intruder', exp: Date.now() / 1000 + 9000, nonce: 'mock-nonce' })).toString('base64url');
  await assert.rejects(validateIdToken(tampered.join('.'), options), { code: 'invalid_identity' });
});

test('code exchange uses issued client, rejects scope absence and invalid state', async () => {
  const attempt = { state: 'mock-state', nonce: 'mock-nonce', verifier: 'mock-verifier', redirectUri: 'http://127.0.0.1:1455/auth/callback' };
  const callback = new URLSearchParams({ state: 'mock-state', client_id: 'oaiapp_mock', code: 'mock-code' });
  let sent;
  const fetchImpl = async (url, options) => {
    if (!url.endsWith('/oauth/token')) return identityFetch(url);
    sent = options.body;
    return response({ access_token: 'mock-access', refresh_token: 'mock-refresh', id_token: jwt(), scope: REQUIRED_SCOPE, expires_in: 3600 });
  };
  assert.equal((await exchangeCode({ attempt, callback, fetchImpl })).client_id, 'oaiapp_mock');
  assert.equal(sent.get('client_id'), 'oaiapp_mock');
  assert.equal(sent.get('code_verifier'), 'mock-verifier');
  await assert.rejects(exchangeCode({ attempt, callback: new URLSearchParams({ state: 'wrong' }), fetchImpl }), { code: 'invalid_state' });
  const missingScope = async url => url.endsWith('/oauth/token') ? response({ id_token: jwt(), access_token: 'mock', refresh_token: 'mock', scope: 'openid' }) : identityFetch(url);
  await assert.rejects(exchangeCode({ attempt, callback, fetchImpl: missingScope }), { code: 'plan_not_enabled' });
});

test('protected storage preserves a stable host and Unix owner-only mode', async t => {
  const dir = await tempStore(t);
  assert.equal(await hostId(dir), await hostId(dir));
  await writeJSON(join(dir, 'credentials.json'), goodTokenRecord);
  if (process.platform === 'win32') t.diagnostic('Windows protection uses the parent directory DACL, verified separately; POSIX mode bits do not represent Windows ACLs.');
  else assert.equal((await stat(join(dir, 'credentials.json'))).mode & 0o777, 0o600);
});

test('concurrent refreshes rotate once and atomically retain replacement token', async t => {
  const dir = await tempStore(t);
  await writeJSON(join(dir, 'credentials.json'), { ...goodTokenRecord, expires_at: 0 });
  let refreshes = 0;
  const store = new TokenStore(dir, { fetchImpl: async (_url, options) => {
    refreshes++;
    assert.equal(options.body.get('client_id'), 'oaiapp_mock');
    await new Promise(resolve => setTimeout(resolve, 15));
    return response({ access_token: 'mock-next', refresh_token: 'mock-next-refresh', expires_in: 3600, scope: REQUIRED_SCOPE });
  } });
  assert.deepEqual(await Promise.all([store.accessToken(), store.accessToken(), store.accessToken()]), ['mock-next', 'mock-next', 'mock-next']);
  assert.equal(refreshes, 1);
  assert.equal((await readJSON(store.path)).refresh_token, 'mock-next-refresh');
});

test('Ollama translation drops incompatible fields and converts system prompts', () => {
  const result = ollamaToResponses({ messages: [{ role: 'system', content: 'Office premise' }, { role: 'user', content: 'Start' }], format: 'json', options: { temperature: 1.5, num_predict: 64 }, temperature: 1.5 }, 'gpt-6-luna');
  assert.equal(result.stream, true); assert.equal(result.store, false);
  assert.equal(result.temperature, undefined); assert.equal(result.max_output_tokens, undefined);
  assert.equal(result.input[0].role, 'user'); assert.match(result.instructions, /Office premise/);
  const schema = { type: 'object', required: ['line'], properties: { line: { type: 'string' } } };
  const structured = ollamaToResponses({ messages: [{ role: 'user', content: 'Give one sentence.' }], format: schema }, 'gpt-6-luna');
  assert.ok(structured.instructions.includes(JSON.stringify(schema)));
});

test('SSE requires terminal completion and returns completed usage', async () => {
  const result = await readResponseStream(sse([{ type: 'response.output_text.delta', delta: '{"line":"Blue."}' }, { type: 'response.completed', response: { status: 'completed', usage: { output_tokens: 9 } } }]));
  assert.equal(result.text, '{"line":"Blue."}'); assert.equal(result.usage.output_tokens, 9);
  await assert.rejects(readResponseStream(sse([{ type: 'response.output_text.delta', delta: 'partial' }])), { code: 'interrupted_stream' });
});

test('late quota failures discard partial dialogue', async () => {
  await assert.rejects(readResponseStream(sse([{ type: 'response.output_text.delta', delta: 'Apparently successful dialogue' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), { code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
});

test('SSE parser supports split CRLF events and terminal output fallback', async () => {
  const data = `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: 'Blue.' }] }] } })}\r\n\r\n`;
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(controller) { for (const char of data) controller.enqueue(encoder.encode(char)); controller.close(); } });
  assert.equal((await readResponseStream(new Response(body))).text, 'Blue.');
});

test('401 retries refresh only once and never uses an API-key fallback', async () => {
  const calls = [];
  const store = { accessToken: async force => { calls.push(force); return force ? 'mock-new' : 'mock-old'; } };
  let requests = 0;
  const client = new InferenceClient(store, { fetchImpl: async (_url, options) => { requests++; assert.match(options.headers.Authorization, /^Bearer mock-/); return new Response('', { status: 401 }); } });
  await assert.rejects(client.chat({ messages: [{ role: 'user', content: 'Hi' }] }), { code: 'plan_access_denied' });
  assert.equal(requests, 2); assert.deepEqual(calls, [undefined, true]);
});

test('HTTP bridge protects endpoints, returns Ollama envelope, and pauses after quota error', async t => {
  let fail = false;
  const server = createBridge({ store: { status: async () => ({ connected: true }) }, client: { chat: async () => { if (fail) throw new BridgeError('usage_limit', 'Limit', 429); return { text: '{"line":"Blue."}', usage: null }; } }, password: 'test-private-password', allowedOrigin: 'https://private.example' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  const headers = { Authorization: 'Bearer test-private-password', 'Content-Type': 'application/json' };
  const chat = () => fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }], stream: false }) });
  assert.equal((await (await chat()).json()).message.content, '{"line":"Blue."}');
  fail = true; assert.equal((await chat()).status, 429);
  const health = await (await fetch(`${base}/api/health`, { headers })).json();
  assert.equal(health.available, false); assert.equal(health.status, 'quota'); assert.equal(health.retry_after, 300);
  const denied = await fetch(`${base}/api/resume`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
});

test('health validates Luna in the current account catalog and caches proof, not stored credentials', async t => {
  let connected = false, catalogs = 0;
  const server = createBridge({ store: { status: async () => ({ connected }) }, client: { models: async () => { catalogs++; return [{ slug: 'gpt-6-luna' }]; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const health = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
  assert.equal((await health()).available, false); assert.equal(catalogs, 0);
  connected = true;
  const verified = await health();
  assert.equal(verified.available, true); assert.equal(verified.status, 'model_verified'); assert.equal(verified.verified_inference, false);
  await health(); assert.equal(catalogs, 1);
});

test('minute and hour pacing auto-clear and do not require manual resume', async t => {
  let clock = 100_000, chats = 0;
  const server = createBridge({ now: () => clock, requestsPerMinute: 1, requestsPerHour: 2, store: { status: async () => ({ connected: true }) }, client: { chat: async () => { chats++; return { text: '{}' }; }, models: async () => [{ slug: 'gpt-6-luna' }] } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = () => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }) });
  assert.equal((await chat()).status, 200);
  const limited = await chat(); assert.equal(limited.status, 429); assert.equal((await limited.json()).retry_after, 60); assert.equal(chats, 1);
  clock += 60_000; assert.equal((await chat()).status, 200);
  const hourLimit = await chat(); assert.equal(hourLimit.status, 429); assert.equal((await hourLimit.json()).code, 'local_hour_budget');
  clock += 3_600_000; assert.equal((await chat()).status, 200); assert.equal(chats, 3);
});

test('upstream Retry-After produces a bounded cooldown and no automatic inference retries', async t => {
  let clock = 100_000, chats = 0;
  const server = createBridge({ now: () => clock, store: { status: async () => ({ connected: true }) }, client: { chat: async () => { chats++; if (chats === 1) throw new BridgeError('usage_limit', 'Quota', 429, 120); return { text: '{}' }; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = () => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }) });
  assert.equal((await chat()).status, 429); clock += 30_000;
  assert.equal((await (await chat()).json()).retry_after, 90); assert.equal(chats, 1);
  clock += 90_000; assert.equal((await chat()).status, 200); assert.equal(chats, 2);
});
