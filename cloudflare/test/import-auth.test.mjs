import test from 'node:test';
import assert from 'node:assert/strict';
import { importCredentials } from '../scripts/import-auth.mjs';

const record = { access_token: 'mock-access', refresh_token: 'mock-refresh', client_id: 'oaiapp_mock', scopes: ['chatgpt.tokens.use.direct'] };
const options = {
  url: 'https://office.example', file: '/mock/protected-record.json',
  bridgeKey: 'mock-bridge-key-at-least-24-characters', adminKey: 'mock-admin-key-at-least-24-characters',
  readFileImpl: async () => JSON.stringify(record),
};

test('credential import refuses insecure or ambiguous destinations before reading a file', async () => {
  let reads = 0;
  for (const url of ['http://office.example', 'https://other:secret@office.example', 'https://office.example/path', 'https://office.example?token=value']) {
    await assert.rejects(importCredentials({ ...options, url, readFileImpl: async () => { reads++; return '{}'; } }), /HTTPS origin/);
  }
  assert.equal(reads, 0);
});

test('credential import requires distinct strong keys and complete plan credentials', async () => {
  await assert.rejects(importCredentials({ ...options, adminKey: options.bridgeKey }), /distinct/);
  await assert.rejects(importCredentials({ ...options, bridgeKey: 'short' }), /distinct/);
  await assert.rejects(importCredentials({ ...options, readFileImpl: async () => JSON.stringify({ ...record, scopes: ['openid'] }) }), /complete Eunnei/);
  await assert.rejects(importCredentials({ ...options, readFileImpl: async () => 'bad-json' }), /valid JSON/);
});

test('credential import sends only to HTTPS, disallows redirects, and returns no secrets', async () => {
  let sent;
  const result = await importCredentials({ ...options, fetchImpl: async (url, init) => {
    sent = { url: String(url), ...init };
    return new Response(JSON.stringify({ imported: true, accidental_token: 'must-not-return' }));
  } });
  assert.equal(sent.url, 'https://office.example/admin/import');
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.headers.Authorization, `Bearer ${options.bridgeKey}`);
  assert.equal(sent.headers['X-Eunnei-Admin-Key'], options.adminKey);
  assert.deepEqual(JSON.parse(sent.body), record);
  assert.deepEqual(result, { imported: true });
});

test('credential import never reflects an upstream error containing a credential', async () => {
  await assert.rejects(importCredentials({ ...options, fetchImpl: async () => new Response('mock-access mock-refresh', { status: 403 }) }), error => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /mock-access|mock-refresh/);
    return true;
  });
});

test('Cloudflare Access service credentials must be paired before the file is read', async () => {
  let reads = 0;
  for (const access of [{ accessClientId: 'mock-service-id' }, { accessClientSecret: 'mock-service-secret' }]) {
    await assert.rejects(importCredentials({ ...options, ...access, readFileImpl: async () => { reads++; return '{}'; } }), /Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/);
  }
  assert.equal(reads, 0);
});

test('Cloudflare Access service headers supplement both Worker keys without exposing credentials', async () => {
  const result = await importCredentials({ ...options, accessClientId: 'mock-service-id', accessClientSecret: 'mock-service-secret', fetchImpl: async (_url, init) => {
    assert.equal(init.headers['CF-Access-Client-Id'], 'mock-service-id');
    assert.equal(init.headers['CF-Access-Client-Secret'], 'mock-service-secret');
    assert.equal(init.headers.Authorization, `Bearer ${options.bridgeKey}`);
    assert.equal(init.headers['X-Eunnei-Admin-Key'], options.adminKey);
    return new Response('mock-service-secret must-not-return');
  } });
  assert.deepEqual(result, { imported: true });
});
