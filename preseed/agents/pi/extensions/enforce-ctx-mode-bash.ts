/**
 * Legacy compatibility shim.
 *
 * Older Pi sessions may already have ~/.pi/agent/extensions/enforce-ctx-mode-bash.ts.
 * Keeping this path in the preseed manifest overwrites stale local copies during
 * agent-skill recreation; the canonical implementation lives in
 * context-mode-enforcement.ts.
 */

export default function () {
  // Intentionally empty. Use context-mode-enforcement.ts.
}
