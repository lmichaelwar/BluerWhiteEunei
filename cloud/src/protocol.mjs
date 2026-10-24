import { createPublicKey, verify, createHash, randomBytes } from 'node:crypto';

export const AUTH_ORIGIN = 'https://auth.openai.com';
export const API_ORIGIN = 'https://api.openai.com/v1';
export const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
export const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export class BridgeError extends Error {
  constructor(code, message, status = 502, retryAfter = null) { super(message); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}

export function retryAfterSeconds(value, fallback = 300, now = Date.now()) {
  if (!value) return fallback;
  const seconds = /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.min(86_400, Math.max(15, Math.ceil(seconds))) : fallback;
}

export function makeAuthorization({ host, clientId, port = 1455 }) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId || 'dynamic_agent_client', ext_agent_host_id: host,
    response_type: 'code', redirect_uri: redirectUri, scope: SCOPES,
    resource: API_ORIGIN, state, nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  if (!clientId) params.set('agent_name_hint', 'Eunnei personal office');
  return { verifier, state, nonce, redirectUri, clientId, url: `${AUTH_ORIGIN}/api/accounts/authorize?${params}` };
}

export async function validateIdToken(token, { clientId, nonce, fetchImpl = fetch, now = Date.now() }) {
  const parts = token?.split('.');
  if (parts?.length !== 3) throw new BridgeError('invalid_identity', 'Identity verification failed', 401);
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
  catch { throw new BridgeError('invalid_identity', 'Malformed identity token', 401); }
  if (!['RS256', 'ES256'].includes(header.alg) || !header.kid) throw new BridgeError('invalid_identity', 'Unsupported identity signature', 401);
  const metadataResponse = await fetchImpl(`${AUTH_ORIGIN}/.well-known/openid-configuration`);
  if (!metadataResponse.ok) throw new BridgeError('identity_unavailable', 'OpenAI identity metadata unavailable');
  const metadata = await metadataResponse.json();
  if (metadata.issuer !== AUTH_ORIGIN || new URL(metadata.jwks_uri).origin !== AUTH_ORIGIN) throw new BridgeError('invalid_identity', 'Unexpected identity metadata', 401);
  const keyResponse = await fetchImpl(metadata.jwks_uri);
  if (!keyResponse.ok) throw new BridgeError('identity_unavailable', 'OpenAI identity keys unavailable');
  const jwk = (await keyResponse.json()).keys?.find(k => k.kid === header.kid && (!k.alg || k.alg === header.alg));
  if (!jwk) throw new BridgeError('invalid_identity', 'Identity signing key unavailable', 401);
  let valid = false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    valid = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'));
  } catch { /* Deliberately return no JWT/key material. */ }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!valid || claims.iss !== AUTH_ORIGIN || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || claims.exp <= now / 1000 || !Number.isFinite(claims.exp) || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub || (claims.nbf && claims.nbf > now / 1000 + 60)) {
    throw new BridgeError('invalid_identity', 'Identity verification failed', 401);
  }
  return claims;
}

export async function exchangeCode({ attempt, callback, fetchImpl = fetch }) {
  if (callback.get('state') !== attempt.state) throw new BridgeError('invalid_state', 'Sign-in state did not match', 400);
  if (callback.has('error')) throw new BridgeError('consent_declined', 'Sign-in was declined or unavailable', 401);
  const clientId = callback.get('client_id') || attempt.clientId;
  if (!clientId || clientId === 'dynamic_agent_client' || (attempt.clientId && clientId !== attempt.clientId)) throw new BridgeError('invalid_client', 'Client registration was not completed', 401);
  if (!callback.get('code')) throw new BridgeError('invalid_code', 'Authorization code missing', 400);
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: callback.get('code'), code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: API_ORIGIN }),
  });
  if (!response.ok) throw new BridgeError('sign_in_failed', 'Authorization exchange failed; start sign-in again', 401);
  const tokens = await response.json();
  const claims = await validateIdToken(tokens.id_token, { clientId, nonce: attempt.nonce, fetchImpl });
  const scopes = String(tokens.scope || '').split(/\s+/);
  if (!scopes.includes(REQUIRED_SCOPE) || !tokens.access_token || !tokens.refresh_token) throw new BridgeError('plan_not_enabled', 'ChatGPT plan usage permission was not granted', 403);
  return { ...tokens, scopes, client_id: clientId, subject: claims.sub, issuer: claims.iss, email: claims.email || null, saved_at: new Date().toISOString(), expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
}


export async function readResponseStream(response) {
  if (!response.body) throw new BridgeError('empty_stream', 'OpenAI returned no response stream');
  const decoder = new TextDecoder();
  let buffer = '', output = '', completed = null, bytes = 0;
  function consume(block) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw new BridgeError('invalid_stream', 'Malformed inference response'); }
    if (event.type === 'response.output_text.delta') { output += event.delta || ''; if (output.length > 200_000) throw new BridgeError('output_too_large', 'Scene response exceeded the local size limit'); }
    if (event.type === 'response.failed' || event.type === 'error' || event.type === 'response.incomplete') {
      const code = event.response?.error?.code || event.code || event.error?.code || 'inference_incomplete';
      if (['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(code)) throw new BridgeError(code, 'ChatGPT plan usage is unavailable or at its limit. Generation is paused; check ChatGPT Settings → Usage.', 429, retryAfterSeconds(response.headers.get('retry-after')));
      throw new BridgeError('inference_failed', 'Inference did not complete; the scene was not committed');
    }
    if (event.type === 'response.completed') {
      if (event.response?.status && event.response.status !== 'completed') throw new BridgeError('inference_incomplete', 'Response terminal status was not completed');
      completed = event.response || {};
    }
  }
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4_000_000) throw new BridgeError('stream_too_large', 'Inference stream exceeded the local size limit');
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) { consume(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!completed) throw new BridgeError('interrupted_stream', 'Inference stream ended before completion');
  if (!output) output = (completed.output || []).flatMap(i => i.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('');
  if (!output.trim()) throw new BridgeError('empty_output', 'The completed inference returned no dialogue');
  return { text: output, usage: completed.usage || null, responseId: completed.id || null };
}

export function ollamaToResponses(body, model) {
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 80) throw new BridgeError('invalid_messages', 'Provide between 1 and 80 messages', 400);
  const instructions = [];
  const input = [];
  for (const msg of body.messages) {
    if (typeof msg.content !== 'string' || msg.content.length > 100_000) throw new BridgeError('invalid_message', 'Messages must contain bounded text', 400);
    if (msg.role === 'system' || msg.role === 'developer') instructions.push(msg.content);
    else if (['user', 'assistant'].includes(msg.role)) input.push({ role: msg.role, content: msg.content });
    else throw new BridgeError('unsupported_message', 'Only text conversation messages are supported', 400);
  }
  if (!input.length) input.push({ role: 'user', content: 'Continue the requested scene.' });
  const result = { model, input, store: false, stream: true };
  if (instructions.length) result.instructions = instructions.join('\n\n');
  // Do not forward Ollama options, temperature, system-role items, or token limits.
  if (body.format === 'json' || (body.format && typeof body.format === 'object')) {
    const schema = typeof body.format === 'object' ? JSON.stringify(body.format) : '';
    if (schema.length > 20_000) throw new BridgeError('schema_too_large', 'The requested JSON schema is too large', 400);
    result.instructions = `${result.instructions || ''}\nReturn only valid JSON. No Markdown fences. Keep the result concise.${schema ? `\nMatch this JSON schema exactly:\n${schema}` : ''}`;
  }
  return result;
}

export class InferenceClient {
  constructor(store, { fetchImpl = fetch, model = 'gpt-6-luna' } = {}) { this.store = store; this.fetchImpl = fetchImpl; this.model = model; }
  async request(path, init = {}) {
    // Leave time for the Godot client's 45-second request deadline. This signal
    // also covers the streaming body and the single 401 refresh retry.
    const signal = AbortSignal.timeout(40_000);
    let token = await this.store.accessToken();
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await this.fetchImpl(`${API_ORIGIN}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal });
      if (response.status !== 401 || attempt === 1) break;
      await response.body?.cancel();
      token = await this.store.accessToken(true);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new BridgeError('plan_access_denied', 'ChatGPT plan access was denied; reconnect or check model access', response.status);
      if (response.status === 429) throw new BridgeError('usage_limit', 'ChatGPT plan usage limit reached; generation is paused', 429, retryAfterSeconds(response.headers.get('retry-after')));
      throw new BridgeError('upstream_unavailable', 'OpenAI is temporarily unavailable; no scene was committed');
    }
    return response;
  }
  async models() {
    const response = await this.request('/models');
    const body = await response.json();
    if (!Array.isArray(body.models)) throw new BridgeError('invalid_catalog', 'The ChatGPT plan model catalog could not be read');
    return body.models.filter(m => m.visibility === 'list').map(m => ({ slug: m.slug, display_name: m.display_name }));
  }
  async chat(body) {
    const request = ollamaToResponses(body, this.model);
    return readResponseStream(await this.request('/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }));
  }
}
