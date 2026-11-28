import { Component, Show, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mdiSourceBranch } from '@mdi/js';
import Icon from '../Icon';
import type { GithubRepo } from '../../api/github';
import ClonePicker from './ClonePicker';
import { formatRepoAge } from '../../lib/format';

interface RepoRowProps {
  vibeOnly?: boolean;
  repo: GithubRepo;
}

// One repository row. Renders name/full_name, a visibility badge driven by
// repo.private / repo.visibility, the relative updated time, and a "Clone"
// button that opens the ClonePicker anchored to it.
const RepoRow: Component<RepoRowProps> = (props) => {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [cloneBtnRef, setCloneBtnRef] = createSignal<HTMLButtonElement>();

  const isPrivate = () => props.repo.private;
  const visibilityLabel = () => props.repo.visibility || (isPrivate() ? 'private' : 'public');

  return (
    <div
      class="github-repo-row"
      data-testid="github-repo-row"
      data-full-name={props.repo.full_name}
      data-private={isPrivate() ? 'true' : 'false'}
    >
      <Icon path={mdiSourceBranch} size={16} class="github-repo-icon" />
      <a
        class="github-repo-main"
        data-testid="github-repo-link"
        href={`https://github.com/${props.repo.full_name}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        <span class="github-repo-name">{props.repo.name}</span>
        <span class="github-repo-fullname">{props.repo.full_name}</span>
      </a>
      <span
        class="github-repo-badge"
        classList={{
          'github-repo-badge--private': isPrivate(),
          'github-repo-badge--public': !isPrivate(),
        }}
        data-testid="github-repo-badge"
        data-visibility={visibilityLabel()}
      >
        {visibilityLabel()}
      </span>
      <span class="github-repo-updated" title={props.repo.updated_at}>
        {formatRepoAge(props.repo.updated_at, 'browser')}
      </span>
      <button
        type="button"
        ref={setCloneBtnRef}
        class="github-repo-clone-btn"
        data-testid="github-repo-clone-btn"
        data-repo={props.repo.full_name}
        data-branch={props.repo.default_branch}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen()}
        onClick={() => setPickerOpen((v) => !v)}
      >
        Clone
      </button>
      <Show when={pickerOpen()}>
        <Portal>
          <ClonePicker
            repo={props.repo}
            vibeOnly={props.vibeOnly}
            anchorRef={cloneBtnRef()}
            onClose={() => setPickerOpen(false)}
          />
        </Portal>
      </Show>
    </div>
  );
};

export default RepoRow;
