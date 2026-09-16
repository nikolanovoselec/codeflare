/**
 * Registration restriction contract
 * Wire types, bounded field validators and the public parser are intentionally kept together.
 * Parsing normalizes and validates declarations; it does not grant permissions or contact services.
 * Actual operations must intersect these stored restrictions with current human authority.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { z } from 'zod';
import { ValidationError } from '../lib/error-types';
import { isPiReasoningLevel, type PiReasoningLevel } from '../lib/reasoning-profiles';

/** Registration restrictions only; never an identity, bucket selection or permission grant. */
export interface OperatorPolicy {
  schemaVersion: 1;
  networkHosts: string[];
  github: { repositories: string[]; methods: string[] };
  storage: { readPrefixes: string[]; writePrefixes: string[] };
  inference: {
    routeIds: string[];
    defaultRouteId: string | null;
    reasoningLevels: string[];
    defaultReasoningLevel: string | null;
    inheritUserDefaults: boolean;
  };
}

const hostname = z.string().max(253).toLowerCase().refine(rule => {
  const host = rule.startsWith('*.') ? rule.slice(2) : rule;
  return host.includes('.') && !/^[\d.]+$/.test(host) && !host.endsWith('.localhost')
    && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
});
const prefix = z.string().min(1).max(1024).refine(value => value.endsWith('/')
  && !/[\\%\x00-\x1f\x7f]/.test(value)
  && value.slice(0, -1).split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const unique = <T extends z.ZodType<string>>(item: T, max = 128) => z.array(item).max(max)
  .refine(values => new Set(values).size === values.length);
const reasoning = z.custom<PiReasoningLevel>(isPiReasoningLevel);
const routeId = z.string().min(1).max(128).refine(value => value.trim() === value);
const policySchema = z.strictObject({
  schemaVersion: z.literal(1),
  networkHosts: unique(hostname),
  github: z.strictObject({
    repositories: unique(z.string().max(201).toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/)),
    methods: unique(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']), 7),
  }),
  storage: z.strictObject({ readPrefixes: unique(prefix), writePrefixes: unique(prefix) }),
  inference: z.strictObject({
    routeIds: unique(routeId), defaultRouteId: routeId.nullable(),
    reasoningLevels: unique(reasoning, 7), defaultReasoningLevel: reasoning.nullable(),
    inheritUserDefaults: z.boolean(),
  }).refine(value => (value.defaultRouteId === null || value.routeIds.includes(value.defaultRouteId))
    && (value.defaultReasoningLevel === null || value.reasoningLevels.includes(value.defaultReasoningLevel))),
});

/**
 * REQ-OPERATOR-002: Validate bounded untrusted restrictions and copy their values.
 * Empty lists deny access. No implied defaults, identity, bucket, credentials or
 * permission lookup. Hostnames are exact/subdomain-wildcard rules; storage prefixes
 * are owner-relative directories. Actual authorization intersects this profile
 * with current human authority in the shared interceptors, not in this parser.
 */
export function parseOperatorPolicy(input: unknown): OperatorPolicy {
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 64 * 1024) throw new Error('Oversized policy');
    return policySchema.parse(input);
  } catch {
    throw new ValidationError('Invalid operator execution policy');
  }
}
