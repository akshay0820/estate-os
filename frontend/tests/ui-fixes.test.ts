// Fixes from the 2026-10-27 full test that live in the frontend: readable sign-up errors and relative times that do not
// put a moment-old event in the future when the server clock runs slightly ahead.
import { describe, expect, it } from 'vitest';
import { authMessage } from '@/backend/authMessages';
import { relTime } from '@/lib/format';

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
