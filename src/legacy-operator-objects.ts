import { DurableObject } from 'cloudflare:workers';

/**
 * Compatibility exports for Durable Object classes created by the integration
 * script's historical v3/v4 migrations. The operator feature is absent from
 * this branch, but Cloudflare requires a deployed script to keep exporting a
 * class while any of its objects remain.
 */
class LegacyOperatorObject extends DurableObject {
  fetch(): Response {
    return new Response('This legacy operator object is unavailable.', { status: 410 });
  }
}

export class OperatorRegistry extends LegacyOperatorObject {}
export class OperatorActivity extends LegacyOperatorObject {}
