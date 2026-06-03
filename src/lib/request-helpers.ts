/**
 * Shared request handling helpers for route handlers.
 * Reduces boilerplate for JSON parsing, Zod validation, session ID checks, and secret masking.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { ValidationError } from './error-types';
import { SESSION_ID_PATTERN } from './constants';

/**
 * Parse JSON body from a Hono request, throwing ValidationError on malformed input.
 * Replaces the try/catch c.req.json() boilerplate used across 14+ route handlers.
 * Also fixes 8 routes that were missing JSON error handling entirely (crash with 500).
 *
 * When a Zod schema is supplied, the parsed body is validated and the typed,
 * validated value is returned. Validation failures throw a ValidationError carrying
 * the first Zod issue message - identical to the safeParse + firstZodError pattern
 * used at the callsites. When omitted, the body is returned as an unchecked cast (back-compat).
 */
export async function parseJsonBody<T = unknown>(c: Context): Promise<T>;
export async function parseJsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>>;
export async function parseJsonBody<T = unknown>(c: Context, schema?: z.ZodType): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  if (!schema) {
    return body as T;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(firstZodError(parsed.error));
  }
  return parsed.data as T;
}

/**
 * Extract the first error message from a Zod validation error.
 * Provides a fallback for the edge case of an empty issues array.
 */
export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Validation error';
}

/**
 * Validate a session ID format. Throws ValidationError if invalid.
 * Standardizes 8 callsites that had 3 different error response patterns.
 */
export function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ValidationError('Invalid session ID format');
  }
}

/**
 * Mask a sensitive string for safe display (e.g., API keys, tokens).
 * Shows only the last 4 characters: "sk-1234567890" → "****7890"
 */
export function maskSecret(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}
