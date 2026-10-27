// Supabase Auth error text → what a person signing in or up should read. Kept free of browser imports so it can be tested.

export function authMessage(raw: string) {
  if (/invalid login credentials/i.test(raw)) return 'Email or password is incorrect.';
  if (/email not confirmed/i.test(raw)) return 'Confirm your email first — check your inbox for the link.';
  if (/password should be|weak password/i.test(raw)) return 'Choose a stronger password (at least 8 characters, mixing letters and numbers).';
  if (/already registered|already exists/i.test(raw)) return 'An account with this email already exists. Sign in instead.';
  // The mail service's hourly cap is not the person's fault and is not lifted by waiting a minute.
  if (/email rate limit|over_email_send_rate_limit/i.test(raw)) return 'We can’t send emails right now (sending limit reached). Please try again later or contact support.';
  if (/rate limit|too many/i.test(raw)) return 'Too many attempts. Wait a minute and try again.';
  if (/signups? (are )?(not allowed|disabled)/i.test(raw)) return 'New sign-ups are closed. Ask your agency’s owner for an invitation.';
  // Supabase refuses an address it cannot send the confirmation email to, and reports SMTP failures separately.
  if (/email address .* is invalid|email_address_invalid|not authorized/i.test(raw)) return 'We couldn’t send a confirmation email to this address. Check it, or use another work email.';
  if (/sending (confirmation|recovery|magic link|invite)|send.*email/i.test(raw)) return 'We couldn’t send the confirmation email right now. Please try again later or contact support.';
  return `We couldn’t complete that request: ${raw.replace(/\.$/, '')}.`;
}
