import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';

// RepoRow opens ClonePicker, which pulls in the api + session store. Mock both
// so the row renders in isolation and the picker mounts on click.
vi.mock('../../api/github', () => ({
  cloneIntoSession: vi.fn(),
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get sessions() {
      return [];
    },
    get enterpriseMode() {
      return false;
    },
    get preferences() {
      return { lastAgentType: undefined };
    },
    createSessionWithClone: vi.fn(),
  },
}));

vi.mock('../../components/Icon', () => ({
  default: (props: { path: string; size?: number; class?: string }) => (
    <span data-testid="mock-icon" data-path={props.path} class={props.class} />
  ),
}));

import RepoRow from '../../components/github/RepoRow';

const REPO = {
  full_name: 'octocat/hello',
  name: 'hello',
  owner: 'octocat',
  private: false,
  visibility: 'public',
  default_branch: 'trunk',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('RepoRow Clone button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders an enabled Clone button carrying repo + branch data', () => {
    render(() => <RepoRow repo={REPO} />);

    const btn = screen.getByTestId('github-repo-clone-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('data-repo')).toBe('octocat/hello');
    expect(btn.getAttribute('data-branch')).toBe('trunk');
  });

  it('opens the ClonePicker when the Clone button is clicked', () => {
    render(() => <RepoRow repo={REPO} />);

    expect(screen.queryByTestId('clone-picker')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('github-repo-clone-btn'));

    const picker = screen.getByTestId('clone-picker');
    expect(picker).toBeInTheDocument();
    expect(picker.getAttribute('data-repo')).toBe('octocat/hello');
  });

  it('toggles the picker closed on a second click', () => {
    render(() => <RepoRow repo={REPO} />);

    const btn = screen.getByTestId('github-repo-clone-btn');
    fireEvent.click(btn);
    expect(screen.getByTestId('clone-picker')).toBeInTheDocument();

    fireEvent.click(btn);
    expect(screen.queryByTestId('clone-picker')).not.toBeInTheDocument();
  });
});
