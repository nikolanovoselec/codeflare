export interface Settings {
  accentColor?: string;
  showButtonLabels?: boolean;
  showTips?: boolean;
  samsungAddressBarTop?: boolean;
}

/** Convert a hex color string to HSL values */
export function hexToHSL(hex: string): { h: number; s: number; l: number } | null {
  const clean = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(clean)) return null;

  let r: number, g: number, b: number;
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16) / 255;
    g = parseInt(clean[1] + clean[1], 16) / 255;
    b = parseInt(clean[2] + clean[2], 16) / 255;
  } else {
    r = parseInt(clean.slice(0, 2), 16) / 255;
    g = parseInt(clean.slice(2, 4), 16) / 255;
    b = parseInt(clean.slice(4, 6), 16) / 255;
  }

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

/** Validate a hex color string (with or without #) */
export function isValidHex(hex: string): boolean {
  const clean = hex.replace(/^#/, '');
  return /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(clean);
}

/** Apply accent color to CSS custom properties, or reset to defaults */
export function applyAccentColor(hexColor?: string): void {
  const root = document.documentElement.style;
  if (hexColor && isValidHex(hexColor)) {
    const hsl = hexToHSL(hexColor);
    if (hsl) {
      root.setProperty('--accent-hue', String(hsl.h));
      root.setProperty('--accent-s', `${hsl.s}%`);
      root.setProperty('--accent-l', `${hsl.l}%`);
      return;
    }
  }
  root.removeProperty('--accent-hue');
  root.removeProperty('--accent-s');
  root.removeProperty('--accent-l');
}

export const defaultSettings: Settings = {
  showButtonLabels: true,
  showTips: true,
  samsungAddressBarTop: false,
};

const STORAGE_KEY = 'codeflare-settings';

export const loadSettings = (): Settings => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
};

export const saveSettings = (settings: Settings): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Silently fail if localStorage is not available
  }
};
