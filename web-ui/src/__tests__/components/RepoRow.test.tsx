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
    get allowedAgents() {
      return ['pi', 'bash'];
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

// REQ-GITHUB-004: Clone a repository into a session

describe('RepoRow Clone button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps a recent update labeled today in the repository browser', () => {
    const updated_at = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    render(() => <RepoRow repo={{ ...REPO, updated_at }} />);
    expect(screen.getByText('today', { exact: true })).toBeVisible();
  });

  it('keeps keyboard focus in the clone dialog and returns it on Escape', () => {
    render(() => <RepoRow repo={REPO} />);
    const trigger = screen.getByRole('button', { name: /clone/i });
    trigger.focus();
    fireEvent.click(trigger, { detail: 0 });
    const dialog = screen.getByRole('dialog');
    const options = Array.from(dialog.querySelectorAll('button:not([disabled])'));
    const first = options[0]!;
    const last = options.at(-1)!;
    expect(first).toHaveFocus();
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(last).toHaveFocus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false);
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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
