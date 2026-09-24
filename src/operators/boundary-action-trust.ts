/** Target-repository workflow trust is distinct from operator release provenance. */
export interface BoundaryActionBinding {
  repositoryId: number;
  installationId: string;
  workflowId: number;
  workflowPath: string;
  protectedRef: string;
  workflowDigest: string;
  events: string[];
  controlsRevision: number;
}

export type ActionSelection = { selection: 'local' | 'unavailable' }
  | { selection: 'remote'; installationId: string; controlsRevision: number };

/** Only a confirmed absent binding and absent target workflow permit local fallback. */
export async function resolveBoundaryAction(input: {
  action: BoundaryActionBinding | null;
  repository: { id: number; full_name: string; default_branch: string } | null;
  workflow: { id: number; path: string; state: string } | null;
  branch: { name: string; protected: boolean; commit: { sha: string } } | null;
  contents: { content: string; encoding: string } | null;
  event: string;
  workflowLookup?: 'not-found' | 'found' | 'unavailable';
}): Promise<ActionSelection> {
  if (!input.action) return input.workflowLookup === 'not-found' ? { selection: 'local' } : { selection: 'unavailable' };
  const { action, repository, workflow, branch, contents, event } = input;
  if (!repository || !workflow || !branch || !contents
    || repository.id !== action.repositoryId || !Number.isSafeInteger(action.repositoryId)
    || action.repositoryId <= 0 || !Number.isSafeInteger(action.workflowId) || action.workflowId <= 0
    || !action.installationId || !Number.isSafeInteger(action.controlsRevision) || action.controlsRevision < 1
    || workflow.id !== action.workflowId || workflow.path !== action.workflowPath || workflow.state !== 'active'
    || action.workflowPath.startsWith('/') || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(action.workflowPath)
    || action.protectedRef !== `refs/heads/${repository.default_branch}`
    || branch.name !== repository.default_branch || !branch.protected
    || !/^[a-f0-9]{40}$/i.test(branch.commit?.sha) || contents.encoding !== 'base64'
    || event !== 'pull_request_target' || !action.events.includes('pull_request_target')
    || !/^[a-f0-9]{64}$/i.test(action.workflowDigest)) {
    return { selection: 'unavailable' };
  }
  try {
    if (contents.content.length > 128 * 1024 || !/^[A-Za-z0-9+/\r\n=]+$/.test(contents.content)) return { selection: 'unavailable' };
    const encoded = contents.content.replace(/\s/g, '');
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== action.workflowDigest.toLowerCase()) return { selection: 'unavailable' };
  } catch { return { selection: 'unavailable' }; }
  return { selection: 'remote', installationId: action.installationId, controlsRevision: action.controlsRevision };
}
