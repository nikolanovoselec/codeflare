export interface ManagedExtensionIdentity {
  readonly id: string;
}

export const MANAGED_OPENVSCODE_SETTING_KEYS: readonly string[];
export function buildBaseOpenVscodeSettings(managedExtensions?: readonly ManagedExtensionIdentity[]): Record<string, unknown>;
export function buildPiOpenVscodeSettings(managedExtensions?: readonly ManagedExtensionIdentity[]): Record<string, unknown>;
export function buildUnsupportedOpenVscodeSettings(managedExtensions?: readonly ManagedExtensionIdentity[]): Record<string, unknown>;
export function buildOpenVscodeSettings(
  claudeConfigDirectory: string,
  managedExtensions?: readonly ManagedExtensionIdentity[],
): Record<string, unknown>;
export function buildManagedSettings(): Record<string, unknown>;
