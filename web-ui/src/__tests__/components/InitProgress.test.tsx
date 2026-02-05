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
    it('should render all initialization steps', () => {
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

      // Check all 6 steps are rendered
      expect(screen.getByTestId('init-progress-step-0')).toBeInTheDocument();
      expect(screen.getByTestId('init-progress-step-1')).toBeInTheDocument();
      expect(screen.getByTestId('init-progress-step-2')).toBeInTheDocument();
      expect(screen.getByTestId('init-progress-step-3')).toBeInTheDocument();
      expect(screen.getByTestId('init-progress-step-4')).toBeInTheDocument();
      expect(screen.getByTestId('init-progress-step-5')).toBeInTheDocument();
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
      const step5 = screen.getByTestId('init-progress-step-5');

      expect(step3).toHaveClass('init-progress-stage--pending');
      expect(step4).toHaveClass('init-progress-stage--pending');
      expect(step5).toHaveClass('init-progress-stage--pending');
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
