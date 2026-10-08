import { z } from 'zod';
import { dispatcherCapacityKeys, type DispatcherCapacityKey } from './dispatcher-capacity-limits';

/** Backend boundary validation; shared UI defaults do not import runtime dependencies. */
export const dispatcherCapacityShape = Object.fromEntries(dispatcherCapacityKeys.map(key => [key,
  (key === 'checkRunPageSize' ? z.number().int().positive().max(100) : z.number().int().positive().safe()).optional(),
])) as { [K in DispatcherCapacityKey]: z.ZodOptional<z.ZodNumber> };
export const dispatcherCapacityPolicySchema = z.strictObject(dispatcherCapacityShape);
