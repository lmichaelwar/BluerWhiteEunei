// Node filesystem adapter; protocol is also shared by the Cloudflare Worker.
import { join } from 'node:path';
import { readJSON, writeJSON } from './storage.mjs';
import { API_ORIGIN, TOKEN_URL, REQUIRED_SCOPE, BridgeError } from './protocol.mjs';
export * from './protocol.mjs';

export class TokenStore {
  constructor(dataDir, { fetchImpl = fetch, now = Date.now } = {}) { this.path = join(dataDir, 'credentials.json'); this.fetchImpl = fetchImpl; this.now = now; this.refreshing = null; }
  async load() {
    const record = await readJSON(this.path);
    if (!record?.access_token || !record?.refresh_token || !record?.client_id || !record.scopes?.includes(REQUIRED_SCOPE)) throw new BridgeError('sign_in_required', 'Connect your ChatGPT plan using the local auth helper', 401);
    return record;
  }
  async status() {
    try { const record = await this.load(); return { connected: true, email: record.email || null, expiresAt: record.expires_at }; }
    catch (error) { if (error instanceof BridgeError) return { connected: false, code: error.code }; throw error; }
  }
  async accessToken(force = false) {
    if (this.refreshing) return this.refreshing;
    const record = await this.load();
    if (!force && Number(record.expires_at) > this.now() + 60_000) return record.access_token;
    // Recheck after the asynchronous file read so concurrent callers share one rotation.
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
    if (!response.ok) throw new BridgeError('reauthentication_required', 'ChatGPT session could not renew; reconnect your plan', 401);
    const next = await response.json();
    const scopes = next.scope ? String(next.scope).split(/\s+/) : record.scopes;
    if (!next.access_token || !next.refresh_token || !scopes.includes(REQUIRED_SCOPE)) throw new BridgeError('plan_not_enabled', 'Renewed session lacks ChatGPT plan permission', 403);
    await writeJSON(this.path, { ...record, ...next, scopes, saved_at: new Date(this.now()).toISOString(), expires_at: this.now() + Number(next.expires_in || 3600) * 1000 });
    return next.access_token;
  }
}
