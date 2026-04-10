// Implements REQ-SUB-020

export const SUPPORTED_CURRENCIES = ['chf', 'usd', 'eur', 'gbp'] as const;
type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

/** All European countries default to EUR (except CH/LI → CHF, GB → GBP). */
const EUR_COUNTRIES = new Set([
  // Eurozone members
  'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
  // EU members outside Eurozone
  'BG', 'CZ', 'DK', 'HU', 'PL', 'RO', 'SE',
  // Non-EU European
  'AD', 'AL', 'AX', 'BA', 'BY', 'FO', 'IS', 'MC', 'MD', 'ME',
  'MK', 'NO', 'RS', 'SJ', 'SM', 'TR', 'UA', 'VA', 'XK',
]);

/** Map a 2-letter ISO country code to a supported currency. */
export function getCurrencyForCountry(country: string): SupportedCurrency {
  if (country === 'CH' || country === 'LI') return 'chf';
  if (country === 'GB' || country === 'GI' || country === 'GG' || country === 'JE' || country === 'IM') return 'gbp';
  if (EUR_COUNTRIES.has(country)) return 'eur';
  return 'usd';
}
