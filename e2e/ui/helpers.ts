import type { Page, ElementHandle } from 'puppeteer';
import { DEFAULT_TIMEOUT } from './setup';

/**
 * Wait for a selector to be visible on the page
 */
export async function waitForSelector(
  page: Page,
  selector: string,
  options: { timeout?: number; visible?: boolean } = {}
): Promise<ElementHandle | null> {
  const { timeout = DEFAULT_TIMEOUT, visible = true } = options;

  try {
    const element = await page.waitForSelector(selector, {
      visible,
      timeout,
    });
    return element;
  } catch (error) {
    throw new Error(`Timeout waiting for selector: ${selector} (${timeout}ms)`);
  }
}

/**
 * Click an element and wait for navigation or network idle
 */
export async function clickAndWait(
  page: Page,
  selector: string,
  options: { waitForNavigation?: boolean; waitForSelector?: string } = {}
): Promise<void> {
  const { waitForNavigation = false, waitForSelector: waitFor } = options;

  if (waitForNavigation) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click(selector),
    ]);
  } else if (waitFor) {
    await Promise.all([
      page.waitForSelector(waitFor, { visible: true }),
      page.click(selector),
    ]);
  } else {
    await page.click(selector);
    // Small delay to allow for any async updates
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Get the text content of an element
 */
export async function getTextContent(
  page: Page,
  selector: string
): Promise<string | null> {
  try {
    const element = await page.waitForSelector(selector, {
      visible: true,
      timeout: DEFAULT_TIMEOUT,
    });

    if (!element) return null;

    const textContent = await page.evaluate(
      (el) => el?.textContent?.trim() || null,
      element
    );

    return textContent;
  } catch (error) {
    throw new Error(`Failed to get text content for selector: ${selector}`);
  }
}

/**
 * Get the value of an input element
 */
export async function getInputValue(
  page: Page,
  selector: string
): Promise<string | null> {
  try {
    const element = await page.waitForSelector(selector, { timeout: DEFAULT_TIMEOUT });
    if (!element) return null;

    const value = await page.evaluate(
      (el) => (el as HTMLInputElement).value,
      element
    );

    return value;
  } catch (error) {
    throw new Error(`Failed to get input value for selector: ${selector}`);
  }
}

/**
 * Type text into an input field
 */
export async function typeIntoInput(
  page: Page,
  selector: string,
  text: string,
  options: { clearFirst?: boolean } = {}
): Promise<void> {
  const { clearFirst = true } = options;

  await page.waitForSelector(selector, { visible: true });

  if (clearFirst) {
    // Triple-click to select all, then type to replace
    await page.click(selector, { clickCount: 3 });
  }

  await page.type(selector, text);
}

/**
 * Check if an element exists on the page
 */
export async function elementExists(
  page: Page,
  selector: string,
  timeout: number = 1000
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an element is visible on the page
 */
export async function isElementVisible(
  page: Page,
  selector: string
): Promise<boolean> {
  const element = await page.$(selector);
  if (!element) return false;

  const isVisible = await page.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  }, element);

  return isVisible;
}

/**
 * Wait for text to appear on the page
 */
export async function waitForText(
  page: Page,
  text: string,
  timeout: number = DEFAULT_TIMEOUT
): Promise<boolean> {
  try {
    await page.waitForFunction(
      (searchText) => {
        return document.body.textContent?.includes(searchText) || false;
      },
      { timeout },
      text
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all elements matching a selector
 */
export async function getAllElements(
  page: Page,
  selector: string
): Promise<ElementHandle[]> {
  await page.waitForSelector(selector, { timeout: DEFAULT_TIMEOUT }).catch(() => {});
  return page.$$(selector);
}

/**
 * Get the count of elements matching a selector
 */
export async function getElementCount(
  page: Page,
  selector: string
): Promise<number> {
  const elements = await page.$$(selector);
  return elements.length;
}

/**
 * Wait for an element to be removed from the DOM
 */
export async function waitForElementRemoved(
  page: Page,
  selector: string,
  timeout: number = DEFAULT_TIMEOUT
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, {
      hidden: true,
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

