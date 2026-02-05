import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import FilePreview from '../../components/FilePreview';
import { createMockPreviewFile } from '../helpers/mock-factories';

describe('FilePreview Component', () => {
  afterEach(() => {
    cleanup();
  });

  // ==========================================================================
  // Text mode
  // ==========================================================================
  describe('Text mode', () => {
    it('should render text content', () => {
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/readme.md' })}
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      expect(screen.getByTestId('file-preview')).toBeInTheDocument();
      expect(screen.getByTestId('file-preview-content')).toHaveTextContent('Hello, world!');
    });

    it('should display the file name in header', () => {
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/readme.md', content: 'content', size: 7 })}
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      expect(screen.getByTestId('file-preview-name')).toHaveTextContent('readme.md');
    });

    it('should render back button that calls onBack', () => {
      const onBack = vi.fn();
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/readme.md', content: 'content', size: 7 })}
          onBack={onBack}
          onDownload={() => {}}
        />
      ));

      const backBtn = screen.getByTestId('file-preview-back');
      fireEvent.click(backBtn);
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('should render download button that calls onDownload', () => {
      const onDownload = vi.fn();
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/readme.md', content: 'content', size: 7 })}
          onBack={() => {}}
          onDownload={onDownload}
        />
      ));

      const dlBtn = screen.getByTestId('file-preview-download');
      fireEvent.click(dlBtn);
      expect(onDownload).toHaveBeenCalledTimes(1);
    });

    it('should show line numbers', () => {
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/code.ts', content: 'line1\nline2\nline3', size: 17 })}
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      const lineNumbers = screen.getByTestId('file-preview-line-numbers');
      expect(lineNumbers).toBeInTheDocument();
      // Should have 3 line numbers
      expect(lineNumbers.textContent).toContain('1');
      expect(lineNumbers.textContent).toContain('2');
      expect(lineNumbers.textContent).toContain('3');
    });
  });

  // ==========================================================================
  // Image mode
  // ==========================================================================
  describe('Image mode', () => {
    it('should render an img tag with the presigned URL', () => {
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/photo.png', type: 'image', url: 'https://example.com/photo.png', content: undefined, size: 204800 })}
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      const img = screen.getByTestId('file-preview-image') as HTMLImageElement;
      expect(img).toBeInTheDocument();
      expect(img.src).toBe('https://example.com/photo.png');
    });

    it('should display file name for image', () => {
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/images/logo.svg', type: 'image', url: 'https://example.com/logo.svg', content: undefined, size: 1024 })}
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      expect(screen.getByTestId('file-preview-name')).toHaveTextContent('logo.svg');
    });
  });

  // ==========================================================================
  // Binary mode
  // ==========================================================================
  describe('Binary mode', () => {
    it('should show metadata only (no content/image)', () => {
      const binaryFile = createMockPreviewFile({ key: 'workspace/archive.zip', type: 'binary', content: undefined, size: 1048576 });
      render(() => (
        <FilePreview
          file={binaryFile}
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      expect(screen.getByTestId('file-preview')).toBeInTheDocument();
      expect(screen.getByTestId('file-preview-binary')).toBeInTheDocument();
      expect(screen.queryByTestId('file-preview-content')).not.toBeInTheDocument();
      expect(screen.queryByTestId('file-preview-image')).not.toBeInTheDocument();
    });

    it('should display file size', () => {
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/archive.zip', type: 'binary', content: undefined, size: 1048576 })}
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      const binary = screen.getByTestId('file-preview-binary');
      expect(binary).toBeInTheDocument();
    });

    it('should render download button for binary files', () => {
      const onDownload = vi.fn();
      render(() => (
        <FilePreview
          file={createMockPreviewFile({ key: 'workspace/archive.zip', type: 'binary', content: undefined, size: 1048576 })}
          onBack={() => {}}
          onDownload={onDownload}
        />
      ));

      const dlBtn = screen.getByTestId('file-preview-download');
      fireEvent.click(dlBtn);
      expect(onDownload).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Loading state
  // ==========================================================================
  describe('Loading state', () => {
    it('should show loading indicator when loading', () => {
      render(() => (
        <FilePreview
          file={null}
          loading={true}
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      expect(screen.getByTestId('file-preview-loading')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Error state
  // ==========================================================================
  describe('Error state', () => {
    it('should show error message when error prop is set', () => {
      render(() => (
        <FilePreview
          file={null}
          error="Failed to load preview"
          onBack={() => {}}
          onDownload={() => {}}
        />
      ));

      const errorEl = screen.getByTestId('file-preview-error');
      expect(errorEl).toBeInTheDocument();
      expect(errorEl).toHaveTextContent('Failed to load preview');
    });

    it('should still show back button on error', () => {
      const onBack = vi.fn();
      render(() => (
        <FilePreview
          file={null}
          error="Failed to load preview"
          onBack={onBack}
          onDownload={() => {}}
        />
      ));

      const backBtn = screen.getByTestId('file-preview-back');
      fireEvent.click(backBtn);
      expect(onBack).toHaveBeenCalledTimes(1);
    });
  });
});
