export const ALL_REVIEW_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"];

export function isPrBoundaryCommand(command: string): boolean {
  return /(^|[;&|]\s*)git\s+push\b/.test(command) || /(^|[;&|]\s*)gh\s+pr\s+(create|merge)\b/.test(command);
}

export function isFailedToolExecution(event: any): boolean {
  return event?.isError === true || event?.error === true || String(event?.status ?? "").toLowerCase() === "error";
}

export function isCurrentReviewHead(pendingHead: string, prHead: string | undefined, localHead: string | undefined): boolean {
  return prHead === pendingHead || localHead === pendingHead;
}

export type ReviewCompletionState = {
  head: string;
  lanes: string[];
  spawned: boolean;
  spawnedIds?: Record<string, string>;
  fallbackLanes?: string[];
};

export function isReviewCompletionForLane(state: ReviewCompletionState, type: string, completionId?: string, prompt?: string): boolean {
  if (!state.lanes.includes(type)) return false;
  const spawnedId = state.spawnedIds?.[type];
  if (spawnedId) return completionId === spawnedId;
  if (state.fallbackLanes?.includes(type)) return prompt !== undefined && prompt.includes(state.head);
  if (state.spawned) return prompt !== undefined && prompt.includes(state.head);
  return true;
}

export function classifyReviewFiles(files: string[] | undefined): string[] | undefined {
  if (files === undefined) return ALL_REVIEW_LANES;
  if (files.length === 0) return [];
  let hasBehavioral = false;
  let touchesSdd = false;
  let touchesDocs = false;
  for (const file of files) {
    if (file.startsWith("sdd/")) touchesSdd = true;
    else if (file.startsWith("documentation/") || ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE"].includes(file)) touchesDocs = true;
    else hasBehavioral = true;
  }
  if (hasBehavioral) return ALL_REVIEW_LANES;
  if (touchesSdd) return ["spec-reviewer", "doc-updater"];
  if (touchesDocs) return ["doc-updater"];
  return [];
}

export default function () {
  // Helper module for review-enforcement.ts; no extension registration needed.
}
