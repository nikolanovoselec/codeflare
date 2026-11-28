import { z } from 'zod';
import { baseFetch } from './fetch-helper';
import { SESSION_ID_RE } from '../lib/constants';
import type { PiSurface } from '../types';

const surface = z.enum(['chat', 'terminal']);
const statusSchema = z.object({
  phase: z.enum(['active', 'waiting', 'stopping', 'releasing', 'opening', 'complete', 'failed', 'uncertain', 'cancelled']),
  surface: surface.nullable(),
  requestId: z.uuid().optional(),
  target: surface.optional(),
  chatUrl: z.string().optional(),
  startupQuestion: z.boolean().optional(),
  recovery: z.literal('reopen-session').optional(),
});

export type PiWebStatus = z.infer<typeof statusSchema>;

export function piWebPrefix(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('Invalid session ID format');
  return `/api/pi-web/${sessionId}/`;
}

const options = { credentials: 'same-origin', schema: statusSchema } as const;

export function getPiWebStatus(sessionId: string, generation: number, signal: AbortSignal): Promise<PiWebStatus> {
  return baseFetch(`${piWebPrefix(sessionId)}_switch?generation=${generation}`, {
    cache: 'no-store', signal,
  }, options);
}

export function requestPiWebSwitch(sessionId: string, generation: number, target: PiSurface, requestId: string, signal: AbortSignal): Promise<PiWebStatus> {
  return baseFetch(`${piWebPrefix(sessionId)}_switch`, {
    method: 'POST', body: JSON.stringify({ generation, target, requestId }), signal,
  }, options);
}

export function cancelPiWebSwitch(sessionId: string, generation: number, requestId: string, signal: AbortSignal): Promise<PiWebStatus> {
  return baseFetch(`${piWebPrefix(sessionId)}_cancel`, {
    method: 'POST', body: JSON.stringify({ generation, requestId }), signal,
  }, options);
}
