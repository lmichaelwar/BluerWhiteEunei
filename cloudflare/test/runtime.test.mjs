import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Node's fetch permits an arbitrary receiver; workerd's native fetch does not.
// Exercise the production classes with the real runtime API and an intercepted
// network. Every credential here is synthetic; no external request is allowed.
test('native Workers fetch supports persisted token refresh and model discovery', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      contents: `
        import { DurableTokenStore } from './src/office.mjs';
        import { InferenceClient } from '../cloud/src/protocol.mjs';
        export default { async fetch() {
          let record = {
            access_token:'synthetic-expired-access', refresh_token:'synthetic-refresh',
            client_id:'synthetic-client',subject:'synthetic-owner',
            issuer:'https://auth.openai.com',scopes:['chatgpt.tokens.use.direct'],expires_at:1
          };
          const storage = { get:async()=>structuredClone(record), put:async(_key,value)=>{record=structuredClone(value)} };
          const tokens = new DurableTokenStore(storage);
          const client = new InferenceClient(tokens);
          const models = await client.models();
          return Response.json({models,rotationCommitted:record.refresh_token==='synthetic-next-refresh'});
        } };
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
    external: ['node:*', 'cloudflare:workers'],
  });
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false, modules: true, compatibilityDate: '2026-10-24', script: bundle.outputFiles[0].text,
    outboundService: async request => {
      calls.push(request.url);
      if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
        assert.equal(request.method, 'POST');
        assert.equal(new URLSearchParams(await request.text()).get('refresh_token'), 'synthetic-refresh');
        return Response.json({access_token:'synthetic-next-access',refresh_token:'synthetic-next-refresh',expires_in:3600,scope:'chatgpt.tokens.use.direct'});
      }
      if (request.url === 'https://api.openai.com/v1/models') {
        assert.equal(request.headers.get('authorization'), 'Bearer synthetic-next-access');
        return Response.json({models:[{slug:'gpt-6-luna',display_name:'Luna',visibility:'list'}]});
      }
      throw new Error('Unexpected outbound URL in isolated runtime test');
    },
  }));
  try {
    const response = await mf.dispatchFetch('https://office.invalid/runtime-test');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {models:[{slug:'gpt-6-luna',display_name:'Luna'}],rotationCommitted:true});
    assert.deepEqual(calls, ['https://auth.openai.com/api/accounts/oauth/token', 'https://api.openai.com/v1/models']);
  } finally { await mf.dispose(); }
});
