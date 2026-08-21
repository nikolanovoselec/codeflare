/** Compile-only Phase 1 seam. Behavior follows the red CI receipt. */
export function sessionPath(_sessionId: string): string {
  return '/app/';
}

/** Compile-only Phase 1 seam. Behavior follows the red CI receipt. */
export function parseSessionPath(_pathname: string): string | undefined {
  return undefined;
}

export function dashboardPath(): string {
  return '/app/';
}
