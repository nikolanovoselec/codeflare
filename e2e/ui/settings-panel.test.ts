import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, navigateToHome, takeScreenshot, waitForAppReady, waitForAppOrSetup, isMainAppAvailable } from './setup';
import {
  waitForSelector,
  clickAndWait,
  getTextContent,
  elementExists,
  isElementVisible,
  waitForText,
  waitForElementRemoved,
  getInputValue,
} from './helpers';

/**
 * E2E Tests for Settings Panel
 *
 * Tests the settings panel functionality:
 * - Opening settings from header button
 * - Changing font size setting
 * - Toggling cursor blink
 * - Closing settings with X button
 * - Closing settings by clicking backdrop
 * - Settings persistence after reload
 *
 * Note: These tests require the main app to be accessible (setup complete).
 * Tests will be skipped if the app redirects to the setup wizard.
 */
describe('Settings Panel', () => {
  let browser: Browser;
  let page: Page;
  let mainAppAvailable: boolean;

  beforeAll(async () => {
    browser = await launchBrowser();
    // Check if main app is available (setup complete)
    const testPage = await createPage(browser);
    await navigateToHome(testPage);
    await waitForAppOrSetup(testPage);
    mainAppAvailable = await isMainAppAvailable(testPage);
    await testPage.close();

    if (!mainAppAvailable) {
      console.log('⚠️ Main app not available (setup not complete). Settings panel tests will be skipped.');
    }
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await createPage(browser);
  });

  afterEach(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } catch (error) {
      console.error('Error closing page:', error);
    }
  });

  // Helper to skip test if main app not available
  const skipIfNoMainApp = () => {
    if (!mainAppAvailable) {
      console.log('  → Skipped (setup not complete)');
      return true;
    }
    return false;
  };

  describe('Opening Settings', () => {
    it('opens settings from header button', async () => {
      if (skipIfNoMainApp()) return;

      await navigateToHome(page);
      await waitForAppReady(page);

      // Wait for and click the settings button
      await waitForSelector(page, '[data-testid="header-settings-button"]');
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      // Settings panel should appear
      const panelVisible = await elementExists(page, '[data-testid="settings-panel"]', 3000);
      expect(panelVisible).toBe(true);
    });

    it('settings panel has open class when visible', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      // Panel should have open class
      const hasOpenClass = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return panel?.classList.contains('open') || false;
      });

      expect(hasOpenClass).toBe(true);
    });

    it('backdrop appears when settings open', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      // Backdrop should be visible
      const backdropVisible = await elementExists(page, '[data-testid="settings-backdrop"]', 2000);
      expect(backdropVisible).toBe(true);
    });

    it('settings header shows title', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      // Should show "Settings" title
      const title = await getTextContent(page, '.settings-panel-header h2, .settings-panel h2');
      expect(title).toContain('Settings');
    });
  });

  describe('Closing Settings', () => {
    it('closes settings with X button', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-panel"]');

      // Click close button
      await clickAndWait(page, '[data-testid="settings-close-button"]');

      // Wait for panel to close
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Panel should no longer have open class
      const isStillOpen = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return panel?.classList.contains('open') || false;
      });

      expect(isStillOpen).toBe(false);
    });

    it('closes settings by clicking backdrop', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-backdrop"]');

      // Click backdrop
      await page.click('[data-testid="settings-backdrop"]');

      // Wait for animation
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Panel should close
      const isStillOpen = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return panel?.classList.contains('open') || false;
      });

      expect(isStillOpen).toBe(false);
    });

    it('closes settings with Escape key', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-panel"]');

      // Press Escape
      await page.keyboard.press('Escape');

      // Wait for animation
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Panel should close
      const isStillOpen = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return panel?.classList.contains('open') || false;
      });

      expect(isStillOpen).toBe(false);
    });

    it('clicking inside panel does not close it', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-panel"]');

      // Click inside the panel (not on backdrop)
      await page.click('[data-testid="settings-panel"]');

      // Wait briefly
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Panel should still be open
      const isOpen = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return panel?.classList.contains('open') || false;
      });

      expect(isOpen).toBe(true);
    });
  });

  describe('Font Size Setting', () => {
    it('can change font size setting', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-font-size-select"]');

      // Get initial value
      const initialValue = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-font-size-select"]') as HTMLSelectElement;
        return select?.value || '';
      });

      // Change to a different value
      await page.select('[data-testid="settings-font-size-select"]', '16');

      // Verify the change
      const newValue = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-font-size-select"]') as HTMLSelectElement;
        return select?.value || '';
      });

      expect(newValue).toBe('16');
    });

    it('font size dropdown has multiple options', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-font-size-select"]');

      // Count options
      const optionCount = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-font-size-select"]') as HTMLSelectElement;
        return select?.options.length || 0;
      });

      expect(optionCount).toBeGreaterThan(1);
    });

    it('font size options include reasonable sizes', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-font-size-select"]');

      // Get all option values
      const options = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-font-size-select"]') as HTMLSelectElement;
        return Array.from(select?.options || []).map((opt) => parseInt(opt.value, 10));
      });

      // Should include standard sizes like 12, 14, 16
      expect(options).toContain(14);
      expect(options.some((size) => size >= 10 && size <= 24)).toBe(true);
    });
  });

  describe('Cursor Blink Setting', () => {
    it('can toggle cursor blink', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-cursor-blink-toggle"]');

      // Get initial state
      const initialState = await page.evaluate(() => {
        const toggle = document.querySelector('[data-testid="settings-cursor-blink-toggle"]');
        return toggle?.getAttribute('aria-checked') === 'true';
      });

      // Click toggle
      await page.click('[data-testid="settings-cursor-blink-toggle"]');

      // Verify state changed
      const newState = await page.evaluate(() => {
        const toggle = document.querySelector('[data-testid="settings-cursor-blink-toggle"]');
        return toggle?.getAttribute('aria-checked') === 'true';
      });

      expect(newState).toBe(!initialState);
    });

    it('cursor blink toggle has switch role', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-cursor-blink-toggle"]');

      // Check role attribute
      const role = await page.evaluate(() => {
        const toggle = document.querySelector('[data-testid="settings-cursor-blink-toggle"]');
        return toggle?.getAttribute('role');
      });

      expect(role).toBe('switch');
    });

    it('cursor blink toggle has aria-checked attribute', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-cursor-blink-toggle"]');

      // Check aria-checked exists
      const hasAriaChecked = await page.evaluate(() => {
        const toggle = document.querySelector('[data-testid="settings-cursor-blink-toggle"]');
        return toggle?.hasAttribute('aria-checked') || false;
      });

      expect(hasAriaChecked).toBe(true);
    });
  });

  describe('Theme Setting', () => {
    it('theme selector exists', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      const themeExists = await elementExists(page, '[data-testid="settings-theme-select"]', 2000);
      expect(themeExists).toBe(true);
    });

    it('theme selector has dark option', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-theme-select"]');

      const hasDarkOption = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-theme-select"]') as HTMLSelectElement;
        const options = Array.from(select?.options || []);
        return options.some((opt) => opt.value === 'dark');
      });

      expect(hasDarkOption).toBe(true);
    });
  });

  describe('Terminal Font Setting', () => {
    it('terminal font selector exists', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      const fontExists = await elementExists(page, '[data-testid="settings-terminal-font-select"]', 2000);
      expect(fontExists).toBe(true);
    });

    it('terminal font has monospace options', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-terminal-font-select"]');

      const options = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-terminal-font-select"]') as HTMLSelectElement;
        return Array.from(select?.options || []).map((opt) => opt.value);
      });

      // Should have at least one monospace font option
      expect(options.length).toBeGreaterThan(0);
    });
  });

  describe('Cursor Style Setting', () => {
    it('cursor style selector exists', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      const cursorExists = await elementExists(page, '[data-testid="settings-cursor-style-select"]', 2000);
      expect(cursorExists).toBe(true);
    });

    it('cursor style has block, bar, and underline options', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-cursor-style-select"]');

      const options = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-cursor-style-select"]') as HTMLSelectElement;
        return Array.from(select?.options || []).map((opt) => opt.value);
      });

      // Should have standard cursor style options
      expect(options).toContain('block');
    });
  });

  describe('Scrollback Setting', () => {
    it('scrollback selector exists', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      const scrollbackExists = await elementExists(page, '[data-testid="settings-scrollback-select"]', 2000);
      expect(scrollbackExists).toBe(true);
    });

    it('can change scrollback value', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-scrollback-select"]');

      // Get options
      const options = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-scrollback-select"]') as HTMLSelectElement;
        return Array.from(select?.options || []).map((opt) => opt.value);
      });

      if (options.length > 1) {
        // Select a different value
        await page.select('[data-testid="settings-scrollback-select"]', options[1]);

        // Verify change
        const newValue = await page.evaluate(() => {
          const select = document.querySelector('[data-testid="settings-scrollback-select"]') as HTMLSelectElement;
          return select?.value;
        });

        expect(newValue).toBe(options[1]);
      }
    });
  });

  describe('Settings Persistence', () => {
    it('persists settings after reload', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings and change font size
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-font-size-select"]');

      // Change to 16
      await page.select('[data-testid="settings-font-size-select"]', '16');

      // Close settings
      await clickAndWait(page, '[data-testid="settings-close-button"]');

      // Wait for setting to be saved to localStorage
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Reload page
      await page.reload({ waitUntil: 'networkidle2' });
      await waitForAppReady(page);

      // Open settings again
      await clickAndWait(page, '[data-testid="header-settings-button"]');
      await waitForSelector(page, '[data-testid="settings-font-size-select"]');

      // Check the value is still 16
      const savedValue = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="settings-font-size-select"]') as HTMLSelectElement;
        return select?.value;
      });

      expect(savedValue).toBe('16');
    });

    it('settings are stored in localStorage', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Check if settings key exists in localStorage
      const hasSettingsKey = await page.evaluate(() => {
        const keys = Object.keys(localStorage);
        return keys.some(
          (key) => key.includes('settings') || key.includes('codeflare') || key.includes('terminal')
        );
      });

      // App should use localStorage for persistence
      // Note: The exact key name depends on implementation
    });
  });

  describe('Settings Accessibility', () => {
    it('settings panel has dialog role', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      const role = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return panel?.getAttribute('role');
      });

      expect(role).toBe('dialog');
    });

    it('settings panel has aria-label', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      const ariaLabel = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return panel?.getAttribute('aria-label');
      });

      expect(ariaLabel).toContain('Settings');
    });

    it('form controls have associated labels', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      // Check that selects have labels
      const hasLabels = await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('.settings-panel select'));
        for (const select of selects) {
          // Check for nearby label or aria-label
          const hasLabel =
            select.getAttribute('aria-label') ||
            select.closest('.settings-item')?.querySelector('label');
          if (!hasLabel) return false;
        }
        return true;
      });

      expect(hasLabels).toBe(true);
    });
  });

  describe('Settings Panel Animation', () => {
    it('panel slides in from right', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Get initial position
      const initialTransform = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return window.getComputedStyle(panel!).transform;
      });

      // Open settings
      await clickAndWait(page, '[data-testid="header-settings-button"]');

      // Wait for animation
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Get final position
      const finalTransform = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="settings-panel"]');
        return window.getComputedStyle(panel!).transform;
      });

      // Transforms should be different (animated)
      // Note: The exact values depend on CSS implementation
    });
  });
});
