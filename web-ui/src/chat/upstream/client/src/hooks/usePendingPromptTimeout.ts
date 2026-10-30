import { useEffect, useRef } from "react";

const TIMEOUT_MS = 30_000;

/**
 * Safety timeout for pending prompts.
 *
 * Calls `onTimeout` after 30s if `hasPendingPrompt` remains true AND the
 * timer is not paused. Pass `paused: true` to suppress the timer while the
 * prompt is acknowledged by the bridge queue (per modified
 * `pending-prompt-safety` capability + change `surface-mid-turn-prompt-queue`).
 *
 * The timer (re)starts whenever `paused` flips from true back to false,
 * giving us the "resume after entry leaves queue" behavior the spec
 * requires.
 */
export function usePendingPromptTimeout(
  hasPendingPrompt: boolean,
  onTimeout: () => void,
  paused: boolean = false,
): void {
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!hasPendingPrompt) return;
    if (paused) return;
    const timer = setTimeout(() => {
      onTimeoutRef.current();
    }, TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [hasPendingPrompt, paused]);
}
