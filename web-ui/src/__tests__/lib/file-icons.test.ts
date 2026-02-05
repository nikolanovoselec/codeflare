import { describe, it, expect } from 'vitest';
import { getFileIcon } from '../../lib/file-icons';

describe('getFileIcon()', () => {
  // ==========================================================================
  // Known file extensions
  // ==========================================================================
  describe('known extensions', () => {
    it('returns blue for .ts files', () => {
      const result = getFileIcon('app.ts');
      expect(result.color).toBe('#3178c6');
      expect(result.label).toBe('TypeScript');
    });

    it('returns blue for .tsx files', () => {
      const result = getFileIcon('Component.tsx');
      expect(result.color).toBe('#3178c6');
      expect(result.label).toBe('TypeScript');
    });

    it('returns yellow for .js files', () => {
      const result = getFileIcon('index.js');
      expect(result.color).toBe('#f7df1e');
      expect(result.label).toBe('JavaScript');
    });

    it('returns yellow for .jsx files', () => {
      const result = getFileIcon('App.jsx');
      expect(result.color).toBe('#f7df1e');
      expect(result.label).toBe('JavaScript');
    });

    it('returns orange for .json files', () => {
      const result = getFileIcon('package.json');
      expect(result.color).toBe('#f59e0b');
      expect(result.label).toBe('JSON');
    });

    it('returns gray-blue for .md files', () => {
      const result = getFileIcon('README.md');
      expect(result.color).toBe('#6b7280');
      expect(result.label).toBe('Markdown');
    });

    it('returns purple for .css files', () => {
      const result = getFileIcon('styles.css');
      expect(result.color).toBe('#3b82f6');
      expect(result.label).toBe('CSS');
    });

    it('returns orange-red for .html files', () => {
      const result = getFileIcon('index.html');
      expect(result.color).toBe('#e34f26');
      expect(result.label).toBe('HTML');
    });

    it('returns blue-yellow for .py files', () => {
      const result = getFileIcon('script.py');
      expect(result.color).toBe('#3572a5');
      expect(result.label).toBe('Python');
    });

    it('returns cyan for .go files', () => {
      const result = getFileIcon('main.go');
      expect(result.color).toBe('#00add8');
      expect(result.label).toBe('Go');
    });
  });

  // ==========================================================================
  // Unknown extensions
  // ==========================================================================
  describe('unknown extensions', () => {
    it('returns gray default for unknown extension', () => {
      const result = getFileIcon('data.xyz');
      expect(result.color).toBe('#9ca3af');
      expect(result.label).toBe('File');
    });

    it('returns gray default for no extension', () => {
      const result = getFileIcon('Makefile');
      expect(result.color).toBe('#9ca3af');
      expect(result.label).toBe('File');
    });

    it('returns gray default for dotfiles', () => {
      const result = getFileIcon('.gitignore');
      expect(result.color).toBe('#9ca3af');
      expect(result.label).toBe('File');
    });
  });

  // ==========================================================================
  // Folders
  // ==========================================================================
  describe('folders', () => {
    it('returns accent purple for folders', () => {
      const result = getFileIcon('src', true);
      expect(result.color).toBe('#3b82f6');
      expect(result.label).toBe('Folder');
    });

    it('returns accent purple for folders regardless of name', () => {
      const result = getFileIcon('documents.json', true);
      expect(result.color).toBe('#3b82f6');
      expect(result.label).toBe('Folder');
    });
  });

  // ==========================================================================
  // Case insensitivity
  // ==========================================================================
  describe('case insensitivity', () => {
    it('.TS is treated same as .ts', () => {
      const lower = getFileIcon('app.ts');
      const upper = getFileIcon('APP.TS');
      expect(upper).toEqual(lower);
    });

    it('.JS is treated same as .js', () => {
      const lower = getFileIcon('index.js');
      const upper = getFileIcon('INDEX.JS');
      expect(upper).toEqual(lower);
    });

    it('.Md is treated same as .md', () => {
      const lower = getFileIcon('README.md');
      const mixed = getFileIcon('README.Md');
      expect(mixed).toEqual(lower);
    });

    it('.HTML is treated same as .html', () => {
      const lower = getFileIcon('page.html');
      const upper = getFileIcon('PAGE.HTML');
      expect(upper).toEqual(lower);
    });

    it('.CSS is treated same as .css', () => {
      const lower = getFileIcon('styles.css');
      const upper = getFileIcon('STYLES.CSS');
      expect(upper).toEqual(lower);
    });

    it('.PY is treated same as .py', () => {
      const lower = getFileIcon('script.py');
      const upper = getFileIcon('SCRIPT.PY');
      expect(upper).toEqual(lower);
    });

    it('.GO is treated same as .go', () => {
      const lower = getFileIcon('main.go');
      const upper = getFileIcon('MAIN.GO');
      expect(upper).toEqual(lower);
    });

    it('.JSON is treated same as .json', () => {
      const lower = getFileIcon('data.json');
      const upper = getFileIcon('DATA.JSON');
      expect(upper).toEqual(lower);
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================
  describe('edge cases', () => {
    it('handles deeply nested paths', () => {
      const result = getFileIcon('src/lib/utils/helpers.ts');
      expect(result.color).toBe('#3178c6');
      expect(result.label).toBe('TypeScript');
    });

    it('handles file with multiple dots', () => {
      const result = getFileIcon('my.component.test.ts');
      expect(result.color).toBe('#3178c6');
      expect(result.label).toBe('TypeScript');
    });

    it('handles empty string', () => {
      const result = getFileIcon('');
      expect(result.color).toBe('#9ca3af');
      expect(result.label).toBe('File');
    });
  });
});
