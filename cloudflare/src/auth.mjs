import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { BridgeError } from '../../cloud/src/protocol.mjs';

const keySets = new Map();
export const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
export const validSecret = value => typeof value === 'string' && value.length >= 24;

// The browser never receives BRIDGE_KEY. It is an alternative for a trusted
// private server-side reverse proxy, not a browser login mechanism.
export async function authorize(request, env, { jwtVerifyImpl = jwtVerify, jwks } = {}) {
  const auth = request.headers.get('authorization') || '';
  if (validSecret(env.BRIDGE_KEY) && auth.startsWith('Bearer ') && sameSecret(auth.slice(7), env.BRIDGE_KEY)) {
    return { kind: 'bridge', owner: 'personal' };
  }
  const team = String(env.CF_ACCESS_TEAM_DOMAIN || '').replace(/\/$/, '');
  const aud = env.CF_ACCESS_AUD;
  const ownerSub = env.CF_ACCESS_ALLOWED_SUB;
  const ownerEmail = env.CF_ACCESS_ALLOWED_EMAIL;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (team && aud && (ownerSub || ownerEmail) && token) {
    try {
      const origin = new URL(team);
      if (origin.protocol !== 'https:' || origin.origin !== team || !origin.hostname.endsWith('.cloudflareaccess.com')) throw new Error('Invalid issuer');
      let keys = jwks || keySets.get(team);
      if (!keys) {
        keys = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
        if (keySets.size >= 4) keySets.clear();
        keySets.set(team, keys);
      }
      const { payload } = await jwtVerifyImpl(token, keys, { issuer: team, audience: aud, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] });
      if (typeof payload.sub !== 'string' || !payload.sub || (ownerSub && payload.sub !== ownerSub)) throw new Error('Wrong owner');
      if (ownerEmail && (typeof payload.email !== 'string' || payload.email.toLowerCase() !== String(ownerEmail).toLowerCase())) throw new Error('Wrong owner');
      return { kind: 'access', owner: payload.sub };
    } catch { /* Never include claims, JWTs, or library error details in replies. */ }
  }
  throw new BridgeError('office_auth_required', 'Private office sign-in required', 401);
}
