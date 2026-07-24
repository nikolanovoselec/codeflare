import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function sidebarApproval(_pi: ExtensionAPI): void {
  // The Browser IDE runs inside the user's ephemeral session container.
  // Keep Pi's standard built-in tools unrestricted.
}
