import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { mdiRobotOutline, mdiRobotIndustrial, mdiGithub } from '@mdi/js';
import CreateSessionDialog from '../../components/CreateSessionDialog';

const sessionStoreState = vi.hoisted(() => ({
  preferences: { lastAgentType: undefined as string | undefined },
  enterpriseMode: false as boolean,
  allowedAgents: null as string[] | null,
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get preferences() {
      return sessionStoreState.preferences;
    },
    get enterpriseMode() {
      return sessionStoreState.enterpriseMode;
    },
    get allowedAgents() {
      return sessionStoreState.allowedAgents;
    },
  },
}));

vi.mock('../../components/Icon', () => ({
  default: (props: { path: string; size?: number; class?: string }) => (
    <span data-testid="mock-icon" data-path={props.path} data-size={props.size} class={props.class} />
  ),
}));

describe('CreateSessionDialog', () => {
  beforeEach(() => {
    sessionStoreState.preferences = { lastAgentType: undefined };
    sessionStoreState.enterpriseMode = false;
    sessionStoreState.allowedAgents = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('uses robot icon for Claude Code option', () => {
    render(() => (
      <CreateSessionDialog
        isOpen={true}
        onClose={() => {}}
        onSelect={() => {}}
      />
    ));

    const claudeCode = screen.getByTestId('csd-agent-claude-code');
    const icon = claudeCode.querySelector('[data-testid="mock-icon"]');

    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-path', mdiRobotOutline);
  });

  describe('Dialog open/close', () => {
    it('renders dialog when isOpen is true', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      expect(screen.getByTestId('create-session-dialog')).toBeInTheDocument();
    });

    it('does not render dialog when isOpen is false', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={false}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      expect(screen.queryByTestId('create-session-dialog')).not.toBeInTheDocument();
    });

    it('has role="dialog" and aria-label', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      const dialog = screen.getByTestId('create-session-dialog');
      expect(dialog).toHaveAttribute('role', 'dialog');
      expect(dialog).toHaveAttribute('aria-label', 'Create new session');
    });
  });

  describe('Agent type selection', () => {
    it('renders all 7 agent options', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      expect(screen.getByTestId('csd-agent-claude-code')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-codex')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-antigravity')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-copilot')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-opencode')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-pi')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-bash')).toBeInTheDocument();
    });

    // REQ-AGENT-002 AC6: a `beta` badge renders only on preview-status agents.
    // querySelector('.csd-agent-badge') searches the agent button's descendants,
    // so this holds regardless of the exact badge-span nesting.
    it('renders a beta badge only on preview-status agents (antigravity, opencode)', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      for (const type of ['antigravity', 'opencode']) {
        const card = screen.getByTestId(`csd-agent-${type}`);
        const badge = card.querySelector('.csd-agent-badge');
        expect(badge, `${type} should carry a beta badge`).not.toBeNull();
        expect(badge?.textContent).toBe('beta');
      }
      for (const type of ['claude-code', 'codex', 'copilot', 'pi', 'bash']) {
        const card = screen.getByTestId(`csd-agent-${type}`);
        expect(
          card.querySelector('.csd-agent-badge'),
          `${type} should not carry a beta badge`,
        ).toBeNull();
      }
    });

    it('does not render claude-unleashed option', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      expect(screen.queryByTestId('csd-agent-claude-unleashed')).not.toBeInTheDocument();
    });

    it('renders exactly 7 agent option buttons', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      const buttons = screen.getByTestId('create-session-dialog').querySelectorAll('.csd-agent-btn');
      expect(buttons).toHaveLength(7);
    });

    it('renders opencode option with correct label and icon', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      const opencode = screen.getByTestId('csd-agent-opencode');
      expect(opencode).toBeInTheDocument();
      expect(opencode.textContent).toContain('OpenCode');

      const icon = opencode.querySelector('[data-testid="mock-icon"]');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('data-path', mdiRobotIndustrial);
    });

    it('renders opencode option with correct description', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      const opencode = screen.getByTestId('csd-agent-opencode');
      expect(opencode.textContent).toContain('Multi-model agent');
    });

    it('highlights opencode as last used agent type', () => {
      sessionStoreState.preferences = { lastAgentType: 'opencode' };

      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      const opencodeBtn = screen.getByTestId('csd-agent-opencode');
      expect(opencodeBtn).toHaveClass('csd-agent-btn--last-used');

      // Other buttons should not have the last-used class
      const claudeCodeBtn = screen.getByTestId('csd-agent-claude-code');
      expect(claudeCodeBtn).not.toHaveClass('csd-agent-btn--last-used');
    });

    it('calls onSelect with opencode agent type', () => {
      const onSelect = vi.fn();
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={onSelect}
        />
      ));

      fireEvent.click(screen.getByTestId('csd-agent-opencode'));
      expect(onSelect).toHaveBeenCalledWith('opencode');
    });

    it('renders copilot option with correct label and icon', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      const copilot = screen.getByTestId('csd-agent-copilot');
      expect(copilot).toBeInTheDocument();
      expect(copilot.textContent).toContain('GitHub Copilot');

      const icon = copilot.querySelector('[data-testid="mock-icon"]');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('data-path', mdiGithub);
    });

    it('calls onSelect with copilot agent type', () => {
      const onSelect = vi.fn();
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={onSelect}
        />
      ));

      fireEvent.click(screen.getByTestId('csd-agent-copilot'));
      expect(onSelect).toHaveBeenCalledWith('copilot');
    });

    it('lists coding agents alphabetically by label with Bash last', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      const buttons = screen.getByTestId('create-session-dialog').querySelectorAll('.csd-agent-btn');
      const order = Array.from(buttons).map((btn) => btn.getAttribute('data-testid'));
      // Coding agents sorted A->Z by display label; Bash (non-agent fallback) pinned last.
      expect(order).toEqual([
        'csd-agent-antigravity',
        'csd-agent-claude-code',
        'csd-agent-codex',
        'csd-agent-copilot',
        'csd-agent-opencode',
        'csd-agent-pi',
        'csd-agent-bash',
      ]);
      // Regression guard: Antigravity must precede Claude Code.
      expect(order.indexOf('csd-agent-antigravity')).toBeLessThan(order.indexOf('csd-agent-claude-code'));
    });

    it('calls onSelect with correct agent type when clicked', () => {
      const onSelect = vi.fn();
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={onSelect}
        />
      ));

      fireEvent.click(screen.getByTestId('csd-agent-claude-code'));
      expect(onSelect).toHaveBeenCalledWith('claude-code');
    });

    it('calls onSelect with bash agent type', () => {
      const onSelect = vi.fn();
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={onSelect}
        />
      ));

      fireEvent.click(screen.getByTestId('csd-agent-bash'));
      expect(onSelect).toHaveBeenCalledWith('bash');
    });

    it('highlights last used agent type', () => {
      sessionStoreState.preferences = { lastAgentType: 'codex' };

      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      const codexBtn = screen.getByTestId('csd-agent-codex');
      expect(codexBtn).toHaveClass('csd-agent-btn--last-used');
    });
  });

  describe('Keyboard interaction', () => {
    it('calls onClose when Escape is pressed', () => {
      const onClose = vi.fn();
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={onClose}
          onSelect={() => {}}
        />
      ));

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();
    });

    it('does not call onClose on Escape when dialog is closed', () => {
      const onClose = vi.fn();
      render(() => (
        <CreateSessionDialog
          isOpen={false}
          onClose={onClose}
          onSelect={() => {}}
        />
      ));

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Backdrop', () => {
    it('calls onClose when backdrop is clicked', () => {
      const onClose = vi.fn();
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={onClose}
          onSelect={() => {}}
        />
      ));

      const backdrop = document.querySelector('.csd-backdrop') as HTMLElement;
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Positioning', () => {
    it('positions dialog below the anchor button (downward)', () => {
      const mockAnchor = document.createElement('button');
      Object.defineProperty(mockAnchor, 'getBoundingClientRect', {
        value: () => ({
          top: 100, bottom: 140, left: 50, right: 250,
          width: 200, height: 40, x: 50, y: 100, toJSON: () => {},
        }),
      });
      document.body.appendChild(mockAnchor);

      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
          anchorRef={mockAnchor}
        />
      ));

      const dialog = screen.getByTestId('create-session-dialog');
      // Dialog should use top positioning (opens downward)
      // top = rect.bottom + 8 = 140 + 8 = 148
      expect(dialog.style.top).toBe('148px');
      expect(dialog.style.left).toBe('50px');
      expect(dialog.style.width).toBe('200px');

      document.body.removeChild(mockAnchor);
    });

    it('clamps dialog within viewport when it would overflow bottom', () => {
      // Simulate a viewport height of 768px (jsdom default)
      Object.defineProperty(window, 'innerHeight', { value: 768, writable: true });

      const mockAnchor = document.createElement('button');
      // Button near the bottom of viewport: bottom at 750px
      Object.defineProperty(mockAnchor, 'getBoundingClientRect', {
        value: () => ({
          top: 710, bottom: 750, left: 50, right: 250,
          width: 200, height: 40, x: 50, y: 710, toJSON: () => {},
        }),
      });
      document.body.appendChild(mockAnchor);

      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
          anchorRef={mockAnchor}
        />
      ));

      const dialog = screen.getByTestId('create-session-dialog');
      const topValue = parseInt(dialog.style.top, 10);
      // The dialog should NOT be positioned at 758px (750 + 8) because that
      // would extend well past the viewport. It should be clamped.
      expect(topValue).toBeLessThan(750);

      document.body.removeChild(mockAnchor);
    });

    it('uses DIALOG_ESTIMATED_HEIGHT of 380 for positioning calculations', () => {
      // DIALOG_ESTIMATED_HEIGHT = 380. When anchor is near the bottom,
      // the dialog flips upward: top = rect.top - GAP - 380
      Object.defineProperty(window, 'innerHeight', { value: 500, writable: true });

      const mockAnchor = document.createElement('button');
      // Anchor near bottom: bottom at 490, only 2px space below (not enough for 380)
      // Space above: top at 450, which is > 380 so it flips upward
      Object.defineProperty(mockAnchor, 'getBoundingClientRect', {
        value: () => ({
          top: 450, bottom: 490, left: 50, right: 250,
          width: 200, height: 40, x: 50, y: 450, toJSON: () => {},
        }),
      });
      document.body.appendChild(mockAnchor);

      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
          anchorRef={mockAnchor}
        />
      ));

      const dialog = screen.getByTestId('create-session-dialog');
      const topValue = parseInt(dialog.style.top, 10);
      // Should flip upward: top = 450 - 8 - 380 = 62
      expect(topValue).toBe(62);

      document.body.removeChild(mockAnchor);
    });
  });

  describe('Agent selection (REQ-AGENT-002)', () => {
    it('renders one testid-keyed card per agent and reports the exact AgentType on click', () => {
      const onSelect = vi.fn();
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={onSelect}
        />
      ));

      // Each agent renders a card keyed by its AgentType (structural map),
      // not by its marketing description.
      const dialog = screen.getByTestId('create-session-dialog');
      const cards = dialog.querySelectorAll('[data-testid^="csd-agent-"]');
      expect(cards.length).toBeGreaterThanOrEqual(2);

      // Selecting a card is load-bearing: onSelect must receive that card's
      // AgentType verbatim (this is what create-session actually submits).
      fireEvent.click(screen.getByTestId('csd-agent-codex'));
      expect(onSelect).toHaveBeenCalledWith('codex');
      fireEvent.click(screen.getByTestId('csd-agent-bash'));
      expect(onSelect).toHaveBeenLastCalledWith('bash');
    });
  });

  // REQ-ENTERPRISE-003 / REQ-OPS-038: GET /api/user carries the resolved
  // deployment allowlist. Enterprise mode has a static gateway-capable fallback
  // until hydration; every mode honors a hydrated build-installed subset.
  describe('Deployment agent allowlist', () => {
    it('renders all 7 agents when enterpriseMode is false (default, unchanged)', () => {
      sessionStoreState.enterpriseMode = false;
      render(() => (
        <CreateSessionDialog isOpen={true} onClose={() => {}} onSelect={() => {}} />
      ));

      const buttons = screen.getByTestId('create-session-dialog').querySelectorAll('.csd-agent-btn');
      expect(buttons).toHaveLength(7);
    });

    it('renders only the wizard-activated agents delivered by /api/user', () => {
      sessionStoreState.enterpriseMode = true;
      sessionStoreState.allowedAgents = ['pi', 'bash'];
      render(() => (
        <CreateSessionDialog isOpen={true} onClose={() => {}} onSelect={() => {}} />
      ));

      const buttons = screen.getByTestId('create-session-dialog').querySelectorAll('.csd-agent-btn');
      expect(buttons).toHaveLength(2);
      expect(screen.getByTestId('csd-agent-pi')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-bash')).toBeInTheDocument();
      expect(screen.queryByTestId('csd-agent-copilot')).not.toBeInTheDocument();
    });

    it('renders only build-installed agents outside enterprise mode', () => {
      sessionStoreState.enterpriseMode = false;
      sessionStoreState.allowedAgents = ['claude-code', 'codex', 'pi', 'bash'];
      render(() => (
        <CreateSessionDialog isOpen={true} onClose={() => {}} onSelect={() => {}} />
      ));

      const buttons = screen.getByTestId('create-session-dialog').querySelectorAll('.csd-agent-btn');
      expect(buttons).toHaveLength(4);
      expect(screen.getByTestId('csd-agent-claude-code')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-codex')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-pi')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-bash')).toBeInTheDocument();
      expect(screen.queryByTestId('csd-agent-copilot')).not.toBeInTheDocument();
    });

    it('falls back to the static enterprise list until /api/user hydrates', () => {
      sessionStoreState.enterpriseMode = true;
      render(() => (
        <CreateSessionDialog isOpen={true} onClose={() => {}} onSelect={() => {}} />
      ));

      const buttons = screen.getByTestId('create-session-dialog').querySelectorAll('.csd-agent-btn');
      expect(buttons).toHaveLength(3);

      // Allowlisted agents present.
      expect(screen.getByTestId('csd-agent-copilot')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-pi')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-bash')).toBeInTheDocument();

      // Non-allowlisted agents hidden (Claude Code now excluded).
      expect(screen.queryByTestId('csd-agent-claude-code')).not.toBeInTheDocument();
      expect(screen.queryByTestId('csd-agent-antigravity')).not.toBeInTheDocument();
      expect(screen.queryByTestId('csd-agent-codex')).not.toBeInTheDocument();
      expect(screen.queryByTestId('csd-agent-opencode')).not.toBeInTheDocument();
    });
  });
});
