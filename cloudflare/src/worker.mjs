import { DurableObject } from 'cloudflare:workers';
import { OfficeSessionCore } from './office.mjs';
import { handleRequest } from './gateway.mjs';

export class OfficeSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.office = new OfficeSessionCore(ctx, env);
  }
  fetch(request) { return this.office.fetch(request); }
}

export default { fetch: handleRequest };
