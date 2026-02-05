import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings, hexToHSL, isValidHex, defaultSettings, applyAccentColor } from '../../lib/settings';

describe('settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('loadSettings', () => {
    it('returns defaults when localStorage is empty', () => {
      const settings = loadSettings();
      expect(settings).toEqual(defaultSettings);
    });

    it('returns saved settings merged with defaults', () => {
      localStorage.setItem('codeflare-settings', JSON.stringify({ accentColor: '#ff0000' }));
      const settings = loadSettings();
      expect(settings.accentColor).toBe('#ff0000');
    });

    it('returns defaults for invalid JSON', () => {
      localStorage.setItem('codeflare-settings', 'not-valid-json');
      const settings = loadSettings();
      expect(settings).toEqual(defaultSettings);
    });

    it('preserves all fields from saved settings', () => {
      const custom = { accentColor: '#ff0000' };
      localStorage.setItem('codeflare-settings', JSON.stringify(custom));
      const settings = loadSettings();
      expect(settings).toEqual({ ...defaultSettings, ...custom });
    });
  });

  describe('saveSettings', () => {
    it('persists settings to localStorage', () => {
      const settings = { accentColor: '#8b5cf6' };
      saveSettings(settings);
      const stored = JSON.parse(localStorage.getItem('codeflare-settings')!);
      expect(stored.accentColor).toBe('#8b5cf6');
    });

    it('can be loaded back after saving', () => {
      const settings = { accentColor: '#3b82f6' };
      saveSettings(settings);
      const loaded = loadSettings();
      expect(loaded.accentColor).toBe('#3b82f6');
    });
  });

  describe('hexToHSL', () => {
    it('converts pure red (#ff0000)', () => {
      const hsl = hexToHSL('#ff0000');
      expect(hsl).toEqual({ h: 0, s: 100, l: 50 });
    });

    it('converts pure green (#00ff00)', () => {
      const hsl = hexToHSL('#00ff00');
      expect(hsl).toEqual({ h: 120, s: 100, l: 50 });
    });

    it('converts pure blue (#0000ff)', () => {
      const hsl = hexToHSL('#0000ff');
      expect(hsl).toEqual({ h: 240, s: 100, l: 50 });
    });

    it('converts white (#ffffff)', () => {
      const hsl = hexToHSL('#ffffff');
      expect(hsl).toEqual({ h: 0, s: 0, l: 100 });
    });

    it('converts black (#000000)', () => {
      const hsl = hexToHSL('#000000');
      expect(hsl).toEqual({ h: 0, s: 0, l: 0 });
    });

    it('handles 3-digit hex (#f00)', () => {
      const hsl = hexToHSL('#f00');
      expect(hsl).toEqual({ h: 0, s: 100, l: 50 });
    });

    it('handles hex without # prefix', () => {
      const hsl = hexToHSL('8b5cf6');
      expect(hsl).not.toBeNull();
      expect(hsl!.h).toBeGreaterThan(0);
    });

    it('returns null for invalid hex', () => {
      expect(hexToHSL('xyz')).toBeNull();
      expect(hexToHSL('#gggggg')).toBeNull();
      expect(hexToHSL('')).toBeNull();
    });
  });

  describe('isValidHex', () => {
    it('validates 6-digit hex with #', () => {
      expect(isValidHex('#ff0000')).toBe(true);
      expect(isValidHex('#8b5cf6')).toBe(true);
    });

    it('validates 3-digit hex with #', () => {
      expect(isValidHex('#f00')).toBe(true);
    });

    it('validates hex without #', () => {
      expect(isValidHex('ff0000')).toBe(true);
      expect(isValidHex('abc')).toBe(true);
    });

    it('rejects invalid hex', () => {
      expect(isValidHex('xyz')).toBe(false);
      expect(isValidHex('#gg0000')).toBe(false);
      expect(isValidHex('')).toBe(false);
      expect(isValidHex('#12345')).toBe(false);
    });
  });

  describe('applyAccentColor', () => {
    it('sets CSS custom properties for valid hex', () => {
      applyAccentColor('#ff0000');
      const root = document.documentElement.style;
      expect(root.getPropertyValue('--accent-hue')).toBe('0');
      expect(root.getPropertyValue('--accent-s')).toBe('100%');
      expect(root.getPropertyValue('--accent-l')).toBe('50%');
    });

    it('removes CSS custom properties when no color provided', () => {
      // First set, then clear
      applyAccentColor('#ff0000');
      applyAccentColor(undefined);
      const root = document.documentElement.style;
      expect(root.getPropertyValue('--accent-hue')).toBe('');
    });

    it('removes CSS custom properties for invalid hex', () => {
      applyAccentColor('#ff0000');
      applyAccentColor('not-a-color');
      const root = document.documentElement.style;
      expect(root.getPropertyValue('--accent-hue')).toBe('');
    });
  });
});
