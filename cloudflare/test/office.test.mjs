import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableTokenStore, OfficeSessionCore, validateCredentialRecord } from '../src/office.mjs';

const tokenRecord = {
  access_token: 'mock-access', refresh_token: 'mock-refresh', client_id: 'oaiapp_mock', subject: 'mock-owner',
  issuer: 'https://auth.openai.com', scopes: ['chatgpt.tokens.use.direct'], expires_at: 3_700_000,
};
class FakeStorage {
  constructor() { this.data = new Map(); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
}
const request = (path, body) => new Request(`https://office.example${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const chatBody = { messages: [{ role: 'user', content: 'Say something blue.' }], format: { type: 'object', required: ['line'], properties: { line: { type: 'string' } } }, stream: false };
const catalog = [{ slug: 'gpt-6-luna', display_name: 'Luna' }];
const goodClient = () => ({ models: async () => catalog, chat: async () => ({ text: '{"line":"Blue."}' }) });
async function core(storage = new FakeStorage(), options = {}, env = {}) {
  const instance = new OfficeSessionCore({ storage, blockConcurrencyWhile: fn => fn() }, env, { now: () => 100_000, client: goodClient(), ...options });
  await instance.ready;
  return instance;
}

test('import validates plan credentials, allowlists fields and preserves a separate durable host identity', async () => {
  assert.throws(() => validateCredentialRecord({ ...tokenRecord, scopes: ['openid'] }), { code: 'invalid_credentials' });
  assert.throws(() => validateCredentialRecord({ ...tokenRecord, issuer: 'https://unrelated.example' }), { code: 'invalid_credentials' });
  assert.throws(() => validateCredentialRecord({ ...tokenRecord, expires_at: Infinity }), { code: 'invalid_credentials' });
  assert.equal(validateCredentialRecord({ ...tokenRecord, opaque_secret: 'discard' }).opaque_secret, undefined);
  const storage = new FakeStorage();
  const first = await core(storage);
  const imported = await (await first.fetch(request('/admin/import', { ...tokenRecord, ext_agent_host_id: 'urn:uuid:laptop' }))).json();
  assert.equal(imported.imported, true); assert.notEqual(imported.host_id, 'urn:uuid:laptop');
  const next = await core(storage);
  assert.equal(next.state.hostId, imported.host_id);
  assert.equal((await storage.get('credentials')).ext_agent_host_id, imported.host_id);
  assert.equal((await next.fetch(request('/admin/import', { ...tokenRecord, subject: 'other-owner' }))).status, 409);
});

test('concurrent refresh rotates once and a replacement instance reads the committed token', async () => {
  const storage = new FakeStorage();
  await storage.put('credentials', { ...tokenRecord, expires_at: 1 });
  let refreshes = 0;
  const fetchImpl = async (_url, init) => {
    refreshes++;
    assert.equal(init.body.get('refresh_token'), 'mock-refresh');
    await Promise.resolve();
    return Response.json({ access_token: 'mock-rotated', refresh_token: 'mock-refresh-rotated', expires_in: 3600 });
  };
  const store = new DurableTokenStore(storage, { fetchImpl, now: () => 100_000 });
  assert.deepEqual(await Promise.all([store.accessToken(), store.accessToken(), store.accessToken()]), ['mock-rotated', 'mock-rotated', 'mock-rotated']);
  assert.equal(refreshes, 1);
  assert.equal((await storage.get('credentials')).refresh_token, 'mock-refresh-rotated');
  const replacement = new DurableTokenStore(storage, { fetchImpl, now: () => 100_000 });
  assert.equal(await replacement.accessToken(), 'mock-rotated'); assert.equal(refreshes, 1);
});

test('terminal OAuth refresh errors require reconnect and preserve diagnostics without token leakage', async () => {
  const storage = new FakeStorage();
  await storage.put('credentials', { ...tokenRecord, expires_at: 1 });
  const store = new DurableTokenStore(storage, { now: () => 100_000, fetchImpl: async () => Response.json({ error: 'invalid_grant', error_description: 'mock-refresh should never leak' }, { status: 400 }) });
  await assert.rejects(store.accessToken(), error => {
    assert.equal(error.status, 401); assert.doesNotMatch(error.message, /mock-refresh/); return true;
  });
  assert.equal((await storage.get('credentials')).refresh_token, 'mock-refresh');
});

test('health requires account model discovery and distinguishes it from completed inference', async () => {
  const storage = new FakeStorage(); let modelCalls = 0;
  const instance = await core(storage, { client: { ...goodClient(), models: async () => { modelCalls++; return catalog; } } });
  assert.equal((await (await instance.fetch(request('/api/health'))).json()).available, false); assert.equal(modelCalls, 0);
  await instance.fetch(request('/admin/import', tokenRecord));
  const health = await (await instance.fetch(request('/api/health'))).json();
  assert.equal(health.available, true); assert.equal(health.status, 'model_verified'); assert.equal(health.verified_inference, false);
  await instance.fetch(request('/api/health')); assert.equal(modelCalls, 1);
  const generated = await (await instance.fetch(request('/api/chat', chatBody))).json();
  assert.equal(generated.message.content, '{"line":"Blue."}');
  assert.equal((await (await instance.fetch(request('/api/health'))).json()).verified_inference, true);
  await instance.fetch(request('/admin/import', tokenRecord));
  assert.equal((await (await instance.fetch(request('/api/health'))).json()).verified_inference, false);
});

test('only one inference runs; an active request and its persisted lease block session replacement', async () => {
  const storage = new FakeStorage(); await storage.put('credentials', tokenRecord);
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const instance = await core(storage, { client: { models: async () => catalog, chat: async () => { entered(); await waiting; return { text: '{}' }; } } });
  const first = instance.fetch(request('/api/chat', chatBody));
  await started;
  assert.equal((await instance.fetch(request('/api/chat', chatBody))).status, 409);
  assert.equal((await instance.fetch(request('/admin/import', tokenRecord))).status, 409);
  const restarted = await core(storage);
  assert.equal((await restarted.fetch(request('/api/chat', chatBody))).status, 409);
  finish(); assert.equal((await first).status, 200);
  assert.equal((await storage.get('state')).leaseUntil, 0);
});

test('minute and hour budgets survive restart and recover automatically', async () => {
  let clock = 100_000;
  const storage = new FakeStorage(); await storage.put('credentials', tokenRecord);
  const env = { EUNNEI_REQUESTS_PER_MINUTE: 1, EUNNEI_REQUESTS_PER_HOUR: 2 };
  const first = await core(storage, { now: () => clock }, env);
  assert.equal((await first.fetch(request('/api/chat', chatBody))).status, 200);
  const next = await core(storage, { now: () => clock }, env);
  const minute = await next.fetch(request('/api/chat', chatBody));
  assert.equal(minute.status, 429); assert.equal((await minute.json()).retry_after, 60);
  clock += 60_000; assert.equal((await next.fetch(request('/api/chat', chatBody))).status, 200);
  assert.equal((await (await next.fetch(request('/api/chat', chatBody))).json()).code, 'local_hour_budget');
  clock += 3_600_000; assert.equal((await next.fetch(request('/api/chat', chatBody))).status, 200);
});

test('late upstream quota failure discards text and persists cooldown across restart', async () => {
  const storage = new FakeStorage(); await storage.put('credentials', tokenRecord);
  let requests = 0;
  const fetchImpl = async url => {
    requests++;
    if (String(url).endsWith('/models')) return Response.json({ models: [{ ...catalog[0], visibility: 'list' }] });
    const events = [{ type: 'response.output_text.delta', delta: '{"line":"Never commit this."}' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream', 'Retry-After': '120' } });
  };
  const first = await core(storage, { client: undefined, fetchImpl });
  const failed = await first.fetch(request('/api/chat', chatBody));
  assert.equal(failed.status, 429);
  const body = await failed.json(); assert.equal(body.message, undefined); assert.doesNotMatch(JSON.stringify(body), /Never commit/); assert.equal(body.retry_after, 120);
  const before = requests;
  const restarted = await core(storage, { client: undefined, fetchImpl });
  const health = await (await restarted.fetch(request('/api/health'))).json();
  assert.equal(health.status, 'quota'); assert.equal(health.available, false); assert.equal(requests, before);
  assert.equal((await restarted.fetch(request('/api/resume', {}))).status, 429);
});

test('scene cadence survives restart without treating healthy plan access as quota exhaustion', async () => {
  let clock = 100_000;
  const storage = new FakeStorage(); await storage.put('credentials', tokenRecord);
  const env = { EUNNEI_MIN_REQUEST_INTERVAL_SECONDS: 65 };
  const first = await core(storage, { now: () => clock }, env);
  assert.equal((await first.fetch(request('/api/chat', chatBody))).status, 200);
  const next = await core(storage, { now: () => clock }, env);
  const health = await (await next.fetch(request('/api/health'))).json();
  assert.equal(health.available, true); assert.equal(health.next_request_after, 65);
  const paused = await next.fetch(request('/api/chat', chatBody));
  assert.equal(paused.status, 429);
  assert.deepEqual(await paused.json(), { available: false, error: 'The next Luna scene is being paced by the office', code: 'local_scene_pacing', status: 'local_limit', paused: false, retry_after: 65 });
  assert.equal(next.state.calls.length, 1);
  clock += 65_000;
  assert.equal((await next.fetch(request('/api/chat', chatBody))).status, 200);
});

test('hourly office limit is labeled separately from the upstream plan quota', async () => {
  const storage = new FakeStorage(); await storage.put('credentials', tokenRecord);
  const instance = await core(storage, {}, { EUNNEI_REQUESTS_PER_HOUR: 1 });
  await instance.fetch(request('/api/chat', chatBody));
  const health = await (await instance.fetch(request('/api/health'))).json();
  assert.equal(health.status, 'local_limit'); assert.equal(health.code, 'local_hour_budget');
  assert.equal(health.retry_after, 3600);
});

test('import cannot race an in-flight refresh and overwrite its replacement token', async () => {
  const storage = new FakeStorage(); await storage.put('credentials', { ...tokenRecord, expires_at: 1 });
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const instance = await core(storage, { fetchImpl: async () => { entered(); await waiting; return Response.json({ access_token: 'mock-new', refresh_token: 'mock-new-refresh', expires_in: 3600 }); } });
  const refreshing = instance.store.accessToken(); await started;
  assert.equal((await instance.fetch(request('/admin/import', tokenRecord))).status, 409);
  finish(); await refreshing;
  assert.equal((await storage.get('credentials')).refresh_token, 'mock-new-refresh');
});
