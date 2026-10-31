// Explicit --extension entry, not a globally activated Pi package.
// The selected package's pi.extensions manifest names this public stock factory.
import stockBridge from '/opt/codeflare/pi-agent/npm/node_modules/@blackbelt-technology/pi-dashboard-extension/src/bridge.ts';
import primaryIdentity, { activatePrimaryBridge } from './primary-identity.mjs';
import primaryQuestions from './primary-questions.mjs';
import primaryConversations from './primary-conversations.mjs';
// Public package entry of the actual managed primary installation. This adapter
// is outside its node_modules ancestor tree, so a bare runtime import is unsafe.
import { SessionManager } from '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI): void {
  // Withdraw identity before the stock bridge unregisters on shutdown/reload.
  // Readers cannot acquire stale authority from the upstream ended-session row.
  primaryIdentity(pi);
  primaryConversations(pi, { listSessions: (cwd: string, sessionDir: string) => SessionManager.list(cwd, sessionDir) });
  const finishQuestionRegistration = primaryQuestions(pi);
  try {
    activatePrimaryBridge(pi, stockBridge);
  } finally {
    // Public session_start ordering restores the per-primary timeout setting
    // immediately after the stock bus captures it, before ordinary SDK work.
    finishQuestionRegistration();
  }
}
