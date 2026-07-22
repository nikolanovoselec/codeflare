export const MANAGED_SETTINGS_PATH = "/etc/codeflare/claude-sidebar/settings.json";

export const SIDEBAR_LINK_ALLOWLIST = Object.freeze([
  ".credentials.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "plugins",
  "skills",
]);

export async function prepareSidebarConfig(_options) {
  throw new Error("NOT_IMPLEMENTED: prepare-sidebar-config projection");
}
