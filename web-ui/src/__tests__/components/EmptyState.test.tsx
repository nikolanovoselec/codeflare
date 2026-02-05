import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import EmptyState from '../../components/EmptyState';
import { mdiCloudOutline, mdiPlus, mdiMagnify } from '@mdi/js';

describe('EmptyState Component', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Default Rendering', () => {
    it('should render with required props', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description text"
        />
      ));

      const emptyState = screen.getByTestId('empty-state');
      expect(emptyState).toBeInTheDocument();
    });

    it('should render icon', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
        />
      ));

      const icon = screen.getByTestId('empty-state-icon');
      expect(icon).toBeInTheDocument();
      expect(icon.querySelector('svg')).toBeInTheDocument();
    });

    it('should render title', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Welcome to Codeflare"
          description="Test description"
        />
      ));

      const title = screen.getByTestId('empty-state-title');
      expect(title).toBeInTheDocument();
      expect(title).toHaveTextContent('Welcome to Codeflare');
    });

    it('should render description', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Your personal Claude Code environment in the cloud."
        />
      ));

      const description = screen.getByTestId('empty-state-description');
      expect(description).toBeInTheDocument();
      expect(description).toHaveTextContent('Your personal Claude Code environment in the cloud.');
    });
  });

  describe('Custom testId', () => {
    it('should use custom testId when provided', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
          testId="empty-state-no-sessions"
        />
      ));

      const emptyState = screen.getByTestId('empty-state-no-sessions');
      expect(emptyState).toBeInTheDocument();
    });
  });

  describe('Action Button', () => {
    it('should render action button when action prop is provided', () => {
      const handleClick = vi.fn();

      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
          action={{
            label: 'New Session',
            onClick: handleClick,
            icon: mdiPlus,
          }}
        />
      ));

      const actionContainer = screen.getByTestId('empty-state-action');
      expect(actionContainer).toBeInTheDocument();

      const button = screen.getByTestId('button');
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent('New Session');
    });

    it('should call onClick when action button is clicked', () => {
      const handleClick = vi.fn();

      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
          action={{
            label: 'Click Me',
            onClick: handleClick,
          }}
        />
      ));

      const button = screen.getByTestId('button');
      fireEvent.click(button);

      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('should not render action button when action prop is not provided', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
        />
      ));

      const actionContainer = screen.queryByTestId('empty-state-action');
      expect(actionContainer).not.toBeInTheDocument();
    });

    it('should render action button with icon', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
          action={{
            label: 'New Session',
            onClick: () => {},
            icon: mdiPlus,
          }}
        />
      ));

      const button = screen.getByTestId('button');
      const icons = button.querySelectorAll('svg');
      expect(icons.length).toBeGreaterThan(0);
    });
  });

  describe('Hint', () => {
    it('should render hint when hint prop is provided', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
          hint="Cmd+N"
        />
      ));

      const hint = screen.getByTestId('empty-state-hint');
      expect(hint).toBeInTheDocument();
      expect(hint).toHaveTextContent('Cmd+N');
    });

    it('should not render hint when hint prop is not provided', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
        />
      ));

      const hint = screen.queryByTestId('empty-state-hint');
      expect(hint).not.toBeInTheDocument();
    });

    it('should render keyboard icon in hint', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
          hint="Cmd+N"
        />
      ));

      const hint = screen.getByTestId('empty-state-hint');
      const icon = hint.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('Animations', () => {
    it('should have fadeIn animation class', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
        />
      ));

      const emptyState = screen.getByTestId('empty-state');
      expect(emptyState).toHaveClass('animate-fadeIn');
    });

    it('should have float animation class on icon', () => {
      render(() => (
        <EmptyState
          icon={mdiCloudOutline}
          title="Test Title"
          description="Test description"
        />
      ));

      const icon = screen.getByTestId('empty-state-icon');
      expect(icon).toHaveClass('animate-float');
    });
  });

  describe('Different Variants', () => {
    it('should render no sessions variant correctly', () => {
      render(() => (
        <EmptyState
          testId="empty-state-no-sessions"
          icon={mdiCloudOutline}
          title="Welcome to Codeflare"
          description="Your personal Claude Code environment in the cloud."
          action={{
            label: 'New Session',
            onClick: () => {},
            icon: mdiPlus,
          }}
          hint="Cmd+N"
        />
      ));

      expect(screen.getByTestId('empty-state-no-sessions')).toBeInTheDocument();
      expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Welcome to Codeflare');
      expect(screen.getByTestId('empty-state-action')).toBeInTheDocument();
      expect(screen.getByTestId('empty-state-hint')).toBeInTheDocument();
    });

    it('should render no results variant correctly', () => {
      render(() => (
        <EmptyState
          testId="empty-state-no-results"
          icon={mdiMagnify}
          title="No Results Found"
          description="No sessions match your search. Try a different query."
        />
      ));

      expect(screen.getByTestId('empty-state-no-results')).toBeInTheDocument();
      expect(screen.getByTestId('empty-state-title')).toHaveTextContent('No Results Found');
      expect(screen.queryByTestId('empty-state-action')).not.toBeInTheDocument();
      expect(screen.queryByTestId('empty-state-hint')).not.toBeInTheDocument();
    });
  });
});
