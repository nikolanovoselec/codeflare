/**
 * Shared Zod schemas used across multiple route files.
 * Avoids duplication of validation logic.
 */
import { z } from 'zod';

/** Validates a single terminal tab configuration. */
export const TabConfigSchema = z.object({
  id: z.string().regex(/^[1-6]$/, 'Tab id must be "1" through "6"'),
  command: z.string().max(200),
  label: z.string().max(50),
});
