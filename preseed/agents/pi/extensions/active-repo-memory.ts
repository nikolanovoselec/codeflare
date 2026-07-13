const ACTIVE_REPO_KEY = Symbol.for("codeflare.activeRepo");

type ActiveRepoMemory = typeof globalThis & {
  [ACTIVE_REPO_KEY]?: string;
};

const activeRepoMemory = globalThis as ActiveRepoMemory;

export function rememberActiveRepo(repo: string | undefined): void {
  if (repo) activeRepoMemory[ACTIVE_REPO_KEY] = repo;
}

export function recallActiveRepo(): string | undefined {
  return activeRepoMemory[ACTIVE_REPO_KEY];
}

export default function activeRepoMemoryExtension(_pi?: unknown): void {
  // Shared module imported by default- and advanced-mode Pi extensions.
}
