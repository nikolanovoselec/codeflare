import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { mdiSync } from '@mdi/js';

// Mutable state for mock store -- individual tests can override these
let mockObjects: any[] = [];
let mockPrefixes: string[] = [];
let mockCurrentPrefix = '';
let mockLoading = false;
let mockError: string | null = null;
let mockUploads: any[] = [];
let mockSelectedKeys: string[] = [];
let mockSelectedPrefixes: string[] = [];
let mockBreadcrumbs: string[] = [];
let mockStats: any = null;
let mockPreviewFile: any = null;
let mockWorkspaceSyncEnabled = true;
let mockActiveSessionId: string | null = 'test-session';

const mockBrowse = vi.fn();
const mockNavigateTo = vi.fn();
const mockNavigateUp = vi.fn();
const mockRefresh = vi.fn();
const mockDeleteSelected = vi.fn();
const mockToggleSelect = vi.fn();
const mockToggleSelectPrefix = vi.fn();
const mockSetSelection = vi.fn();
const mockUploadFiles = vi.fn();
const mockSelectAll = vi.fn();
const mockClearSelection = vi.fn();
const mockMoveFile = vi.fn();
const mockSearchFiles = vi.fn((_q: string) => ({ objects: mockObjects, prefixes: mockPrefixes }));
const mockFetchStats = vi.fn();
const mockOpenPreview = vi.fn();
const mockClosePreview = vi.fn();
// MOCK-DRIFT RISK: The storageStore mock below replicates the public API surface
// of stores/storage.ts. If the real store adds/removes/renames methods or changes
// getter signatures, these tests will silently pass with stale behavior. When
// modifying stores/storage.ts, grep for this mock and update it in lockstep.
vi.mock('../../stores/storage', () => ({
  storageStore: {
    get objects() { return mockObjects; },
    get prefixes() { return mockPrefixes; },
    get currentPrefix() { return mockCurrentPrefix; },
    get loading() { return mockLoading; },
    get error() { return mockError; },
    get uploads() { return mockUploads; },
    get selectedKeys() { return mockSelectedKeys; },
    get selectedPrefixes() { return mockSelectedPrefixes; },
    get breadcrumbs() { return mockBreadcrumbs; },
    get stats() { return mockStats; },
    get previewFile() { return mockPreviewFile; },
    browse: (...args: any[]) => mockBrowse(...args),
    navigateTo: (...args: any[]) => mockNavigateTo(...args),
    navigateUp: (...args: any[]) => mockNavigateUp(...args),
    refresh: (...args: any[]) => mockRefresh(...args),
    deleteSelected: (...args: any[]) => mockDeleteSelected(...args),
    toggleSelect: (key: string) => {
      mockToggleSelect(key);
      const idx = mockSelectedKeys.indexOf(key);
      if (idx >= 0) {
        mockSelectedKeys.splice(idx, 1);
      } else {
        mockSelectedKeys.push(key);
      }
    },
    toggleSelectPrefix: (prefix: string) => {
      mockToggleSelectPrefix(prefix);
      const idx = mockSelectedPrefixes.indexOf(prefix);
      if (idx >= 0) {
        mockSelectedPrefixes.splice(idx, 1);
      } else {
        mockSelectedPrefixes.push(prefix);
      }
    },
    setSelection: (keys: string[], prefixes: string[]) => {
      mockSetSelection(keys, prefixes);
      mockSelectedKeys = [...keys];
      mockSelectedPrefixes = [...prefixes];
    },
    uploadFiles: (...args: any[]) => mockUploadFiles(...args),
    selectAll: (...args: any[]) => mockSelectAll(...args),
    clearSelection: (...args: any[]) => mockClearSelection(...args),
    moveFile: (...args: any[]) => mockMoveFile(...args),
    searchFiles: (q: string) => mockSearchFiles(q),
    fetchStats: (...args: any[]) => mockFetchStats(...args),
    openPreview: (...args: any[]) => mockOpenPreview(...args),
    closePreview: (...args: any[]) => mockClosePreview(...args),
  },
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get preferences() {
      return { workspaceSyncEnabled: mockWorkspaceSyncEnabled };
    },
    get activeSessionId() {
      return mockActiveSessionId;
    },
    get sessions() {
      return mockActiveSessionId
        ? [{ id: mockActiveSessionId, status: 'running' }]
        : [];
    },
  },
}));

vi.mock('../../api/storage', () => ({
  getDownloadUrl: (key: string) => `https://mock.test/storage/download?key=${encodeURIComponent(key)}`,
}));

vi.mock('../../lib/file-icons', () => ({
  getFileIcon: (filename: string, isFolder?: boolean) => {
    if (isFolder) return { color: '#3b82f6', label: 'Folder' };
    if (filename.endsWith('.ts')) return { color: '#3178c6', label: 'TypeScript' };
    if (filename.endsWith('.md')) return { color: '#6b7280', label: 'Markdown' };
    return { color: '#9ca3af', label: 'File' };
  },
}));

const { mockExtractFilesFromDrop } = vi.hoisted(() => ({
  mockExtractFilesFromDrop: vi.fn((): Promise<any[]> => Promise.resolve([])),
}));
vi.mock('../../lib/file-upload', () => ({
  extractFilesFromDrop: mockExtractFilesFromDrop,
}));

import StorageBrowser from '../../components/StorageBrowser';

describe('StorageBrowser', () => {
  const enableSelectionMode = () => {
    fireEvent.click(screen.getByTitle('Selection mode'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fetch + URL.createObjectURL/revokeObjectURL for triggerDownload
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['test'])));
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    // Reset mock state to defaults
    mockObjects = [];
    mockPrefixes = [];
    mockCurrentPrefix = '';
    mockLoading = false;
    mockError = null;
    mockUploads = [];
    mockSelectedKeys = [];
    mockSelectedPrefixes = [];
    mockBreadcrumbs = [];
    mockStats = null;
    mockPreviewFile = null;
    mockWorkspaceSyncEnabled = true;
    mockActiveSessionId = 'test-session';
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders the storage browser container', () => {
      render(() => <StorageBrowser />);
      expect(screen.getByTestId('storage-browser')).toBeInTheDocument();
    });

    it('calls storageStore.browse on mount with empty prefix (bucket root)', () => {
      render(() => <StorageBrowser />);
      expect(mockBrowse).toHaveBeenCalledWith('');
    });

    it('does not render a close button', () => {
      render(() => <StorageBrowser />);
      expect(screen.queryByText('Close')).not.toBeInTheDocument();
    });
  });

  describe('Breadcrumb Navigation', () => {
    it('renders breadcrumbs from storageStore.breadcrumbs', () => {
      mockBreadcrumbs = ['workspace/', 'workspace/src/'];
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('storage-breadcrumbs')).toBeInTheDocument();
      expect(screen.getByTestId('breadcrumb-0')).toBeInTheDocument();
      expect(screen.getByTestId('breadcrumb-1')).toBeInTheDocument();
    });

    it('renders breadcrumb segment names correctly (Workspace capitalized)', () => {
      mockBreadcrumbs = ['workspace/', 'workspace/src/'];
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('breadcrumb-0')).toHaveTextContent('Workspace');
      expect(screen.getByTestId('breadcrumb-1')).toHaveTextContent('src');
    });

    it('clicking a breadcrumb calls storageStore.navigateTo', () => {
      mockBreadcrumbs = ['workspace/', 'workspace/src/'];
      render(() => <StorageBrowser />);

      fireEvent.click(screen.getByTestId('breadcrumb-0'));
      expect(mockNavigateTo).toHaveBeenCalledWith('workspace/');
    });
  });

  describe('Folders', () => {
    it('renders folders from storageStore.prefixes', () => {
      mockPrefixes = ['workspace/src/', 'workspace/docs/'];
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('folder-src')).toBeInTheDocument();
      expect(screen.getByTestId('folder-docs')).toBeInTheDocument();
    });

    it('displays folder names correctly', () => {
      mockPrefixes = ['workspace/src/'];
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('folder-src')).toHaveTextContent('src');
    });

    it('clicking a folder calls storageStore.navigateTo', () => {
      mockPrefixes = ['workspace/src/'];
      render(() => <StorageBrowser />);

      fireEvent.click(screen.getByTestId('folder-src'));
      expect(mockNavigateTo).toHaveBeenCalledWith('workspace/src/');
    });

    it('folder checkbox toggles selection via storageStore.toggleSelectPrefix', () => {
      mockPrefixes = ['workspace/src/'];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      const checkbox = screen.getByTestId('folder-src').querySelector('input[type="checkbox"]');
      expect(checkbox).toBeInTheDocument();

      fireEvent.click(checkbox!);
      expect(mockToggleSelectPrefix).toHaveBeenCalledWith('workspace/src/');
    });
  });

  describe('Files with type icons', () => {
    it('renders files from storageStore.objects', () => {
      mockObjects = [
        { key: 'workspace/readme.md', size: 1024, lastModified: '2024-01-15T10:00:00Z' },
        { key: 'workspace/index.ts', size: 2048, lastModified: '2024-01-15T11:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('file-readme.md')).toBeInTheDocument();
      expect(screen.getByTestId('file-index.ts')).toBeInTheDocument();
    });

    it('displays formatted file size', () => {
      mockObjects = [
        { key: 'workspace/small.txt', size: 512, lastModified: '2024-01-15T10:00:00Z' },
        { key: 'workspace/medium.txt', size: 1536, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('file-small.txt')).toHaveTextContent('512 B');
      expect(screen.getByTestId('file-medium.txt')).toHaveTextContent('1.5 KB');
    });

    it('renders file type icon color from file-icons utility', () => {
      mockObjects = [
        { key: 'workspace/index.ts', size: 2048, lastModified: '2024-01-15T11:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      const fileRow = screen.getByTestId('file-index.ts');
      // The icon dot should have the TypeScript color
      const iconDot = fileRow.querySelector('.storage-item-icon-dot');
      expect(iconDot).toBeInTheDocument();
      expect((iconDot as HTMLElement).style.backgroundColor).toBe('rgb(49, 120, 198)'); // #3178c6
    });

    it('file checkbox toggles selection via storageStore.toggleSelect', () => {
      mockObjects = [
        { key: 'workspace/test.txt', size: 100, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      const checkbox = screen.getByTestId('file-test.txt').querySelector('input[type="checkbox"]');
      expect(checkbox).toBeInTheDocument();

      fireEvent.click(checkbox!);
      expect(mockToggleSelect).toHaveBeenCalledWith('workspace/test.txt');
    });

    it('shift-click selects a range across folders and files', () => {
      mockPrefixes = ['workspace/a/', 'workspace/b/'];
      mockObjects = [
        { key: 'workspace/file1.txt', size: 10, lastModified: '2024-01-15T10:00:00Z' },
        { key: 'workspace/file2.txt', size: 20, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      const folderCheckbox = screen.getByTestId('folder-a').querySelector('input[type="checkbox"]');
      const fileCheckbox = screen.getByTestId('file-file2.txt').querySelector('input[type="checkbox"]');

      fireEvent.click(folderCheckbox!);
      fireEvent.click(fileCheckbox!, { shiftKey: true });

      expect(mockSetSelection).toHaveBeenCalledWith(
        expect.arrayContaining(['workspace/file1.txt', 'workspace/file2.txt']),
        expect.arrayContaining(['workspace/a/', 'workspace/b/']),
      );
    });
  });

  describe('Search', () => {
    it('shows search input when search toggle is clicked', () => {
      render(() => <StorageBrowser />);

      const searchToggle = screen.getByTestId('storage-search-toggle');
      fireEvent.click(searchToggle);

      expect(screen.getByTestId('storage-search-input')).toBeInTheDocument();
    });

    it('focuses search input automatically when opened', async () => {
      render(() => <StorageBrowser />);

      const searchToggle = screen.getByTestId('storage-search-toggle');
      fireEvent.click(searchToggle);

      const searchInput = screen.getByTestId('storage-search-input');
      await waitFor(() => expect(searchInput).toHaveFocus());
    });

    it('calls searchFiles with query as user types', () => {
      mockObjects = [
        { key: 'workspace/readme.md', size: 100, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      const searchToggle = screen.getByTestId('storage-search-toggle');
      fireEvent.click(searchToggle);

      const searchInput = screen.getByTestId('storage-search-input');
      fireEvent.input(searchInput, { target: { value: 'readme' } });

      expect(mockSearchFiles).toHaveBeenCalledWith('readme');
    });
  });

  describe('Hidden items toggle', () => {
    it('hides hidden folders and files by default', () => {
      mockPrefixes = ['workspace/', 'workspace/.claude/'];
      mockObjects = [
        { key: 'workspace/.env', size: 42, lastModified: '2024-01-15T10:00:00Z' },
        { key: 'workspace/readme.md', size: 100, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('folder-workspace')).toBeInTheDocument();
      expect(screen.queryByTestId('folder-.claude')).not.toBeInTheDocument();
      expect(screen.queryByTestId('file-.env')).not.toBeInTheDocument();
      expect(screen.getByTestId('file-readme.md')).toBeInTheDocument();
    });

    it('shows hidden folders and files when "Show Hidden Items" is activated', () => {
      mockPrefixes = ['workspace/', 'workspace/.claude/'];
      mockObjects = [
        { key: 'workspace/.env', size: 42, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      fireEvent.click(screen.getByTestId('storage-hidden-toggle'));

      expect(screen.getByTestId('folder-.claude')).toBeInTheDocument();
      expect(screen.getByTestId('file-.env')).toBeInTheDocument();
    });
  });

  describe('Workspace sync preference', () => {
    it('hides workspace folder and files when workspace sync is disabled', () => {
      mockWorkspaceSyncEnabled = false;
      mockPrefixes = ['workspace/', 'docs/'];
      mockObjects = [
        { key: 'workspace/readme.md', size: 100, lastModified: '2024-01-15T10:00:00Z' },
        { key: 'docs/guide.md', size: 80, lastModified: '2024-01-15T10:00:00Z' },
      ];

      render(() => <StorageBrowser />);

      expect(screen.queryByTestId('folder-workspace')).not.toBeInTheDocument();
      expect(screen.queryByTestId('file-readme.md')).not.toBeInTheDocument();
      expect(screen.getByTestId('folder-docs')).toBeInTheDocument();
      expect(screen.getByTestId('file-guide.md')).toBeInTheDocument();
    });

    it('navigates back to root when current prefix is workspace and sync is disabled', () => {
      mockWorkspaceSyncEnabled = false;
      mockCurrentPrefix = 'workspace/';

      render(() => <StorageBrowser />);

      expect(mockNavigateTo).toHaveBeenCalledWith('');
    });
  });

  describe('Workspace folder display', () => {
    it('displays "Workspace" with capital W for workspace folder', () => {
      mockPrefixes = ['workspace/', 'docs/'];
      render(() => <StorageBrowser />);

      const workspaceFolder = screen.getByTestId('folder-workspace');
      expect(workspaceFolder).toHaveTextContent('Workspace');
      // Make sure it's not lowercase
      const nameSpan = workspaceFolder.querySelector('.storage-item-name');
      expect(nameSpan?.textContent).toBe('Workspace');
    });

    it('shows container sync icon next to Workspace folder', () => {
      mockPrefixes = ['workspace/', 'docs/'];
      render(() => <StorageBrowser />);

      const workspaceFolder = screen.getByTestId('folder-workspace');
      const syncIcon = workspaceFolder.querySelector('[data-testid="workspace-container-icon"]');
      expect(syncIcon).toBeInTheDocument();
    });

    it('does not show container sync icon for non-workspace folders', () => {
      mockPrefixes = ['docs/'];
      render(() => <StorageBrowser />);

      const docsFolder = screen.getByTestId('folder-docs');
      const syncIcon = docsFolder.querySelector('[data-testid="workspace-container-icon"]');
      expect(syncIcon).not.toBeInTheDocument();
    });

    it('shows tooltip text when workspace container icon is clicked', () => {
      mockPrefixes = ['workspace/'];
      render(() => <StorageBrowser />);

      const workspaceFolder = screen.getByTestId('folder-workspace');
      const syncIcon = workspaceFolder.querySelector('[data-testid="workspace-container-icon"]') as HTMLElement;
      expect(syncIcon).toBeInTheDocument();

      // Click the icon to toggle tooltip
      fireEvent.click(syncIcon!);

      // Tooltip text should appear
      const tooltip = workspaceFolder.querySelector('.workspace-sync-tooltip');
      expect(tooltip).toBeInTheDocument();
      expect(tooltip?.textContent).toBe('Holds your codebase and other assets. Disabling sync in settings is recommended, clone your repositories fresh every session.');
    });
  });

  describe('File click triggers download', () => {
    it('clicking a file name triggers a download instead of preview', async () => {
      mockObjects = [
        { key: 'workspace/readme.md', size: 1024, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      const fileName = screen.getByTestId('file-readme.md').querySelector('.storage-item-name');
      fireEvent.click(fileName!);

      // Wait for the async triggerDownload chain (fetch → blob → anchor click)
      // to complete before afterEach restores mocks
      await vi.waitFor(() => {
        expect(globalThis.URL.revokeObjectURL).toHaveBeenCalled();
      });

      // openPreview should NOT be called — download is triggered instead
      expect(mockOpenPreview).not.toHaveBeenCalled();
      // Verify the full download chain completed
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('readme.md'),
        expect.objectContaining({ credentials: 'include' }),
      );
    });
  });

  describe('File drag support', () => {
    it('file rows have draggable="true"', () => {
      mockObjects = [
        { key: 'workspace/readme.md', size: 1024, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      const fileRow = screen.getByTestId('file-readme.md');
      expect(fileRow.getAttribute('draggable')).toBe('true');
    });

    it('dragStart sets R2 key in dataTransfer', () => {
      mockObjects = [
        { key: 'workspace/readme.md', size: 1024, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);

      const fileRow = screen.getByTestId('file-readme.md');
      const setDataMock = vi.fn();
      fireEvent.dragStart(fileRow, {
        dataTransfer: { setData: setDataMock },
      });

      expect(setDataMock).toHaveBeenCalledWith('application/x-r2-key', 'workspace/readme.md');
    });
  });

  describe('Action Buttons', () => {
    it('clicking Up button calls storageStore.navigateUp', () => {
      mockCurrentPrefix = 'workspace/src/';
      render(() => <StorageBrowser />);

      const upBtn = screen.getByTitle('Go up');
      fireEvent.click(upBtn);
      expect(mockNavigateUp).toHaveBeenCalledTimes(1);
    });

    it('shows Delete button when keys are selected', () => {
      mockSelectedKeys = ['workspace/test.txt'];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      const deleteBtn = screen.getByTitle('Delete selected');
      expect(deleteBtn).toBeInTheDocument();
    });

    it('shows Delete button when prefixes are selected', () => {
      mockSelectedPrefixes = ['workspace/src/'];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      const deleteBtn = screen.getByTitle('Delete selected');
      expect(deleteBtn).toBeInTheDocument();
    });

    it('clicking Delete button calls storageStore.deleteSelected', () => {
      mockSelectedKeys = ['workspace/test.txt'];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      const deleteBtn = screen.getByTitle('Delete selected');
      fireEvent.click(deleteBtn);
      expect(mockDeleteSelected).toHaveBeenCalledTimes(1);
    });

    it('hides Delete button when no keys selected', () => {
      mockSelectedKeys = [];
      render(() => <StorageBrowser />);

      expect(screen.queryByTitle('Delete selected')).not.toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('shows a loading indicator when loading', () => {
      mockLoading = true;
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('storage-loading')).toBeInTheDocument();
      expect(screen.getByText('Loading files...')).toBeInTheDocument();
    });

    it('hides content when loading', () => {
      mockLoading = true;
      render(() => <StorageBrowser />);

      expect(screen.queryByTestId('storage-drop-zone')).not.toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('shows error message when error exists', () => {
      mockError = 'Failed to load files';
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('storage-error')).toBeInTheDocument();
      expect(screen.getByText('Failed to load files')).toBeInTheDocument();
    });

    it('shows retry button in error state', () => {
      mockError = 'Network error';
      render(() => <StorageBrowser />);

      const retryBtn = screen.getByText('Retry');
      expect(retryBtn).toBeInTheDocument();

      fireEvent.click(retryBtn);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('Empty State', () => {
    it('shows empty message when no folders or files', () => {
      mockPrefixes = [];
      mockObjects = [];
      mockWorkspaceSyncEnabled = false;
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('storage-empty')).toBeInTheDocument();
      expect(screen.getByText(/No files found/)).toBeInTheDocument();
    });
  });

  describe('Drop Zone', () => {
    it('renders the drop zone', () => {
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('storage-drop-zone')).toBeInTheDocument();
    });

    it('handles dragOver event', () => {
      render(() => <StorageBrowser />);

      const dropZone = screen.getByTestId('storage-drop-zone');
      fireEvent.dragOver(dropZone);

      expect(dropZone.classList.contains('storage-drop-zone--active')).toBe(true);
    });

    it('handles dragLeave event', () => {
      render(() => <StorageBrowser />);

      const dropZone = screen.getByTestId('storage-drop-zone');
      fireEvent.dragOver(dropZone);
      expect(dropZone.classList.contains('storage-drop-zone--active')).toBe(true);

      fireEvent.dragLeave(dropZone);
      expect(dropZone.classList.contains('storage-drop-zone--active')).toBe(false);
    });

    it('handles drop event and calls extractFilesFromDrop', async () => {
      const mockFiles = [{ file: new File(['test'], 'test.txt'), relativePath: 'test.txt' }];
      mockExtractFilesFromDrop.mockResolvedValueOnce(mockFiles);

      render(() => <StorageBrowser />);

      const dropZone = screen.getByTestId('storage-drop-zone');

      const dataTransfer = { items: [], files: [] };
      fireEvent.drop(dropZone, { dataTransfer });

      expect(mockExtractFilesFromDrop).toHaveBeenCalled();
    });
  });

  describe('Refresh button', () => {
    it('renders refresh button with correct data-testid', () => {
      render(() => <StorageBrowser />);
      expect(screen.getByTestId('storage-sync-btn')).toBeInTheDocument();
    });

    it('should use mdiSync icon for refresh button', () => {
      render(() => <StorageBrowser />);
      const syncBtn = screen.getByTestId('storage-sync-btn');
      const svgPath = syncBtn.querySelector('svg path');
      expect(svgPath).toBeInTheDocument();
      expect(svgPath?.getAttribute('d')).toBe(mdiSync);
    });

    it('refresh button calls browse() to reload file listing', () => {
      render(() => <StorageBrowser />);
      const syncBtn = screen.getByTestId('storage-sync-btn');
      fireEvent.click(syncBtn);
      // 1 on mount + 1 on click
      expect(mockBrowse).toHaveBeenCalledTimes(2);
    });

    it('refresh button works the same with or without active session', () => {
      mockActiveSessionId = null;
      render(() => <StorageBrowser />);
      const syncBtn = screen.getByTestId('storage-sync-btn');
      fireEvent.click(syncBtn);
      expect(mockBrowse).toHaveBeenCalledTimes(2);
    });
  });

  describe('Up button visibility', () => {
    it('shows up button when in a subfolder', () => {
      mockCurrentPrefix = 'workspace/src/';
      render(() => <StorageBrowser />);
      expect(screen.getByTestId('storage-up-btn')).toBeInTheDocument();
    });

    it('hides up button at root', () => {
      mockCurrentPrefix = '';
      render(() => <StorageBrowser />);
      expect(screen.queryByTestId('storage-up-btn')).not.toBeInTheDocument();
    });
  });

  describe('Toolbar separators', () => {
    it('renders toolbar separators', () => {
      render(() => <StorageBrowser />);
      const browser = screen.getByTestId('storage-browser');
      const separators = browser.querySelectorAll('.storage-toolbar-separator');
      expect(separators.length).toBeGreaterThan(0);
    });
  });

  describe('Selection Mode Click Interception', () => {
    it('clicking folder row in select mode toggles selection instead of navigating', () => {
      mockPrefixes = ['workspace/src/'];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      // Click the folder ROW (not the checkbox)
      fireEvent.click(screen.getByTestId('folder-src'));

      // Should toggle selection, NOT navigate
      expect(mockToggleSelectPrefix).toHaveBeenCalledWith('workspace/src/');
      expect(mockNavigateTo).not.toHaveBeenCalled();
    });

    it('clicking file row in select mode toggles selection instead of downloading', () => {
      mockObjects = [
        { key: 'workspace/readme.md', size: 100, lastModified: '2024-01-15T10:00:00Z' },
      ];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      // Click the file name (which normally triggers download)
      const fileName = screen.getByTestId('file-readme.md').querySelector('.storage-item-name');
      fireEvent.click(fileName!);

      // Should toggle selection, NOT download
      expect(mockToggleSelect).toHaveBeenCalledWith('workspace/readme.md');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('clicking folder row without select mode still navigates normally', () => {
      mockPrefixes = ['workspace/src/'];
      render(() => <StorageBrowser />);

      fireEvent.click(screen.getByTestId('folder-src'));

      expect(mockNavigateTo).toHaveBeenCalledWith('workspace/src/');
      expect(mockToggleSelectPrefix).not.toHaveBeenCalled();
    });

    it('deactivates select mode after delete action', () => {
      mockSelectedKeys = ['workspace/test.txt'];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      const deleteBtn = screen.getByTitle('Delete selected');
      fireEvent.click(deleteBtn);

      // Selection mode should be deactivated — checkbox should disappear
      // The select mode button should no longer be active
      const selectBtn = screen.getByTitle('Selection mode');
      expect(selectBtn.classList.contains('storage-icon-btn--active')).toBe(false);
    });

    it('deactivates select mode after download action', async () => {
      mockSelectedKeys = ['workspace/test.txt'];
      render(() => <StorageBrowser />);
      enableSelectionMode();

      const downloadBtn = screen.getByTitle('Download selected');
      fireEvent.click(downloadBtn);

      await waitFor(() => {
        const selectBtn = screen.getByTitle('Selection mode');
        expect(selectBtn.classList.contains('storage-icon-btn--active')).toBe(false);
      });
    });
  });

  describe('Upload Queue', () => {
    it('shows upload queue when uploads exist', () => {
      mockUploads = [
        { id: 'upload-1', fileName: 'test.txt', relativePath: 'test.txt', progress: 50, status: 'uploading' },
      ];
      render(() => <StorageBrowser />);

      expect(screen.getByTestId('storage-upload-queue')).toBeInTheDocument();
      expect(screen.getByText('test.txt')).toBeInTheDocument();
    });

    it('hides upload queue when no uploads', () => {
      mockUploads = [];
      render(() => <StorageBrowser />);

      expect(screen.queryByTestId('storage-upload-queue')).not.toBeInTheDocument();
    });
  });
});
