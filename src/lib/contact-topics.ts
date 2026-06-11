/**
 * Contact-form topic identifiers, shared between the Worker route schema
 * (src/routes/public) and the landing page form (landing/src). Single source
 * of truth so the public form can never submit a topic the API rejects.
 * Kept dependency-free: the landing build imports this file across package
 * boundaries.
 */
export const CONTACT_TOPICS = [
  'enterprise-deployment',
  'pilot-poc',
  'security-compliance',
  'partnership',
  'general',
] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number];
