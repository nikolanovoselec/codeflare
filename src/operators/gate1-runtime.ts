import type { OperatorContainerProfile } from '../container/operator-context';
import { getContainerId } from '../lib/container-helpers';
import type { JwtStampingAuthority } from './jwt-stamping';
import type { OwnedOperatorSessionRuntime } from './owned-session';

export interface Gate1RouteConfig {
  routeCatalog: string[];
  defaultRoute: string;
  defaultReasoning: string;
  routeContextWindows: Record<string, number>;
  routeReasoningLevels: Record<string, string[]>;
  modelDisplayNames: Record<string, string>;
  promptCacheTargets?: string[];
}

export interface Gate1ContainerStub {
  setBucketName(name: string, options: { sessionId: string; userEmail: string; userGroups: string[] }
    & Gate1RouteConfig): Promise<void>;
  configureOperatorContext(profile: unknown, authority: JwtStampingAuthority): Promise<void>;
  startAndWaitForPorts(): Promise<void>;
  getState(): Promise<{ status: string }>;
  fetch(request: Request): Promise<Response>;
  stopOperatorSession(activityId: string, sessionId: string): Promise<'stopped' | 'unknown'>;
}

export class ContainerOwnedSessionRuntime implements OwnedOperatorSessionRuntime {
  constructor(private readonly options: { activityId: string; ownerBucket: string; sessionId: string;
    userEmail: string; userGroups: string[]; routes: Gate1RouteConfig;
    resolve: (containerId: string) => Gate1ContainerStub }) {}

  private container(sessionId: string): Gate1ContainerStub {
    return this.options.resolve(getContainerId(this.options.ownerBucket, sessionId));
  }

  async reserve(input: { requestId: string; requestDigest: string; activityId: string; ownerBucket: string;
    sessionId: string }): Promise<{ sessionId: string }> {
    if (input.activityId !== this.options.activityId || input.ownerBucket !== this.options.ownerBucket
      || input.sessionId !== this.options.sessionId) throw new Error('Gate 1 session ownership mismatch');
    return { sessionId: input.sessionId };
  }

  async configure(sessionId: string, profile: OperatorContainerProfile, authority: JwtStampingAuthority): Promise<void> {
    if (profile.activityId !== this.options.activityId || profile.ownerBucket !== this.options.ownerBucket
      || profile.sessionId !== sessionId) throw new Error('Gate 1 session ownership mismatch');
    const container = this.container(sessionId);
    await container.setBucketName(this.options.ownerBucket, { sessionId,
      userEmail: this.options.userEmail, userGroups: this.options.userGroups, ...this.options.routes });
    await container.configureOperatorContext(profile, authority);
  }

  async start(sessionId: string): Promise<void> {
    await this.container(sessionId).startAndWaitForPorts();
  }

  async readiness(sessionId: string): Promise<'starting' | 'ready' | 'stopped' | 'unknown'> {
    try {
      const container = this.container(sessionId);
      const state = await container.getState();
      if (state.status === 'stopped' || state.status === 'stopping') return 'stopped';
      if (state.status !== 'running' && state.status !== 'healthy') return state.status === 'starting' ? 'starting' : 'unknown';
      const response = await container.fetch(new Request('http://container/health'));
      if (!response.ok) return 'starting';
      const health = await response.json() as { initFlagObserved?: boolean; terminalServiceReady?: boolean };
      return health.initFlagObserved && health.terminalServiceReady ? 'ready' : 'starting';
    } catch { return 'unknown'; }
  }

  async stop(sessionId: string, _drain: boolean): Promise<'stopped' | 'unknown'> {
    try { return await this.container(sessionId).stopOperatorSession(this.options.activityId, sessionId); }
    catch { return 'unknown'; }
  }
}
