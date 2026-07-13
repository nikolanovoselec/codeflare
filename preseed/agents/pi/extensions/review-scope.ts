export type ReviewScopeMode = "diff" | "all";

export type ReviewScopeContract = {
  mode: ReviewScopeMode;
  workSet: "changed-hunks-and-direct-invalidations" | "whole-requested-tree";
};

export function scopeContract(mode: ReviewScopeMode): ReviewScopeContract {
  return {
    mode,
    workSet: mode === "diff" ? "changed-hunks-and-direct-invalidations" : "whole-requested-tree",
  };
}

export function resolveReviewScope(args: string): ReviewScopeMode | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const modes = new Set<ReviewScopeMode>();
  for (const token of tokens) {
    if (token === "--diff" || token === "--scope=diff") modes.add("diff");
    if (token === "--all" || token === "--scope=all") modes.add("all");
  }
  return modes.size === 1 ? [...modes][0] : undefined;
}

export default function reviewScopeExtension(_pi?: unknown): void {
  // Shared pure scope contract imported by Pi command and boundary extensions.
}
