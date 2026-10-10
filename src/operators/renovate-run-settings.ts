import { z } from 'zod';
import { ValidationError } from '../lib/error-types';

const repository = z.string().min(3).max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..'));
const interval = z.number().int().positive().safe()
  .refine(value => Number.isFinite(new Date(Date.now() + value * 1000).getTime()));
const settings = z.strictObject({ repository,
  automaticRuns: z.boolean().default(false),
  repetitionIntervalSeconds: interval.default(3600) });

export type RenovateRunSettings = z.infer<typeof settings>;
export type RenovateRepositoryIdentity = { repository: string; repositoryId: number; baseBranch: string };
export const renovateRepositoryIdentity = z.strictObject({ repository,
  repositoryId: z.number().int().positive().safe(), baseBranch: z.string().min(1).max(128) });

/** Missing configuration grants neither a target nor automatic execution. */
export function parseRenovateRunSettings(configurationJson: string): RenovateRunSettings | null {
  let configuration: unknown;
  try { configuration = JSON.parse(configurationJson); }
  catch { throw new ValidationError('Invalid Renovate run settings'); }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new ValidationError('Invalid Renovate run settings');
  }
  const reserved = (configuration as Record<string, unknown>).renovate;
  if (reserved === undefined) return null;
  const parsed = settings.safeParse(reserved);
  if (!parsed.success) throw new ValidationError('Invalid Renovate run settings');
  return parsed.data;
}

/** Resolve before preparing or digesting; explicit input is not an override. */
export function configuredRenovateInvocation(configurationJson: string, invocation: unknown): { repository: string } {
  const configured = parseRenovateRunSettings(configurationJson);
  if (!configured) throw new ValidationError('Configure the Renovate repository before running');
  const supplied = z.strictObject({ repository: repository.optional() }).safeParse(invocation);
  if (!supplied.success || (supplied.data.repository !== undefined && supplied.data.repository !== configured.repository)) {
    throw new ValidationError('Renovate invocation must use the configured repository');
  }
  return { repository: configured.repository };
}

export function prospectiveRenovatePackageSupported(manifestJson: string): boolean {
  try {
    const manifest = JSON.parse(manifestJson);
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.id === 'renovate-dispatcher' && manifest.profile === 'dispatcher' && (manifest.intentVersion === '3' || manifest.intentVersion === '4');
  } catch { return false; }
}
