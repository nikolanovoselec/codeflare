import type { AccessTier, SessionMode } from '../types';

export function isActiveUser(tier: AccessTier | undefined): boolean {
  return tier === 'standard' || tier === 'advanced' || tier === undefined;
}

export function allowedSessionModes(tier: AccessTier | undefined): SessionMode[] {
  if (tier === 'advanced' || tier === undefined) return ['default', 'advanced'];
  if (tier === 'standard') return ['default'];
  return [];
}

export function canUseSessionMode(tier: AccessTier | undefined, mode: SessionMode): boolean {
  return allowedSessionModes(tier).includes(mode);
}
