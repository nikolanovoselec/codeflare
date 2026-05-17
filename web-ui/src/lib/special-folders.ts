/**
 * Special folders surfaced in the R2 Storage panel.
 *
 * These four prefixes correspond to in-container directories that codeflare
 * auto-creates and rclone-bisyncs:
 *
 *   workspace/  <-> /home/user/Workspace  (user-toggleable via "Sync workspace folder")
 *   Vault/      <-> /home/user/Vault      (persistent notes, edited via SilverBullet)
 *   Uploads/    <-> /home/user/Uploads    (drag-zone for files)
 *   Temporary/  <-> /home/user/Temporary  (scratch space; survives via R2)
 *
 * The Storage panel renders each as a folder row with an info icon that
 * expands a tooltip explaining the purpose and the container path. The
 * Workspace row is only present when workspace sync is enabled in settings;
 * the other three are always present.
 *
 * Adding a new special folder is a three-place change:
 *   1. Add an entry here (with id, prefix, label, description, containerPath).
 *   2. Ensure entrypoint.sh auto-creates the directory in init_user_vault().
 *   3. Add the corresponding rclone include filter to RCLONE_FILTERS_COMMON
 *      (placed before the global graphify-out exclude) so the new prefix
 *      rides along on the next bisync.
 */
export interface SpecialFolder {
  /** Stable id used in test selectors and tooltip data-testids. */
  id: string;
  /** R2 prefix (with trailing slash) that triggers this folder's UI. */
  prefix: string;
  /** Display label shown in the Storage panel. */
  label: string;
  /** Tooltip body explaining what the folder is for. */
  description: string;
  /** In-container path the bisync materialises this prefix at. */
  containerPath: string;
}

export const SPECIAL_FOLDERS: SpecialFolder[] = [
  {
    id: 'workspace',
    prefix: 'workspace/',
    label: 'Workspace',
    description: 'Holds your codebase and other assets. Disabling sync in settings is recommended; clone your repositories fresh every session.',
    containerPath: '/home/user/Workspace',
  },
  {
    id: 'vault',
    prefix: 'Vault/',
    label: 'Vault',
    description: 'Persistent notes edited via SilverBullet (Vault button in the header). Every file is ingested into the unified graph so cross-session memory queries find it.',
    containerPath: '/home/user/Vault',
  },
  {
    id: 'uploads',
    prefix: 'Uploads/',
    label: 'Uploads',
    description: 'Drag-zone for files you want to keep across sessions. Anything dropped here is available inside the container and on every device.',
    containerPath: '/home/user/Uploads',
  },
  {
    id: 'temporary',
    prefix: 'Temporary/',
    label: 'Temporary',
    description: 'Scratch space. Files here persist across sessions via R2 sync, but treat the folder as transient: prune freely.',
    containerPath: '/home/user/Temporary',
  },
];

const SPECIAL_FOLDERS_BY_PREFIX: Map<string, SpecialFolder> = new Map(
  SPECIAL_FOLDERS.map((f) => [f.prefix, f]),
);

/**
 * Look up the SpecialFolder metadata for a given R2 prefix, or null if the
 * prefix is not a special folder.
 */
export function getSpecialFolder(prefix: string): SpecialFolder | null {
  return SPECIAL_FOLDERS_BY_PREFIX.get(prefix) ?? null;
}

/**
 * Prefixes that should always appear at the root of the Storage panel
 * regardless of whether R2 has any objects under them yet. Workspace is
 * intentionally excluded because its visibility is gated by the
 * "Sync workspace folder" preference and handled by the caller.
 */
export const ALWAYS_VISIBLE_SPECIAL_PREFIXES: string[] = SPECIAL_FOLDERS
  .filter((f) => f.id !== 'workspace')
  .map((f) => f.prefix);
