import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@solidjs/testing-library';
import StatCards from '../../components/StatCards';

describe('StatCards Component', () => {
  afterEach(() => {
    cleanup();
  });

  describe('rendering with data', () => {
    it('should render a single storage card', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 10, totalFolders: 3, totalSizeBytes: 1024 }} />
      ));

      const card = screen.getByTestId('stat-card-storage');
      expect(card).toBeInTheDocument();
      expect(card).toHaveTextContent('R2 Storage');
    });

    it('should render files count', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 42, totalFolders: 0, totalSizeBytes: 0 }} />
      ));

      const filesMetric = screen.getByTestId('stat-card-files');
      expect(filesMetric).toHaveTextContent('42');
      expect(filesMetric).toHaveTextContent('Files');
    });

    it('should render folders count', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 0, totalFolders: 7, totalSizeBytes: 0 }} />
      ));

      const foldersMetric = screen.getByTestId('stat-card-folders');
      expect(foldersMetric).toHaveTextContent('7');
      expect(foldersMetric).toHaveTextContent('Folders');
    });

    it('should render storage size', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 0, totalFolders: 0, totalSizeBytes: 5242880 }} />
      ));

      const sizeMetric = screen.getByTestId('stat-card-size');
      expect(sizeMetric).toHaveTextContent('5.00 MB');
      expect(sizeMetric).toHaveTextContent('Storage');
    });
  });

  describe('byte formatting', () => {
    it('should format bytes', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 0, totalFolders: 0, totalSizeBytes: 512 }} />
      ));

      const sizeMetric = screen.getByTestId('stat-card-size');
      expect(sizeMetric).toHaveTextContent('512 B');
    });

    it('should format kilobytes', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 0, totalFolders: 0, totalSizeBytes: 2048 }} />
      ));

      const sizeMetric = screen.getByTestId('stat-card-size');
      expect(sizeMetric).toHaveTextContent('2.00 KB');
    });

    it('should format megabytes', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 0, totalFolders: 0, totalSizeBytes: 10485760 }} />
      ));

      const sizeMetric = screen.getByTestId('stat-card-size');
      expect(sizeMetric).toHaveTextContent('10.00 MB');
    });

    it('should format gigabytes', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 0, totalFolders: 0, totalSizeBytes: 2147483648 }} />
      ));

      const sizeMetric = screen.getByTestId('stat-card-size');
      expect(sizeMetric).toHaveTextContent('2.00 GB');
    });

    it('should handle 0 bytes', () => {
      render(() => (
        <StatCards stats={{ totalFiles: 0, totalFolders: 0, totalSizeBytes: 0 }} />
      ));

      const sizeMetric = screen.getByTestId('stat-card-size');
      expect(sizeMetric).toHaveTextContent('0 B');
    });
  });

  describe('loading state', () => {
    it('should show loading skeleton when stats is null', () => {
      render(() => <StatCards stats={null} />);

      const skeleton = screen.getByTestId('stat-card-skeleton-0');
      expect(skeleton).toBeInTheDocument();
    });

    it('should not show stat values when loading', () => {
      render(() => <StatCards stats={null} />);

      expect(screen.queryByTestId('stat-card-files')).not.toBeInTheDocument();
      expect(screen.queryByTestId('stat-card-folders')).not.toBeInTheDocument();
      expect(screen.queryByTestId('stat-card-size')).not.toBeInTheDocument();
    });
  });
});
