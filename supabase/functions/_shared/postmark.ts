// PostmarkEmailProvider — the only place that knows Postmark's HTTP API and inbound webhook shape.
// Contract verified against postmarkapp.com/developer (2026-11-06):
//   POST https://api.postmarkapp.com/email  { From, To, Subject, HtmlBody|TextBody, MessageStream? }
//   headers: Accept: application/json, Content-Type: application/json, X-Postmark-Server-Token: <token>
//   → 200 { To, SubmittedAt, MessageID, ErrorCode, Message } (ErrorCode 0 = accepted)
//   Inbound webhook: POST to our URL with { From, FromFull: {Email,Name}, To, Subject, TextBody, HtmlBody,
//   StrippedTextReply, MessageID, Date, ... }. Postmark does not sign the body — Basic Auth embedded in the
//   configured webhook URL is Postmark's own documented way to authenticate it, checked against a shared secret.
// No Deno-only APIs here, so it is unit-tested under Node.

export const POSTMARK_BASE = 'https://api.postmarkapp.com';

export interface SendEmailInput {
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string;
  textBody: string;
}

/** Request body for POST /email (pure, so the mapping is testable). */
export function sendEmailBody(i: SendEmailInput) {
  return {
    From: i.fromName ? `${i.fromName} <${i.fromAddress}>` : i.fromAddress,
    To: i.toAddress,
    Subject: i.subject.slice(0, 2000),
    TextBody: i.textBody,
    MessageStream: 'outbound',
  };
}

export type FailureKind = 'permanent' | 'ambiguous';

/** Postmark returns 200 with ErrorCode for most failures; only a non-2xx HTTP status is a transport-level failure. */
export function classifyFailure(status: number | null): FailureKind {
  if (status != null && status >= 400 && status < 500 && status !== 429) return 'permanent';
  return 'ambiguous';
}

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; status: number | null; kind: FailureKind; message: string };

export interface PostmarkSendResponse {
  To: string;
  SubmittedAt: string;
  MessageID: string;
  ErrorCode: number;
  Message: string;
}

export class PostmarkEmailProvider {
  constructor(private serverToken: string, private fetchImpl: typeof fetch = fetch, private timeoutMs = 8000) {}

  async sendEmail(i: SendEmailInput): Promise<ProviderResult<PostmarkSendResponse>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${POSTMARK_BASE}/email`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': this.serverToken },
        body: JSON.stringify(sendEmailBody(i)),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, kind: classifyFailure(res.status), message: `Postmark HTTP ${res.status}` };
      const parsed = JSON.parse(text) as PostmarkSendResponse;
      if (parsed.ErrorCode !== 0) return { ok: false, status: res.status, kind: 'permanent', message: `Postmark error ${parsed.ErrorCode}: ${parsed.Message}` };
      return { ok: true, value: parsed };
    } catch (e) {
      const timeout = (e as Error)?.name === 'AbortError';
      return { ok: false, status: null, kind: 'ambiguous', message: timeout ? 'Postmark request timed out' : 'Postmark request failed (network)' };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface InboundEmail {
  fromEmail: string;
  fromName: string;
  toAddress: string;
  subject: string;
  textBody: string;
  messageId: string;
}

/** Minimal structural parse of Postmark's inbound webhook payload. Prefers StrippedTextReply over the full TextBody
 * when present, so a reply thread doesn't re-ingest the whole quoted history as the message body each time. */
export function parseInboundEmail(raw: string): { ok: true; email: InboundEmail } | { ok: false; error: string } {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  const o = j as Record<string, unknown>;
  const fromFull = o.FromFull as Record<string, unknown> | undefined;
  const fromEmail = typeof fromFull?.Email === 'string' ? fromFull.Email : typeof o.From === 'string' ? o.From : '';
  if (!fromEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail)) return { ok: false, error: 'missing_from' };
  if (typeof o.MessageID !== 'string' || o.MessageID.length < 1) return { ok: false, error: 'missing_message_id' };
  const toRaw = o.ToFull as unknown[] | undefined;
  const firstTo = Array.isArray(toRaw) && toRaw[0] ? (toRaw[0] as Record<string, unknown>).Email : undefined;
  const toAddress = typeof firstTo === 'string' ? firstTo : typeof o.OriginalRecipient === 'string' ? o.OriginalRecipient : '';
  if (!toAddress) return { ok: false, error: 'missing_to' };
  const body = typeof o.StrippedTextReply === 'string' && o.StrippedTextReply.trim() ? o.StrippedTextReply : typeof o.TextBody === 'string' ? o.TextBody : '';
  return {
    ok: true,
    email: {
      fromEmail: fromEmail.toLowerCase(),
      fromName: typeof fromFull?.Name === 'string' ? fromFull.Name : '',
      toAddress: toAddress.toLowerCase(),
      subject: typeof o.Subject === 'string' ? o.Subject : '',
      textBody: body.slice(0, 20000),
      messageId: o.MessageID,
    },
  };
}

/** Basic Auth check against a shared secret (Postmark embeds user:pass in the configured webhook URL). */
export function verifyBasicAuth(header: string | null, expectedSecret: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const password = decoded.slice(idx + 1);
  if (password.length !== expectedSecret.length) return false;
  let diff = 0;
  for (let i = 0; i < password.length; i++) diff |= password.charCodeAt(i) ^ expectedSecret.charCodeAt(i);
  return diff === 0;
}
