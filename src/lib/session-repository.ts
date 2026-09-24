import type { AgentType, SessionWorkspace, TabConfig, TerminalMode } from '../types';
import type { TrackedClone } from './clone-targets';
import type { SessionAuthority, AuthoritySession } from './session-authority';

type SessionLifecycleState = 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping';
export interface D1Session extends AuthoritySession {
  name: string;
  createdAt: string;
  lastAccessedAt: string;
  agentType?: AgentType;
  workspace: SessionWorkspace;
  terminalMode: TerminalMode;
  tabConfig?: TabConfig[];
  clone?: { repo: string; ref?: string };
  clones?: TrackedClone[];
  lifecycleGeneration: number;
  responseRevision: number;
  observationSequence: number;
  lastStartedAt?: string;
  lastActiveAt?: string;
  editorReady: boolean;
  editorReadyError: boolean;
  cpu?: string;
  memory?: string;
  disk?: string;
  syncStatus?: string;
  metricsObservedAt?: string;
  lastInputAt?: string;
  unreachableIncidentId?: string;
  unreachableFirstObservedAt?: string;
  unreachableDeadlineMs?: number;
  terminationIntentId?: string;
  terminationGeneration?: number;
  boundaryActivityId?: string;
}

type SessionRow = Record<string, string | number | null>;
const json = <T>(value: string | null): T | undefined => value ? JSON.parse(value) as T : undefined;
const optional = (value: string | null): string | undefined => value ?? undefined;

function fromRow(row: SessionRow): D1Session {
  return {
    ownerKey: String(row.owner_key), sessionId: String(row.session_id), name: String(row.name),
    createdAt: String(row.created_at), lastAccessedAt: String(row.last_accessed_at),
    agentType: optional(row.agent_type as string | null) as AgentType | undefined,
    workspace: row.workspace as SessionWorkspace, terminalMode: row.terminal_mode as TerminalMode,
    tabConfig: json<TabConfig[]>(row.tab_config_json as string | null),
    clone: json<{ repo: string; ref?: string }>(row.clone_json as string | null),
    clones: json<TrackedClone[]>(row.clones_json as string | null),
    lifecycleState: row.lifecycle_state as SessionLifecycleState,
    lifecycleGeneration: Number(row.lifecycle_generation), responseRevision: Number(row.response_revision), observationSequence: Number(row.observation_sequence),
    lastStartedAt: optional(row.last_started_at as string | null), lastActiveAt: optional(row.last_active_at as string | null),
    editorReady: row.editor_ready === 1, editorReadyError: row.editor_ready_error === 1,
    cpu: optional(row.cpu as string | null), memory: optional(row.memory as string | null), disk: optional(row.disk as string | null),
    syncStatus: optional(row.sync_status as string | null), metricsObservedAt: optional(row.metrics_observed_at as string | null), lastInputAt: optional(row.last_input_at as string | null),
    unreachableIncidentId: optional(row.unreachable_incident_id as string | null), unreachableFirstObservedAt: optional(row.unreachable_first_observed_at as string | null),
    unreachableDeadlineMs: row.unreachable_deadline_ms === null ? undefined : Number(row.unreachable_deadline_ms),
    terminationIntentId: optional(row.termination_intent_id as string | null), terminationGeneration: row.termination_generation === null ? undefined : Number(row.termination_generation),
    boundaryActivityId: optional(row.boundary_activity_id as string | null),
  };
}

export class D1SessionRepository implements SessionAuthority {
  constructor(private readonly db: D1Database) {}

  async isAdmissionOpen(): Promise<boolean> {
    return (await this.db.prepare('SELECT state FROM session_cutover WHERE id = 1').first<{ state: string }>())?.state === 'complete';
  }

  async create(session: Omit<D1Session, 'lifecycleState' | 'lifecycleGeneration' | 'responseRevision' | 'observationSequence' | 'editorReady' | 'editorReadyError'>): Promise<D1Session> {
    const now = session.createdAt;
    const result = await this.db.prepare(`INSERT INTO runtime_sessions
      (owner_key, session_id, name, created_at, last_accessed_at, agent_type, workspace, terminal_mode,
       tab_config_json, clone_json, clones_json, lifecycle_state, lifecycle_generation, response_revision,
       observation_sequence, editor_ready, editor_ready_error, transitioned_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'stopped', 0, 0, -1, 0, 0, ?4
      WHERE EXISTS (SELECT 1 FROM session_cutover WHERE id=1 AND state='complete')`)
      .bind(session.ownerKey, session.sessionId, session.name, now, session.lastAccessedAt, session.agentType ?? null,
        session.workspace, session.terminalMode, session.tabConfig ? JSON.stringify(session.tabConfig) : null,
        session.clone ? JSON.stringify(session.clone) : null, session.clones ? JSON.stringify(session.clones) : null).run();
    if (result.meta.changes !== 1) throw new Error('Session admission is closed');
    return {
      ...session,
      lifecycleState: 'stopped',
      lifecycleGeneration: 0,
      responseRevision: 0,
      observationSequence: -1,
      editorReady: false,
      editorReadyError: false,
    };
  }

  async getSession(ownerKey: string, sessionId: string): Promise<D1Session | null> {
    const row = await this.db.prepare('SELECT * FROM runtime_sessions WHERE owner_key=?1 AND session_id=?2').bind(ownerKey, sessionId).first<SessionRow>();
    return row ? fromRow(row) : null;
  }

  async listSessions(ownerKey: string): Promise<D1Session[]> {
    const result = await this.db.prepare('SELECT * FROM runtime_sessions WHERE owner_key=?1 ORDER BY last_accessed_at DESC, session_id ASC').bind(ownerKey).all<SessionRow>();
    return result.results.map(fromRow);
  }

  async start(ownerKey: string, sessionId: string, transitionedAt: string): Promise<D1Session | null> {
    const result = await this.db.prepare(`UPDATE runtime_sessions SET lifecycle_state='starting',
      lifecycle_generation=lifecycle_generation+1, response_revision=response_revision+1,
      observation_sequence=-1, editor_ready=0, editor_ready_error=0,
      transitioned_at=?3, lifecycle_reason=NULL
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_state='stopped'
        AND termination_intent_id IS NULL AND boundary_activity_id IS NULL
        AND EXISTS (SELECT 1 FROM session_cutover WHERE id=1 AND state='complete')`)
      .bind(ownerKey, sessionId, transitionedAt).run();
    return result.meta.changes === 1 ? this.getSession(ownerKey, sessionId) : null;
  }

  async claimStop(ownerKey: string, sessionId: string, intentId: string, claimedAt: string): Promise<D1Session | null> {
    const result = await this.db.prepare(`UPDATE runtime_sessions SET lifecycle_state='stopping',
      termination_intent_id=?3, termination_generation=lifecycle_generation,
      termination_claimed_at=?4, transitioned_at=?4, response_revision=response_revision+1
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_state IN ('starting','running','unreachable')
        AND termination_intent_id IS NULL`)
      .bind(ownerKey, sessionId, intentId, claimedAt).run();
    return result.meta.changes === 1 ? this.getSession(ownerKey, sessionId) : null;
  }

  async confirmStopped(ownerKey: string, sessionId: string, generation: number, intentId: string, observedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE runtime_sessions SET lifecycle_state='stopped',
      transitioned_at=?5, last_active_at=?5, response_revision=response_revision+1,
      unreachable_incident_id=NULL, unreachable_first_observed_at=NULL, unreachable_deadline_ms=NULL,
      termination_intent_id=NULL, termination_generation=NULL, termination_claimed_at=NULL,
      termination_signal_accepted_at=NULL
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_generation=?3
        AND lifecycle_state='stopping' AND termination_intent_id=?4
        AND boundary_activity_id IS NULL`)
      .bind(ownerKey, sessionId, generation, intentId, observedAt).run();
    return result.meta.changes === 1;
  }

  /** A positive monitor may confirm the same generation before destroy resolves. */
  async confirmStoppedOrObserved(ownerKey: string, sessionId: string, generation: number, intentId: string, observedAt: string): Promise<boolean> {
    if (await this.confirmStopped(ownerKey, sessionId, generation, intentId, observedAt)) return true;
    const current = await this.getSession(ownerKey, sessionId);
    return current?.lifecycleState === 'stopped' && current.lifecycleGeneration === generation;
  }

  async recordBoundaryActionStart(ownerKey: string, sessionId: string, generation: number, activityId: string): Promise<boolean> {
    if (!activityId) return false;
    const result = await this.db.prepare(`UPDATE runtime_sessions SET boundary_activity_id=?4,
      response_revision=response_revision+1
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_generation=?3
        AND lifecycle_state='running'
        AND termination_intent_id IS NULL AND boundary_activity_id IS NULL`)
      .bind(ownerKey, sessionId, generation, activityId).run();
    if (result.meta.changes === 1) return true;
    return this.isBoundaryActionPending(ownerKey, sessionId, generation, activityId, true);
  }

  async isBoundaryActionPending(ownerKey: string, sessionId: string, generation: number, activityId: string,
    requireOpen = false): Promise<boolean> {
    if (!activityId) return false;
    const row = await this.db.prepare(`SELECT 1 AS pending FROM runtime_sessions
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_generation=?3 AND boundary_activity_id=?4
        AND (?5=0 OR (lifecycle_state='running' AND termination_intent_id IS NULL))`)
      .bind(ownerKey, sessionId, generation, activityId, requireOpen ? 1 : 0).first<{ pending: number }>();
    return row?.pending === 1;
  }

  async isBoundaryActionStartCurrent(ownerKey: string, sessionId: string, generation: number, activityId: string): Promise<boolean> {
    return this.isBoundaryActionPending(ownerKey, sessionId, generation, activityId, true);
  }

  /** Only a consumed, successfully completed Activity result may release the singleton for another review. */
  async releaseCompletedBoundaryAction(ownerKey: string, sessionId: string, generation: number, activityId: string): Promise<boolean> {
    if (!activityId) return false;
    const result = await this.db.prepare(`UPDATE runtime_sessions SET boundary_activity_id=NULL,
      response_revision=response_revision+1
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_generation=?3 AND boundary_activity_id=?4
        AND lifecycle_state='running' AND termination_intent_id IS NULL`)
      .bind(ownerKey, sessionId, generation, activityId).run();
    return result.meta.changes === 1;
  }

  async acknowledgeBoundaryCancellation(ownerKey: string, sessionId: string, generation: number, activityId: string): Promise<boolean> {
    if (!activityId) return false;
    const result = await this.db.prepare(`UPDATE runtime_sessions SET boundary_activity_id=NULL,
      response_revision=response_revision+1
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_generation=?3 AND boundary_activity_id=?4
        AND lifecycle_state='stopping' AND termination_intent_id IS NOT NULL`)
      .bind(ownerKey, sessionId, generation, activityId).run();
    return result.meta.changes === 1;
  }

  async project(ownerKey: string, sessionId: string, generation: number, sequence: number, projection: {
    lifecycleState?: 'starting' | 'running'; lastInputAt?: string; cpu?: string; memory?: string; disk?: string;
    syncStatus?: string; editorReady?: boolean; editorReadyError?: boolean; observedAt: string;
  }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE runtime_sessions SET
      lifecycle_state=COALESCE(?5,lifecycle_state), last_input_at=COALESCE(?6,last_input_at),
      cpu=?7, memory=?8, disk=?9, sync_status=?10, editor_ready=?11,
      editor_ready_error=?12, metrics_observed_at=?13, observation_sequence=?4,
      response_revision=response_revision+1
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_generation=?3 AND ?4>observation_sequence
        AND lifecycle_state IN ('starting','running','unreachable')
        AND termination_intent_id IS NULL`)
      .bind(ownerKey, sessionId, generation, sequence, projection.lifecycleState ?? null,
        projection.lastInputAt ?? null, projection.cpu ?? null, projection.memory ?? null, projection.disk ?? null,
        projection.syncStatus ?? null, projection.editorReady ? 1 : 0, projection.editorReadyError ? 1 : 0,
        projection.observedAt).run();
    return result.meta.changes === 1;
  }

  async updateReadiness(ownerKey: string, sessionId: string, generation: number, editorReady: boolean, editorReadyError: boolean): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE runtime_sessions SET
      editor_ready=?4, editor_ready_error=?5, response_revision=response_revision+1
      WHERE owner_key=?1 AND session_id=?2 AND lifecycle_generation=?3
        AND lifecycle_state IN ('starting','running','unreachable')
        AND termination_intent_id IS NULL`)
      .bind(ownerKey, sessionId, generation, editorReady ? 1 : 0, editorReadyError ? 1 : 0).run();
    return result.meta.changes === 1;
  }

  async updateTrackedClones(ownerKey: string, sessionId: string, clones: TrackedClone[]): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE runtime_sessions SET clones_json=?3, response_revision=response_revision+1
      WHERE owner_key=?1 AND session_id=?2`).bind(ownerKey, sessionId, JSON.stringify(clones)).run();
    return result.meta.changes === 1;
  }

  async updateMutable(ownerKey: string, sessionId: string, update: { name?: string; tabConfig?: TabConfig[]; lastAccessedAt: string }): Promise<D1Session | null> {
    const result = await this.db.prepare(`UPDATE runtime_sessions SET
      name=COALESCE(?3, name), tab_config_json=COALESCE(?4, tab_config_json),
      last_accessed_at=?5, response_revision=response_revision+1
      WHERE owner_key=?1 AND session_id=?2`)
      .bind(ownerKey, sessionId, update.name ?? null, update.tabConfig ? JSON.stringify(update.tabConfig) : null, update.lastAccessedAt).run();
    return result.meta.changes === 1 ? this.getSession(ownerKey, sessionId) : null;
  }

  async deleteOwnerSessions(ownerKey: string): Promise<number> {
    const result = await this.db.prepare('DELETE FROM runtime_sessions WHERE owner_key=?1 AND boundary_activity_id IS NULL').bind(ownerKey).run();
    return result.meta.changes;
  }

  async deleteConfirmed(ownerKey: string, sessionId: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM runtime_sessions WHERE owner_key=?1 AND session_id=?2 AND lifecycle_state='stopped' AND boundary_activity_id IS NULL").bind(ownerKey, sessionId).run();
    return result.meta.changes === 1;
  }
}
