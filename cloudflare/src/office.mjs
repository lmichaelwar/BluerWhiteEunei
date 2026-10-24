import { randomUUID } from 'node:crypto';
import { API_ORIGIN, AUTH_ORIGIN, TOKEN_URL, REQUIRED_SCOPE, BridgeError, InferenceClient, retryAfterSeconds, ollamaToResponses } from '../../cloud/src/protocol.mjs';
import { jsonResponse } from './gateway.mjs';

const boundedString = (value, max = 32_768) => typeof value === 'string' && value.length > 0 && value.length <= max;

// Import accepts the local helper's record, never a generic API key. Return a
// minimal allowlisted record; no opaque extra fields enter persistent storage.
export function validateCredentialRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !boundedString(record.access_token) || !boundedString(record.refresh_token)
    || !boundedString(record.client_id, 512) || record.client_id === 'dynamic_agent_client'
    || !boundedString(record.subject, 512) || record.issuer !== AUTH_ORIGIN
    || !Array.isArray(record.scopes) || record.scopes.length > 30
    || record.scopes.some(scope => !boundedString(scope, 256)) || !record.scopes.includes(REQUIRED_SCOPE)
    || !Number.isFinite(record.expires_at) || record.expires_at <= 0
    || (record.token_type && String(record.token_type).toLowerCase() !== 'bearer')) {
    throw new BridgeError('invalid_credentials', 'Not a complete locally consented ChatGPT plan credential record', 400);
  }
  return {
    access_token: record.access_token, refresh_token: record.refresh_token,
    client_id: record.client_id, subject: record.subject, issuer: AUTH_ORIGIN,
    scopes: [...record.scopes], token_type: 'Bearer', expires_at: record.expires_at,
    email: boundedString(record.email, 512) ? record.email : null,
    saved_at: new Date().toISOString(),
  };
}

export class DurableTokenStore {
  constructor(storage, { fetchImpl = fetch, now = Date.now } = {}) {
    this.storage = storage; this.fetchImpl = fetchImpl; this.now = now; this.refreshing = null;
  }
  async load() {
    const record = await this.storage.get('credentials');
    if (!record) throw new BridgeError('sign_in_required', 'Connect your ChatGPT plan with the local auth helper', 401);
    validateCredentialRecord(record);
    return record;
  }
  async status() {
    try { await this.load(); return { connected: true }; }
    catch (cause) { if (cause instanceof BridgeError) return { connected: false }; throw cause; }
  }
  async accessToken(force = false) {
    if (this.refreshing) return this.refreshing;
    const record = await this.load();
    if (!force && record.expires_at > this.now() + 60_000) return record.access_token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh(record).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refresh(record) {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: record.client_id, refresh_token: record.refresh_token, resource: API_ORIGIN }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429) throw new BridgeError('usage_limit', 'ChatGPT plan usage is paused', 429, retryAfterSeconds(response.headers.get('retry-after')));
    if (response.status === 400) {
      let details;
      try { details = await readJSON(response, 16_000); } catch { details = {}; }
      const code = typeof details.error === 'string' ? details.error : details.error?.code;
      if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code)) throw new BridgeError('reauthentication_required', 'ChatGPT session could not renew; reconnect your plan', 401);
      if (code === 'invalid_client') throw new BridgeError('registration_invalid', 'ChatGPT application registration must be reconnected', 403);
    }
    if ([401, 403].includes(response.status)) throw new BridgeError('reauthentication_required', 'ChatGPT session could not renew; reconnect your plan', 401);
    if (!response.ok) throw new BridgeError('refresh_unavailable', 'ChatGPT session renewal is temporarily unavailable');
    const next = await response.json();
    const lifetime = Number(next.expires_in || 3600);
    const scopes = next.scope ? String(next.scope).split(/\s+/) : record.scopes;
    if (!boundedString(next.access_token) || !boundedString(next.refresh_token) || !scopes.includes(REQUIRED_SCOPE) || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new BridgeError('plan_not_enabled', 'Renewed session lacks ChatGPT plan permission', 403);
    }
    const refreshed = { ...record, access_token: next.access_token, refresh_token: next.refresh_token, scopes, saved_at: new Date(this.now()).toISOString(), expires_at: this.now() + lifetime * 1000 };
    // Commit token rotation before any inference uses the new access token.
    await this.storage.put('credentials', refreshed);
    return refreshed.access_token;
  }
}

async function readJSON(request, limit = 256_000) {
  if (!String(request.headers.get('content-type')).toLowerCase().startsWith('application/json')) throw new BridgeError('invalid_content_type', 'Send application/json', 400);
  if (Number(request.headers.get('content-length')) > limit) throw new BridgeError('request_too_large', 'Request is too large', 413);
  if (!request.body) throw new BridgeError('invalid_json', 'Request JSON is missing', 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new BridgeError('request_too_large', 'Request is too large', 413); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  let data;
  try { data = JSON.parse(text); } catch { throw new BridgeError('invalid_json', 'Request JSON is malformed', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BridgeError('invalid_json', 'Send a JSON object', 400);
  return data;
}

function budget(value, fallback, max) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('Invalid request budget configuration');
  return n;
}

export class OfficeSessionCore {
  constructor(ctx, env = {}, { fetchImpl = fetch, now = Date.now, client } = {}) {
    this.ctx = ctx; this.env = env; this.now = now;
    this.model = env.EUNNEI_MODEL || 'gpt-6-luna';
    this.perMinute = budget(env.EUNNEI_REQUESTS_PER_MINUTE, 6, 60);
    this.perHour = budget(env.EUNNEI_REQUESTS_PER_HOUR, 60, 3600);
    this.store = new DurableTokenStore(ctx.storage, { fetchImpl, now });
    this.client = client || new InferenceClient(this.store, { fetchImpl, model: this.model });
    this.busy = false; this.importing = false; this.catalog = null; this.catalogUntil = 0; this.catalogPromise = null;
    const initialize = async () => {
      this.state = await ctx.storage.get('state') || { hostId: `urn:uuid:${randomUUID()}`, calls: [], blocked: null, leaseUntil: 0, successes: 0 };
      await this.persist();
    };
    // Only local storage initialization is held behind an input gate. Never put
    // network calls here: blockConcurrencyWhile has a shorter timeout than SSE.
    this.ready = ctx.blockConcurrencyWhile ? ctx.blockConcurrencyWhile(initialize) : initialize();
  }
  persist() { return this.ctx.storage.put('state', this.state); }
  currentBlock() { return this.state.blocked && (!this.state.blocked.until || this.state.blocked.until > this.now()) ? this.state.blocked : null; }
  blockError() {
    const block = this.currentBlock();
    if (!block) return null;
    return new BridgeError(block.code, block.message, block.status, block.until ? Math.max(1, Math.ceil((block.until - this.now()) / 1000)) : null);
  }
  async rememberBlock(error) {
    if (this.currentBlock()) return;
    if ([401, 403].includes(error.status) || (error.status === 429 && !error.code.startsWith('local_'))) {
      this.state.blocked = { code: error.code, message: error.message, status: error.status, until: error.status === 429 ? this.now() + (error.retryAfter || 300) * 1000 : null };
      await this.persist();
    }
  }
  pacingError() {
    this.state.calls = this.state.calls.filter(t => this.now() - t < 3_600_000);
    const minute = this.state.calls.filter(t => this.now() - t < 60_000);
    if (this.state.calls.length >= this.perHour) return new BridgeError('local_hour_budget', 'The office is resting until its hourly quota resets', 429, Math.max(1, Math.ceil((this.state.calls[0] + 3_600_000 - this.now()) / 1000)));
    if (minute.length >= this.perMinute) return new BridgeError('local_minute_budget', 'The office is resting until its minute quota resets', 429, Math.max(1, Math.ceil((minute[0] + 60_000 - this.now()) / 1000)));
    return null;
  }
  assertIdle() {
    if (this.busy || this.importing || this.state.leaseUntil > this.now()) throw new BridgeError('busy', 'Another scene is being generated; retry when it completes', 409);
  }
  async verifiedModels() {
    if (this.importing) throw new BridgeError('busy', 'Sign-in is being updated', 409);
    if (this.catalog && this.catalogUntil > this.now()) return this.catalog;
    if (this.catalogPromise) return this.catalogPromise;
    this.catalogPromise = this.client.models().then(models => {
      this.catalog = models; this.catalogUntil = this.now() + 300_000; return models;
    }).finally(() => { this.catalogPromise = null; });
    return this.catalogPromise;
  }
  async health() {
    const connection = await this.store.status();
    let error = !connection.connected ? new BridgeError('sign_in_required', 'Connect your ChatGPT plan with the local auth helper', 401) : this.blockError() || this.pacingError();
    if (!error) {
      try {
        const models = await this.verifiedModels();
        if (!models.some(item => item.slug === this.model)) error = new BridgeError('model_unavailable', 'The selected model is not listed for this ChatGPT plan', 403);
      } catch (cause) { error = cause instanceof BridgeError ? cause : new BridgeError('catalog_unavailable', 'Could not verify ChatGPT plan model access'); }
      if (error) await this.rememberBlock(error);
    }
    return jsonResponse(200, {
      available: !error, model: this.model, status: error ? this.errorStatus(error) : this.state.successes ? 'ready' : 'model_verified',
      credential_present: connection.connected, verified_inference: this.state.successes > 0,
      successful_requests: this.state.successes, billing: 'chatgpt_plan',
      error: error?.message || null, code: error?.code || null, retry_after: this.blockError()?.retryAfter || error?.retryAfter || null,
    });
  }
  async importCredentials(request) {
    this.assertIdle();
    if (this.store.refreshing || this.catalogPromise) throw new BridgeError('busy', 'Wait for the current session check before importing', 409);
    this.importing = true;
    try {
      const record = validateCredentialRecord(await readJSON(request, 128_000));
      const previous = await this.ctx.storage.get('credentials');
      if (previous && (previous.subject !== record.subject || previous.client_id !== record.client_id)) throw new BridgeError('identity_mismatch', 'Import must match the personal office identity and registration', 409);
      await this.ctx.storage.put('credentials', { ...record, ext_agent_host_id: this.state.hostId });
      this.state.blocked = null; this.state.successes = 0; this.catalog = null; this.catalogUntil = 0;
      await this.persist();
      return jsonResponse(200, { imported: true, host_id: this.state.hostId, verified_inference: false, message: 'Session imported. This office now owns refreshes; no inference has run during import.' });
    } finally { this.importing = false; }
  }
  async chat(request) {
    const body = await readJSON(request);
    ollamaToResponses(body, this.model); // Reject malformed work before reserving budget.
    const blocked = this.blockError();
    if (blocked) throw blocked;
    this.assertIdle();
    const pacing = this.pacingError();
    if (pacing) throw pacing;
    this.busy = true;
    // Survives an isolate restart even if a catalog lookup and an upstream
    // request were both pending. Normal completion releases this immediately.
    this.state.leaseUntil = this.now() + 120_000;
    this.state.calls.push(this.now());
    try {
      await this.persist();
      const models = await this.verifiedModels();
      if (!models.some(item => item.slug === this.model)) throw new BridgeError('model_unavailable', 'The selected model is not listed for this ChatGPT plan', 403);
      const started = this.now();
      const result = await this.client.chat(body);
      this.state.successes++;
      const envelope = { model: this.model, created_at: new Date(this.now()).toISOString(), message: { role: 'assistant', content: result.text }, done: true, done_reason: 'stop', total_duration: (this.now() - started) * 1_000_000, prompt_eval_count: result.usage?.input_tokens || 0, eval_count: result.usage?.output_tokens || 0 };
      return body.stream === true ? new Response(`${JSON.stringify(envelope)}\n`, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } }) : jsonResponse(200, envelope);
    } catch (cause) {
      if (cause instanceof BridgeError) await this.rememberBlock(cause);
      throw cause;
    } finally {
      this.state.leaseUntil = 0;
      await this.persist();
      this.busy = false;
    }
  }
  errorStatus(error) { return error.status === 429 ? 'quota' : [401, 403].includes(error.status) ? 'auth_required' : 'offline'; }
  async fetch(request) {
    await this.ready;
    try {
      const path = new URL(request.url).pathname;
      if (path === '/admin/import' && request.method === 'POST') return await this.importCredentials(request);
      if (this.importing) throw new BridgeError('busy', 'Sign-in is being updated', 409);
      if (path === '/api/health' && request.method === 'GET') return await this.health();
      if (path === '/api/chat' && request.method === 'POST') return await this.chat(request);
      if (path === '/api/models' && request.method === 'GET') {
        const error = this.blockError(); if (error) throw error;
        return jsonResponse(200, { models: await this.verifiedModels() });
      }
      if (path === '/api/tags' && request.method === 'GET') return jsonResponse(200, { models: [{ name: this.model, model: this.model, size: 0, details: { family: 'chatgpt-plan' } }] });
      if (path === '/api/resume' && request.method === 'POST') {
        this.assertIdle();
        const error = this.blockError(); if (error?.status === 429) throw error;
        this.state.blocked = null; this.catalog = null; this.catalogUntil = 0;
        await this.persist();
        return jsonResponse(200, { resumed: true });
      }
      return jsonResponse(404, { error: 'Endpoint not found' });
    } catch (cause) {
      const error = cause instanceof BridgeError ? cause : new BridgeError('bridge_error', 'The office bridge could not complete this request');
      await this.rememberBlock(error);
      const retryAfter = this.blockError()?.retryAfter || error.retryAfter;
      return jsonResponse(error.status, { available: false, error: error.message, code: error.code, status: this.errorStatus(error), paused: !!this.currentBlock(), retry_after: retryAfter }, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
    }
  }
}
