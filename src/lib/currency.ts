// Implements REQ-SUB-020

export const SUPPORTED_CURRENCIES = ['chf', 'usd', 'eur', 'gbp'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

const EUR_COUNTRIES = new Set([
  'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'FI', 'PT',
  'GR', 'LU', 'SI', 'SK', 'EE', 'LV', 'LT', 'MT', 'CY', 'HR',
]);

/** Map a 2-letter ISO country code to a supported currency. */
export function getCurrencyForCountry(country: string): SupportedCurrency {
  if (country === 'CH' || country === 'LI') return 'chf';
  if (country === 'GB') return 'gbp';
  if (EUR_COUNTRIES.has(country)) return 'eur';
  return 'usd';
}
