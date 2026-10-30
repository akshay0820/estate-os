// Fixes from the 2026-10-27 full test that live in the frontend: readable sign-up errors and relative times that do not
// put a moment-old event in the future when the server clock runs slightly ahead.
import { describe, expect, it } from 'vitest';
import { authMessage } from '@/backend/authMessages';
import { budgetInputUnit, currencySymbol, money, relTime, setMoneyCurrency } from '@/lib/format';
import { normalizePhone } from '@/lib/util';
import { TIME_ZONES, browserTimeZone, countryForTimeZone, phonePlaceholder } from '@/lib/region';

describe('authMessage', () => {
  it('explains a confirmation email that cannot be sent instead of a generic failure', () => {
    expect(authMessage('Email address "a@b.test" is invalid')).toMatch(/couldn’t send a confirmation email to this address/);
    expect(authMessage('Error sending confirmation email')).toMatch(/couldn’t send the confirmation email right now/);
    expect(authMessage('Signups not allowed for this instance')).toMatch(/sign-ups are closed/);
    expect(authMessage('email rate limit exceeded')).toMatch(/sending limit reached/);
    expect(authMessage('Request rate limit reached')).toBe('Too many attempts. Wait a minute and try again.');
  });

  it('keeps the known messages and shows the server reason for anything else', () => {
    expect(authMessage('Invalid login credentials')).toBe('Email or password is incorrect.');
    expect(authMessage('User already registered')).toMatch(/already exists/);
    expect(authMessage('Something unexpected happened.')).toBe('We couldn’t complete that request: Something unexpected happened.');
  });
});

describe('relTime', () => {
  const now = 1_800_000_000_000;
  it('treats a timestamp a few seconds ahead as "just now"', () => {
    expect(relTime(now + 5_000, now)).toBe('just now');
    expect(relTime(now + 25_000, now)).toBe('just now');
    expect(relTime(now - 10_000, now)).toBe('just now');
  });

  it('still says "in a moment" for something genuinely due shortly', () => {
    expect(relTime(now + 40_000, now)).toBe('in a moment');
  });
});

describe('money', () => {
  it('formats US dollars by default, compact for large sums', () => {
    setMoneyCurrency('USD');
    expect(money(1_250_000)).toBe('$1.25M');
    expect(money(850_000)).toBe('$850K');
    expect(money(45_000)).toBe('$45K');
    expect(money(4_500)).toBe('$4,500');
    expect(money(1_250_000, { compact: false })).toBe('$1,250,000');
    expect(currencySymbol()).toBe('$');
    expect(budgetInputUnit()).toEqual({ label: '$', multiplier: 1 });
  });

  it('keeps lakh and crore for an INR workspace, and an explicit currency wins', () => {
    setMoneyCurrency('INR');
    expect(money(15_000_000)).toBe('₹1.5 Cr');
    expect(money(8_500_000)).toBe('₹85 L');
    expect(budgetInputUnit()).toEqual({ label: '₹ lakh', multiplier: 1e5 });
    expect(money(900_000, { currency: 'USD' })).toBe('$900K');
    setMoneyCurrency('USD');
  });
});

describe('phones and time zones', () => {
  it('a US workspace reads 10-digit numbers as +1; India keeps +91; a country code always wins', () => {
    expect(normalizePhone('(415) 555-0134', 'US')).toBe('+14155550134');
    expect(normalizePhone('1-212-555-0188', 'US')).toBe('+12125550188');
    expect(normalizePhone('98444 00001', 'IN')).toBe('+919844400001');
    expect(normalizePhone('+44 20 7946 0958', 'US')).toBe('+442079460958');
    expect(normalizePhone('0044 20 7946 0958', 'US')).toBe('+442079460958');
    expect(normalizePhone('(015) 555-0134', 'US')).toBe('');
  });

  it('guesses the country from the time zone and offers matching examples', () => {
    expect(countryForTimeZone('America/Chicago')).toBe('US');
    expect(countryForTimeZone('America/Toronto')).toBe('CA');
    expect(countryForTimeZone('Asia/Kolkata')).toBe('IN');
    expect(phonePlaceholder('US')).toBe('(415) 555-0134');
    expect(TIME_ZONES).toContain(browserTimeZone());
  });
});
