import { describe, it, expect } from 'vitest';
import { getCurrencyForCountry } from '../../lib/currency';

describe('getCurrencyForCountry', () => {
  it('returns CHF for Switzerland', () => {
    expect(getCurrencyForCountry('CH')).toBe('chf');
  });

  it('returns CHF for Liechtenstein', () => {
    expect(getCurrencyForCountry('LI')).toBe('chf');
  });

  it('returns GBP for United Kingdom and British territories', () => {
    expect(getCurrencyForCountry('GB')).toBe('gbp');
    expect(getCurrencyForCountry('GI')).toBe('gbp');
    expect(getCurrencyForCountry('GG')).toBe('gbp');
    expect(getCurrencyForCountry('JE')).toBe('gbp');
    expect(getCurrencyForCountry('IM')).toBe('gbp');
  });

  it('returns EUR for Germany', () => {
    expect(getCurrencyForCountry('DE')).toBe('eur');
  });

  it('returns EUR for France', () => {
    expect(getCurrencyForCountry('FR')).toBe('eur');
  });

  it('returns EUR for all European countries (except CH/LI/GB)', () => {
    const european = [
      // Eurozone
      'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
      'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
      // EU non-Eurozone
      'BG', 'CZ', 'DK', 'HU', 'PL', 'RO', 'SE',
      // Non-EU European
      'AD', 'AL', 'AX', 'BA', 'BY', 'FO', 'IS', 'MC', 'MD', 'ME',
      'MK', 'NO', 'RS', 'SJ', 'SM', 'TR', 'UA', 'VA', 'XK',
    ];
    for (const country of european) {
      expect(getCurrencyForCountry(country)).toBe('eur');
    }
  });

  it('returns EUR for non-Eurozone European countries', () => {
    expect(getCurrencyForCountry('NO')).toBe('eur');
    expect(getCurrencyForCountry('SE')).toBe('eur');
    expect(getCurrencyForCountry('PL')).toBe('eur');
    expect(getCurrencyForCountry('UA')).toBe('eur');
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
