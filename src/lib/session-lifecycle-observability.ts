type TransitionReason = 'user_stop' | 'idle_stop' | 'quota_stop' | 'recovery_expiry' | 'd1_outage' | 'host_transport_loss' | 'platform_unknown';
type TransitionContext = { sessionId: string; generation: number; incidentId: string };
type TransitionLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

function fields(context: TransitionContext, extra: Record<string, unknown> = {}) {
  return {
    sessionId: context.sessionId,
    lifecycleGeneration: context.generation,
    incidentId: context.incidentId,
    ...extra,
  };
}

export function createLifecycleTransitionLogger(logger: TransitionLogger) {
  return {
    incidentOpened: (context: TransitionContext, detail: { reason: TransitionReason; deadlineMs: number }) => logger.warn('unreachable_incident_opened', fields(context, detail)),
    reconstructionStarted: (context: TransitionContext) => logger.info('reconstruction_started', fields(context)),
    recoverySucceeded: (context: TransitionContext) => logger.info('recovery_succeeded', fields(context)),
    terminationClaimed: (context: TransitionContext, detail: { reason: TransitionReason }) => logger.info('termination_claimed', fields(context, detail)),
    signalAccepted: (context: TransitionContext) => logger.info('signal_accepted', fields(context)),
    signalFailed: (context: TransitionContext, _error: unknown) => logger.error('signal_failed', fields(context, { errorClass: 'signal_failed' })),
    finalSyncCompleted: (context: TransitionContext, detail: { outcome: 'success' | 'failed' }) => logger.info('final_sync_completed', fields(context, detail)),
    exitConfirmed: (context: TransitionContext, detail: { reason: TransitionReason }) => logger.info('process_exit_confirmed', fields(context, detail)),
  };
}
