import type { ExtensionContext } from 'vscode';

/**
 * Intentionally inert package entry point. Backend registration and visible-view
 * resolution remain RED behind the behavioral contracts in test/.
 */
export function activate(context: ExtensionContext): void {
  void context;
}

export async function deactivate(): Promise<void> {
  // No process can exist while the package remains an inert shell.
}
