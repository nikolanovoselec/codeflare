import { createSignal } from 'solid-js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import InitProgressComponent from '../../components/InitProgress';
import type { InitProgress } from '../../types';

describe('InitProgress Component', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Hero Icon', () => {
    it('should render hero icon with correct testid', () => {
      const progress: InitProgress = {
        stage: 'creating',
        progress: 10,
        message: 'Creating session...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      expect(screen.getByTestId('init-progress-hero-icon')).toBeInTheDocument();
    });

    it('should show rocket icon for starting stage', () => {
      const progress: InitProgress = {
        stage: 'starting',
        progress: 30,
        message: 'Starting container...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const heroIcon = screen.getByTestId('init-progress-hero-icon');
      expect(heroIcon).toBeInTheDocument();
      // The icon changes based on stage - we just verify it renders
    });

    it('should show check icon for ready stage', () => {
      const progress: InitProgress = {
        stage: 'ready',
        progress: 100,
        message: 'Ready!',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const heroIcon = screen.getByTestId('init-progress-hero-icon');
      expect(heroIcon).toHaveClass('animate-bounce');
    });

    it('should apply float animation during loading stages', () => {
      const progress: InitProgress = {
        stage: 'syncing',
        progress: 50,
        message: 'Syncing workspace...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const heroIcon = screen.getByTestId('init-progress-hero-icon');
      expect(heroIcon).toHaveClass('animate-float');
    });
  });

  describe('Progress Bar', () => {
    it('should render progress bar with correct testid', () => {
      const progress: InitProgress = {
        stage: 'creating',
        progress: 25,
        message: 'Creating...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      expect(screen.getByTestId('init-progress-bar')).toBeInTheDocument();
    });

    it('should set progress bar width based on progress value', () => {
      const progress: InitProgress = {
        stage: 'syncing',
        progress: 50,
        message: 'Syncing...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const progressFill = screen.getByTestId('init-progress-bar-fill');
      expect(progressFill).toHaveStyle({ width: '50%' });
    });

    it('should show complete styling when progress is 100%', () => {
      const progress: InitProgress = {
        stage: 'ready',
        progress: 100,
        message: 'Ready!',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const progressBar = screen.getByTestId('init-progress-bar');
      expect(progressBar).toHaveClass('init-progress-bar--complete');
    });

    it('should show error styling on error stage', () => {
      const progress: InitProgress = {
        stage: 'error',
        progress: 30,
        message: 'Failed to start container',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const progressBar = screen.getByTestId('init-progress-bar');
      expect(progressBar).toHaveClass('init-progress-bar--error');
    });
  });

  describe('Steps', () => {
    it('keeps a single workspace sync row active through verification', () => {
      const [progress, setProgress] = createSignal<InitProgress>({ stage: 'syncing', progress: 40, message: 'Syncing workspace' });
      render(() => <InitProgressComponent sessionName="Pi" progress={progress()} />);
      const row = screen.getByText('Syncing workspace', { selector: '.init-progress-stage-label' }).closest('li');
      expect(row).toHaveClass('init-progress-stage--active');
      setProgress({ stage: 'verifying', progress: 60, message: 'Verifying workspace' });
      expect(screen.queryByText('Verifying workspace')).not.toBeInTheDocument();
      expect(row).toHaveClass('init-progress-stage--active');
      setProgress({ stage: 'mounting', progress: 80, message: 'Preparing terminal...' });
      expect(row).toHaveClass('init-progress-stage--completed');
      expect(screen.queryByText(/Preparing terminal/i)).not.toBeInTheDocument();
      expect(screen.getAllByText('Preparing environment')).toHaveLength(2);
    });

    it('should render step time elements', () => {
      const progress: InitProgress = {
        stage: 'syncing',
        progress: 40,
        message: 'Syncing...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      expect(screen.getByTestId('init-progress-step-0-time')).toBeInTheDocument();
      expect(screen.getByTestId('init-progress-step-1-time')).toBeInTheDocument();
      expect(screen.getByTestId('init-progress-step-2-time')).toBeInTheDocument();
    });

    it('should apply completed class to completed steps', () => {
      const progress: InitProgress = {
        stage: 'syncing',
        progress: 40,
        message: 'Syncing...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const step0 = screen.getByTestId('init-progress-step-0');
      const step1 = screen.getByTestId('init-progress-step-1');
      const step2 = screen.getByTestId('init-progress-step-2');

      expect(step0).toHaveClass('init-progress-stage--completed');
      expect(step1).toHaveClass('init-progress-stage--completed');
      expect(step2).toHaveClass('init-progress-stage--active');
    });

    it('should apply pending class to pending steps', () => {
      const progress: InitProgress = {
        stage: 'creating',
        progress: 10,
        message: 'Creating...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const step3 = screen.getByTestId('init-progress-step-3');
      const step4 = screen.getByTestId('init-progress-step-4');

      expect(step3).toHaveClass('init-progress-stage--pending');
      expect(step4).toHaveClass('init-progress-stage--pending');
    });
  });

  describe('Error State', () => {
    it('should apply shake animation class on error', () => {
      const progress: InitProgress = {
        stage: 'error',
        progress: 30,
        message: 'Connection failed',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const modal = screen.getByTestId('init-progress');
      expect(modal).toHaveClass('animate-shake');
    });

    it('should display error message in error box', () => {
      const progress: InitProgress = {
        stage: 'error',
        progress: 30,
        message: 'Failed to connect to server',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      // Error message appears in both subtitle and error box, use getAllByText
      const errorMessages = screen.getAllByText('Failed to connect to server');
      expect(errorMessages.length).toBeGreaterThanOrEqual(1);
      // Verify at least one is in the error message box
      const errorBox = errorMessages.find(el => el.classList.contains('init-progress-error-msg'));
      expect(errorBox).toBeInTheDocument();
    });
  });

  describe('Ready State', () => {
    it('counts elapsed Chat preparation without showing Ready or Open prematurely', () => {
      vi.useFakeTimers();
      try {
        const [openReady, setOpenReady] = createSignal(false);
        render(() => <InitProgressComponent sessionName="Pi" openReady={openReady()}
          progress={{ stage: 'ready', progress: 100, message: 'Container ready' }} />);
        expect(screen.queryByText('Ready to open', { selector: '.init-progress-stage-label' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
        expect(screen.getAllByText('Loading Chat')).toHaveLength(2);
        expect(screen.getByText('0.0s')).toBeVisible();
        vi.advanceTimersByTime(3100);
        expect(screen.getByText('3.1s')).toBeVisible();
        vi.advanceTimersByTime(60);
        setOpenReady(true);
        expect(screen.getByText('Loading Chat', { selector: '.init-progress-stage-label' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Open' })).toBeVisible();
        expect(screen.getByTestId('init-progress-step-5-time')).toHaveTextContent('3.2s');
        vi.advanceTimersByTime(2000);
        expect(screen.getByTestId('init-progress-step-5-time')).toHaveTextContent('3.2s');
      } finally { cleanup(); vi.useRealTimers(); }
    });

    it('does not invent a Chat loading phase when Chat is already ready', () => {
      render(() => <InitProgressComponent sessionName="Pi" openReady={true}
        progress={{ stage: 'ready', progress: 100, message: 'Container ready' }} />);
      expect(screen.queryByText('Loading Chat')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open' })).toBeVisible();
    });

    it('shows Connecting Terminal before the attachment is ready to open', () => {
      const [connection, setConnection] = createSignal<string | undefined>('Connecting Terminal');
      render(() => <InitProgressComponent sessionName="Pi" connectingTerminal={connection()}
        progress={{ stage: 'ready', progress: 100, message: 'Container ready' }} />);
      expect(screen.getByText('Connecting Terminal', { selector: '.init-progress-stage-label' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
      setConnection(undefined);
      expect(screen.getByText('Ready to open', { selector: '.init-progress-stage-label' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Open' })).toBeVisible();
    });

    it('should show open button when ready', () => {
      const progress: InitProgress = {
        stage: 'ready',
        progress: 100,
        message: 'Ready!',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
          onOpen={() => {}}
        />
      ));

      expect(screen.getByText('Open')).toBeInTheDocument();
    });

    it('should call onOpen when open button is clicked', () => {
      const handleOpen = vi.fn();
      const progress: InitProgress = {
        stage: 'ready',
        progress: 100,
        message: 'Ready!',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
          onOpen={handleOpen}
        />
      ));

      const openButton = screen.getByText('Open');
      fireEvent.click(openButton);

      expect(handleOpen).toHaveBeenCalledTimes(1);
    });

    it('should apply bounce animation to hero icon when ready', () => {
      const progress: InitProgress = {
        stage: 'ready',
        progress: 100,
        message: 'Ready!',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test Session"
          progress={progress}
        />
      ));

      const heroIcon = screen.getByTestId('init-progress-hero-icon');
      expect(heroIcon).toHaveClass('animate-bounce');
    });
  });

  describe('Session Name', () => {
    it('should display session name in header', () => {
      const progress: InitProgress = {
        stage: 'creating',
        progress: 10,
        message: 'Creating...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="My Project"
          progress={progress}
        />
      ));

      expect(screen.getByText('Starting "My Project"')).toBeInTheDocument();
    });
  });

  describe('Status Message', () => {
    it('should display current status message', () => {
      const progress: InitProgress = {
        stage: 'syncing',
        progress: 50,
        message: 'Synchronizing files...',
      };

      render(() => (
        <InitProgressComponent
          sessionName="Test"
          progress={progress}
        />
      ));

      expect(screen.getByText('Synchronizing files...')).toBeInTheDocument();
    });

    it('should show default message when progress is null', () => {
      render(() => (
        <InitProgressComponent
          sessionName="Test"
          progress={null}
        />
      ));

      expect(screen.getByText('Initializing...')).toBeInTheDocument();
    });
  });
});
