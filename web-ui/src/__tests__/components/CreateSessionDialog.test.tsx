import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { mdiFire } from '@mdi/js';
import CreateSessionDialog from '../../components/CreateSessionDialog';

const sessionStoreState = vi.hoisted(() => ({
  preferences: { lastAgentType: undefined as string | undefined },
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get preferences() {
      return sessionStoreState.preferences;
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
  });

  afterEach(() => {
    cleanup();
  });

  it('uses fire icon for Claude Unleashed option', () => {
    render(() => (
      <CreateSessionDialog
        isOpen={true}
        onClose={() => {}}
        onSelect={() => {}}
      />
    ));

    const claudeUnleashed = screen.getByTestId('csd-agent-claude-unleashed');
    const icon = claudeUnleashed.querySelector('[data-testid="mock-icon"]');

    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-path', mdiFire);
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
    it('renders all 5 agent options', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      expect(screen.getByTestId('csd-agent-claude-unleashed')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-claude-code')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-codex')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-gemini')).toBeInTheDocument();
      expect(screen.getByTestId('csd-agent-bash')).toBeInTheDocument();
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
  });

  describe('Agent descriptions', () => {
    it('shows description text for each agent', () => {
      render(() => (
        <CreateSessionDialog
          isOpen={true}
          onClose={() => {}}
          onSelect={() => {}}
        />
      ));

      expect(screen.getByText('Full Claude Code experience')).toBeInTheDocument();
      expect(screen.getByText('Official Claude Code CLI')).toBeInTheDocument();
      expect(screen.getByText('OpenAI Codex agent')).toBeInTheDocument();
      expect(screen.getByText('Google Gemini CLI')).toBeInTheDocument();
      expect(screen.getByText('Plain terminal session')).toBeInTheDocument();
    });
  });
});
