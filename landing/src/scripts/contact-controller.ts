/**
 * Contact form controller — pure payload/submission logic, separated from
 * the DOM wiring in ContactForm.astro so the contract is unit-testable.
 * Topic values come from the shared worker constant: the form can never
 * offer a topic the API rejects.
 */
import type { ContactTopic } from '../../../src/lib/contact-topics';
import { ENDPOINTS } from '../config';

export interface ContactPayload {
  name: string;
  email: string;
  company?: string;
  topic: ContactTopic;
  message: string;
  turnstileToken: string;
}

export interface SubmitResult {
  ok: boolean;
  message: string;
}

export const SUCCESS_MESSAGE = "Thank you for reaching out. We'll get back to you within 1-2 business days.";
const GENERIC_ERROR = 'Something went wrong. Please try again in a moment.';
const NETWORK_ERROR = 'Network error. Please check your connection and try again.';

/**
 * Resolve a deep-link topic preselect from a URL query string, e.g. a cross-page
 * CTA navigating to /landing/?topic=enterprise-deployment#contact (the enterprise
 * SSO buttons on /login). Returns the topic only when it is one of the allowed
 * values, so a crafted URL can never preselect an option the form does not offer.
 */
export function pickDeepLinkTopic(search: string, valid: readonly string[]): ContactTopic | null {
  const value = new URLSearchParams(search).get('topic');
  return value !== null && valid.includes(value) ? (value as ContactTopic) : null;
}

export function buildContactPayload(form: FormData, turnstileToken: string): ContactPayload {
  const field = (name: string): string => String(form.get(name) ?? '').trim();
  const company = field('company');

  return {
    name: field('name'),
    email: field('email'),
    // Omitted (not set to undefined) so JSON serialization drops it cleanly.
    ...(company ? { company } : {}),
    topic: field('topic') as ContactTopic,
    message: field('message'),
    turnstileToken,
  };
}

export async function submitContact(
  payload: ContactPayload,
  fetchFn: typeof fetch = fetch
): Promise<SubmitResult> {
  try {
    const response = await fetchFn(ENDPOINTS.contact, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return { ok: true, message: SUCCESS_MESSAGE };
    }

    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, message: body.error || GENERIC_ERROR };
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }
}
