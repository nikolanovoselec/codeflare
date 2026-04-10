// Implements REQ-SUB-020
import { describe, it, expect } from 'vitest';
import { getCurrencyForCountry, SUPPORTED_CURRENCIES } from '../../lib/currency';

describe('getCurrencyForCountry', () => {
  it('returns CHF for Switzerland', () => {
    expect(getCurrencyForCountry('CH')).toBe('chf');
  });

  it('returns CHF for Liechtenstein', () => {
    expect(getCurrencyForCountry('LI')).toBe('chf');
  });

  it('returns GBP for United Kingdom', () => {
    expect(getCurrencyForCountry('GB')).toBe('gbp');
  });

  it('returns EUR for Germany', () => {
    expect(getCurrencyForCountry('DE')).toBe('eur');
  });

  it('returns EUR for France', () => {
    expect(getCurrencyForCountry('FR')).toBe('eur');
  });

  it('returns EUR for all 20 Eurozone countries', () => {
    const eurozone = ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'FI', 'PT', 'GR', 'LU', 'SI', 'SK', 'EE', 'LV', 'LT', 'MT', 'CY', 'HR'];
    for (const country of eurozone) {
      expect(getCurrencyForCountry(country)).toBe('eur');
    }
  });

  it('returns USD for United States', () => {
    expect(getCurrencyForCountry('US')).toBe('usd');
  });

  it('returns USD for unknown country codes', () => {
    expect(getCurrencyForCountry('JP')).toBe('usd');
    expect(getCurrencyForCountry('BR')).toBe('usd');
    expect(getCurrencyForCountry('AU')).toBe('usd');
    expect(getCurrencyForCountry('XX')).toBe('usd');
  });

  it('returns USD for empty string', () => {
    expect(getCurrencyForCountry('')).toBe('usd');
  });
});

describe('SUPPORTED_CURRENCIES', () => {
  it('contains exactly 4 currencies', () => {
    expect(SUPPORTED_CURRENCIES).toHaveLength(4);
  });

  it('includes chf, usd, eur, gbp', () => {
    expect(SUPPORTED_CURRENCIES).toContain('chf');
    expect(SUPPORTED_CURRENCIES).toContain('usd');
    expect(SUPPORTED_CURRENCIES).toContain('eur');
    expect(SUPPORTED_CURRENCIES).toContain('gbp');
  });
});
