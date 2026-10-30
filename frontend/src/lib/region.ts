// Countries and time zones offered for a workspace. Phones without a country code take the workspace country's code
// (organizations.country_code; the database's private.normalize_phone applies the same rule).

export const COUNTRIES: [code: string, name: string, dial: string][] = [
  ['US', 'United States', '+1'],
  ['CA', 'Canada', '+1'],
  ['GB', 'United Kingdom', '+44'],
  ['AE', 'United Arab Emirates', '+971'],
  ['IN', 'India', '+91'],
];

export const TIME_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
  'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'Europe/London', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
];

/** The browser's own zone when it is one we offer, so a new workspace starts in its creator's time. */
export function browserTimeZone(fallback = 'America/New_York'): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIME_ZONES.includes(tz) ? tz : fallback;
  } catch {
    return fallback;
  }
}

/** Country implied by a time zone, for the setup form's first guess. */
export function countryForTimeZone(tz: string): string {
  if (tz === 'America/Toronto' || tz === 'America/Vancouver') return 'CA';
  if (tz.startsWith('America/') || tz === 'Pacific/Honolulu') return 'US';
  return ({ 'Europe/London': 'GB', 'Asia/Dubai': 'AE', 'Asia/Kolkata': 'IN' } as Record<string, string>)[tz] ?? 'US';
}

/** Example number shown in phone fields. */
export function phonePlaceholder(country: string): string {
  return country === 'IN' ? '98200 12345' : country === 'GB' ? '07700 900123' : country === 'AE' ? '050 123 4567' : '(415) 555-0134';
}
