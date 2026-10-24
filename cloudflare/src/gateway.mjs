import { authorize, sameSecret, validSecret } from './auth.mjs';
import { BridgeError } from '../../cloud/src/protocol.mjs';

export function jsonResponse(status, value, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}

export async function handleRequest(request, env, _ctx, { authorizeImpl = authorize } = {}) {
  try {
    const principal = await authorizeImpl(request, env);
    const url = new URL(request.url);
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return jsonResponse(405, { error: 'Method not allowed' });
    const origin = request.headers.get('origin');
    if (request.method === 'POST' && origin && origin !== url.origin && !(principal.kind === 'bridge' && origin === env.EUNNEI_ALLOWED_ORIGIN)) {
      return jsonResponse(403, { error: 'Origin not allowed' });
    }
    if (url.pathname.startsWith('/admin/')) {
      if (url.pathname !== '/admin/import' || request.method !== 'POST') return jsonResponse(404, { error: 'Endpoint not found' });
      const admin = request.headers.get('x-eunnei-admin-key') || '';
      if (!validSecret(env.ADMIN_KEY) || env.ADMIN_KEY === env.BRIDGE_KEY || !sameSecret(admin, env.ADMIN_KEY)) {
        return jsonResponse(403, { error: 'Separate administrator authorization required' });
      }
    }
    const headers = new Headers(request.headers);
    for (const name of ['authorization', 'x-eunnei-admin-key', 'cf-access-jwt-assertion', 'cookie']) headers.delete(name);
    const internal = new Request(request, { headers });
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/')) {
      const office = env.OFFICES.get(env.OFFICES.idFromName('personal-office'));
      return await office.fetch(internal);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return jsonResponse(405, { error: 'Method not allowed' });
    if (!env.ASSETS) return jsonResponse(503, { error: 'Office export unavailable' });
    // html_handling:none preserves Godot's explicit /office/index.html URL;
    // explicitly map the landing route instead of relying on implicit rewrites.
    let assetRequest = internal;
    if (url.pathname === '/') {
      url.pathname = '/index.html';
      assetRequest = new Request(url, internal);
    }
    const asset = await env.ASSETS.fetch(assetRequest);
    const response = new Response(asset.body, asset);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return response;
  } catch (cause) {
    const error = cause instanceof BridgeError ? cause : new BridgeError('bridge_error', 'The private office could not complete this request');
    return jsonResponse(error.status, { available: false, status: error.status === 401 ? 'auth_required' : 'offline', error: error.message, code: error.code });
  }
}
