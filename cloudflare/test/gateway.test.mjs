import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { authorize } from '../src/auth.mjs';
import { handleRequest } from '../src/gateway.mjs';

const BRIDGE_KEY = 'mock-bridge-key-at-least-24-characters';
const ADMIN_KEY = 'mock-admin-key-at-least-24-characters';
const req = (path, init) => new Request(`https://office.example${path}`, init);
const bearer = { Authorization: `Bearer ${BRIDGE_KEY}` };

function bindings() {
  const forwarded = [];
  const env = {
    BRIDGE_KEY, ADMIN_KEY,
    ASSETS: { fetch: async request => { forwarded.push({ kind: 'asset', request }); return new Response('private-engine', { headers: { 'Content-Type': 'application/wasm' } }); } },
    OFFICES: {
      idFromName(name) { assert.equal(name, 'personal-office'); return name; },
      get() { return { fetch: async request => { forwarded.push({ kind: 'api', request }); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }); } }; },
    },
  };
  return { env, forwarded };
}

test('the Worker authorizes before static assets, engine chunks and API dispatch', async () => {
  const { env, forwarded } = bindings();
  for (const path of ['/', '/office/index.wasm.part000', '/api/health']) assert.equal((await handleRequest(req(path), env)).status, 401);
  assert.equal(forwarded.length, 0);
  const asset = await handleRequest(req('/office/index.wasm.part000', { headers: bearer }), env);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'private, no-store');
  assert.equal(asset.headers.get('content-type'), 'application/wasm');
  assert.equal(asset.headers.get('cross-origin-embedder-policy'), 'require-corp');
});

test('admin import requires both primary authentication and a separate administrator key', async () => {
  const { env, forwarded } = bindings();
  const post = headers => req('/admin/import', { method: 'POST', headers, body: '{}' });
  assert.equal((await handleRequest(post({ 'X-Eunnei-Admin-Key': ADMIN_KEY }), env)).status, 401);
  assert.equal((await handleRequest(post(bearer), env)).status, 403);
  assert.equal((await handleRequest(post({ ...bearer, 'X-Eunnei-Admin-Key': BRIDGE_KEY }), env)).status, 403);
  assert.equal((await handleRequest(post({ ...bearer, 'X-Eunnei-Admin-Key': ADMIN_KEY }), env)).status, 200);
  assert.equal(forwarded.length, 1);
  for (const header of ['authorization', 'x-eunnei-admin-key']) assert.equal(forwarded[0].request.headers.has(header), false);
  assert.equal((await handleRequest(post({ ...bearer, 'X-Eunnei-Admin-Key': BRIDGE_KEY }), { ...env, ADMIN_KEY: BRIDGE_KEY })).status, 403);
});

test('cross-origin mutations are denied and private auth headers do not reach asset bindings', async () => {
  const { env, forwarded } = bindings();
  const response = await handleRequest(req('/api/chat', { method: 'POST', headers: { ...bearer, Origin: 'https://unrelated.example' }, body: '{}' }), env);
  assert.equal(response.status, 403); assert.equal(forwarded.length, 0);
  await handleRequest(req('/', { headers: { ...bearer, cookie: 'private-cookie', 'cf-access-jwt-assertion': 'private-jwt' } }), env);
  assert.equal(new URL(forwarded[0].request.url).pathname, '/index.html');
  for (const header of ['authorization', 'cookie', 'cf-access-jwt-assertion']) assert.equal(forwarded[0].request.headers.has(header), false);
});

test('Access assertions verify real signatures, audience, issuer, expiry and every configured owner pin', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const issuer = 'https://team.cloudflareaccess.com';
  const env = { CF_ACCESS_TEAM_DOMAIN: issuer, CF_ACCESS_AUD: 'office-audience', CF_ACCESS_ALLOWED_SUB: 'owner-id', CF_ACCESS_ALLOWED_EMAIL: 'owner@example.com' };
  async function token(changes = {}) {
    return new SignJWT({ email: 'owner@example.com', ...changes.payload })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(changes.issuer || issuer).setAudience(changes.audience || 'office-audience')
      .setSubject(changes.subject || 'owner-id').setIssuedAt().setExpirationTime(changes.expiration || '2h').sign(privateKey);
  }
  const check = value => authorize(req('/', { headers: { 'cf-access-jwt-assertion': value } }), env, { jwks: publicKey });
  assert.deepEqual(await check(await token()), { kind: 'access', owner: 'owner-id' });
  for (const change of [{ issuer: 'https://other.cloudflareaccess.com' }, { audience: 'other-audience' }, { subject: 'other-user' }, { payload: { email: 'other@example.com' } }, { expiration: 1 }]) await assert.rejects(check(await token(change)), { code: 'office_auth_required' });
  const parts = (await token()).split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 'owner-id', email: 'owner@example.com', iss: issuer, aud: 'office-audience', exp: 9999999999, iat: 1 })).toString('base64url');
  await assert.rejects(check(parts.join('.')), { code: 'office_auth_required' });
});
