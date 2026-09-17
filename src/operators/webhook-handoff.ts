/**
 * Optional external dispatch protection for REQ-OPERATOR-025.
 *
 * This envelope protects the one-time start capability while it crosses a
 * workflow input boundary. It does not authenticate Worker requests itself and
 * never contains Codeflare's encryption master key. Context is authenticated
 * so an envelope cannot move between deployments, operators, activities,
 * workflows, revisions or expiries.
 */
export interface WebhookHandoffContext {
  deployment: string;
  operatorId: string;
  activityId: string;
  workflow: string;
  revision: number;
  expiresAt: number;
}
export interface WebhookHandoffEnvelope {
  version: 1;
  context: WebhookHandoffContext;
  nonce: string;
  ciphertext: string;
}
export type WebhookHandoff = { mode: 'encrypted'; envelope: WebhookHandoffEnvelope } | {
  mode: 'token'; token: string; warning: string;
};

const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const ID = /^[A-Za-z0-9_./-]{1,256}$/;
const encoder = new TextEncoder();
function invalid(): Error { return new Error('Invalid webhook handoff'); }
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
    if (encode(bytes) !== value) throw invalid();
    return bytes;
  } catch { throw invalid(); }
}
function validateContext(context: WebhookHandoffContext, requireFuture: boolean): void {
  if (!context || !ID.test(context.deployment) || !ID.test(context.operatorId) || !ID.test(context.activityId)
    || !ID.test(context.workflow) || !Number.isSafeInteger(context.revision) || context.revision < 0
    || !Number.isSafeInteger(context.expiresAt) || (requireFuture && (context.expiresAt <= Date.now()
      || context.expiresAt > Date.now() + 24 * 60 * 60 * 1000))) throw invalid();
}
function contextString(context: WebhookHandoffContext): string {
  return JSON.stringify(['codeflare-webhook-handoff-v1', context.deployment, context.operatorId,
    context.activityId, context.workflow, context.revision, context.expiresAt]);
}
function authenticatedContext(context: WebhookHandoffContext): Uint8Array {
  return encoder.encode(contextString(context));
}
async function importKey(value: string): Promise<CryptoKey> {
  const raw = decode(value);
  if (raw.byteLength !== 32) throw invalid();
  try { return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  catch { throw invalid(); }
}
function sameContext(left: WebhookHandoffContext, right: WebhookHandoffContext): boolean {
  return contextString(left) === contextString(right);
}

/** Encrypt configured handoff or explicitly expose the token with its warning. */
export async function createWebhookHandoff(input: { startCapability: string; webhookKey?: string;
  context: WebhookHandoffContext }): Promise<WebhookHandoff> {
  if (!TOKEN.test(input.startCapability)) throw invalid();
  validateContext(input.context, true);
  if (input.webhookKey === undefined) return { mode: 'token', token: input.startCapability,
    warning: 'Webhook dispatch input is visible to people who can access workflow inputs.' };
  const key = await importKey(input.webhookKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
      additionalData: authenticatedContext(input.context), tagLength: 128 }, key, encoder.encode(input.startCapability));
    return { mode: 'encrypted', envelope: { version: 1, context: structuredClone(input.context),
      nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) } };
  } catch { throw invalid(); }
}

/** Consumer-compatible decryptor used by fixtures and trusted dispatch tooling. */
export async function openWebhookHandoff(envelope: WebhookHandoffEnvelope, webhookKey: string,
  expectedContext: WebhookHandoffContext): Promise<string> {
  try {
    if (envelope?.version !== 1) throw invalid();
    validateContext(envelope.context, false);
    validateContext(expectedContext, false);
    if (!sameContext(envelope.context, expectedContext) || envelope.context.expiresAt <= Date.now()) throw invalid();
    const nonce = decode(envelope.nonce);
    if (nonce.byteLength !== 12) throw invalid();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
      additionalData: authenticatedContext(envelope.context), tagLength: 128 }, await importKey(webhookKey),
    decode(envelope.ciphertext));
    const capability = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext);
    if (!TOKEN.test(capability)) throw invalid();
    return capability;
  } catch { throw invalid(); }
}
