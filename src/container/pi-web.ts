import { SESSION_ID_PATTERN } from '../lib/constants';
import type { Session } from '../types';

export const PI_WEB_ROOT = '/api/pi-web';
export const PI_WEB_GENERATION_HEADER = 'x-codeflare-pi-generation';

export function isPiWebPath(pathname: string): boolean {
  return pathname === PI_WEB_ROOT || pathname.startsWith(`${PI_WEB_ROOT}/`);
}

export function piWebSessionId(pathname: string): string | undefined {
  if (!pathname.startsWith(`${PI_WEB_ROOT}/`)) return undefined;
  const end = pathname.indexOf('/', PI_WEB_ROOT.length + 1);
  if (end < 0) return undefined;
  const id = pathname.slice(PI_WEB_ROOT.length + 1, end);
  return SESSION_ID_PATTERN.test(id) ? id : undefined;
}

export function piWebAppPrefix(sessionId: string, generation: number): string {
  return `${PI_WEB_ROOT}/${sessionId}/g/${generation}/`;
}

export function matchesPiWebGeneration(pathname: string, sessionId: string, generation: number): boolean {
  const control = `${PI_WEB_ROOT}/${sessionId}/`;
  return pathname === `${control}_switch` || pathname === `${control}_cancel`
    || pathname.startsWith(piWebAppPrefix(sessionId, generation));
}

/** Match the actual managed primary, never infer from a secondary tab or custom command. */
export function isPiWebEligible(session: Pick<Session, 'agentType' | 'workspace' | 'tabConfig'>): boolean {
  if (session.agentType !== 'pi' || session.workspace !== 'terminal') return false;
  if (session.tabConfig === undefined) return true; // Start supplies the deployment's native Pi default.
  if (!Array.isArray(session.tabConfig)) return false;
  const primary = session.tabConfig.filter(tab => tab?.id === '1');
  return primary.length === 1 && primary[0].command === 'pi';
}
