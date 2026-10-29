// Explicit --extension entry, not a globally activated Pi package.
// The selected package's pi.extensions manifest names this public stock factory.
import stockBridge from '/opt/codeflare/pi-agent/npm/node_modules/@blackbelt-technology/pi-dashboard-extension/src/bridge.ts';
import primaryIdentity, { activatePrimaryBridge } from './primary-identity.mjs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI): void {
  // Withdraw identity before the stock bridge unregisters on shutdown/reload.
  // Readers cannot acquire stale authority from the upstream ended-session row.
  primaryIdentity(pi);
  activatePrimaryBridge(pi, stockBridge);
}
