export interface ManagedExtensionIdentity {
  readonly id: string;
}

export const MANAGED_OPENVSCODE_SETTING_KEYS: readonly string[];
export type SessionWorkspace = "terminal" | "vscode";

export function buildBaseOpenVscodeSettings(
  managedExtensions?: readonly ManagedExtensionIdentity[],
  sessionWorkspace?: SessionWorkspace,
): Record<string, unknown>;
export function buildPiOpenVscodeSettings(
  managedExtensions?: readonly ManagedExtensionIdentity[],
  sessionWorkspace?: SessionWorkspace,
): Record<string, unknown>;
export function buildUnsupportedOpenVscodeSettings(
  managedExtensions?: readonly ManagedExtensionIdentity[],
  sessionWorkspace?: SessionWorkspace,
): Record<string, unknown>;
export function buildOpenVscodeSettings(
  claudeConfigDirectory: string,
  managedExtensions?: readonly ManagedExtensionIdentity[],
  sessionWorkspace?: SessionWorkspace,
): Record<string, unknown>;
export function buildManagedSettings(): Record<string, unknown>;
