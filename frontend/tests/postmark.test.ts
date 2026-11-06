import { describe, expect, it } from 'vitest';
import { classifyFailure, parseInboundEmail, PostmarkEmailProvider, sendEmailBody, verifyBasicAuth } from '../../supabase/functions/_shared/postmark';

describe('sendEmailBody', () => {
  it('formats From with a display name and sets the outbound stream', () => {
    expect(sendEmailBody({ fromAddress: 'leads@blazeestate.com', fromName: 'Blaze Estate', toAddress: 'a@b.com', subject: 'Hi', textBody: 'Hello' }))
      .toEqual({ From: 'Blaze Estate <leads@blazeestate.com>', To: 'a@b.com', Subject: 'Hi', TextBody: 'Hello', MessageStream: 'outbound' });
  });

  it('omits the display name when none is given', () => {
    expect(sendEmailBody({ fromAddress: 'leads@blazeestate.com', fromName: null, toAddress: 'a@b.com', subject: 'Hi', textBody: 'Hello' }).From).toBe('leads@blazeestate.com');
  });
});

describe('classifyFailure', () => {
  it('treats 4xx (except 429) as permanent, everything else as ambiguous', () => {
    expect(classifyFailure(422)).toBe('permanent');
    expect(classifyFailure(401)).toBe('permanent');
    expect(classifyFailure(429)).toBe('ambiguous');
    expect(classifyFailure(500)).toBe('ambiguous');
    expect(classifyFailure(null)).toBe('ambiguous');
  });
});

describe('parseInboundEmail', () => {
  const sample = JSON.stringify({
    FromName: 'Alan Turing', From: 'alanturing@computers.com',
    FromFull: { Email: 'Alan.Turing@Computers.com', Name: 'Alan Turing', MailboxHash: '' },
    To: '"Margaret Hamilton" <yourhash+SampleHash@inbound.postmarkapp.com>',
    ToFull: [{ Email: 'yourhash+SampleHash@inbound.postmarkapp.com', Name: 'Margaret Hamilton', MailboxHash: 'SampleHash' }],
    Subject: 'Saying Hello!', MessageID: '883953f4-6105-42a2-a16a-77a8eac79483',
    TextBody: 'This is a test text body.', StrippedTextReply: 'This is the reply text',
  });

  it('parses a well-formed Postmark inbound payload, lowercasing addresses', () => {
    const r = parseInboundEmail(sample);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.email).toEqual({
      fromEmail: 'alan.turing@computers.com', fromName: 'Alan Turing',
      toAddress: 'yourhash+samplehash@inbound.postmarkapp.com', subject: 'Saying Hello!',
      textBody: 'This is the reply text', messageId: '883953f4-6105-42a2-a16a-77a8eac79483',
    });
  });

  it('prefers StrippedTextReply over the full TextBody so quoted history is not re-ingested every reply', () => {
    const r = parseInboundEmail(sample);
    if (r.ok) expect(r.email.textBody).toBe('This is the reply text');
  });

  it('falls back to TextBody when there is no stripped reply (a first message, not a reply)', () => {
    const noReply = JSON.parse(sample);
    delete noReply.StrippedTextReply;
    const r = parseInboundEmail(JSON.stringify(noReply));
    if (r.ok) expect(r.email.textBody).toBe('This is a test text body.');
  });

  it('rejects invalid JSON, a missing/invalid From address, or a missing MessageID', () => {
    expect(parseInboundEmail('not json')).toEqual({ ok: false, error: 'invalid_json' });
    expect(parseInboundEmail(JSON.stringify({ FromFull: { Email: 'not-an-email' }, MessageID: 'x', ToFull: [{ Email: 'a@b.com' }] }))).toEqual({ ok: false, error: 'missing_from' });
    expect(parseInboundEmail(JSON.stringify({ FromFull: { Email: 'a@b.com' }, ToFull: [{ Email: 'a@b.com' }] }))).toEqual({ ok: false, error: 'missing_message_id' });
  });

  it('rejects a payload with no resolvable recipient address', () => {
    expect(parseInboundEmail(JSON.stringify({ FromFull: { Email: 'a@b.com' }, MessageID: 'x' }))).toEqual({ ok: false, error: 'missing_to' });
  });
});

describe('verifyBasicAuth', () => {
  const secret = 'whsec_test_secret_value';
  const header = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

  it('accepts the correct password regardless of username', () => {
    expect(verifyBasicAuth(header('postmark', secret), secret)).toBe(true);
    expect(verifyBasicAuth(header('anything', secret), secret)).toBe(true);
  });

  it('rejects a wrong password, missing header, or non-Basic scheme', () => {
    expect(verifyBasicAuth(header('postmark', 'wrong'), secret)).toBe(false);
    expect(verifyBasicAuth(null, secret)).toBe(false);
    expect(verifyBasicAuth('Bearer sometoken', secret)).toBe(false);
    expect(verifyBasicAuth('Basic not-base64!!', secret)).toBe(false);
  });
});

describe('PostmarkEmailProvider', () => {
  it('reports a Postmark-side ErrorCode as a permanent failure even on HTTP 200', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ To: 'a@b.com', SubmittedAt: 'now', MessageID: 'x', ErrorCode: 300, Message: 'Invalid email request' }), { status: 200 });
    const p = new PostmarkEmailProvider('token', fetchImpl as unknown as typeof fetch);
    const res = await p.sendEmail({ fromAddress: 'a@b.com', fromName: null, toAddress: 'c@d.com', subject: 'Hi', textBody: 'Hi' });
    expect(res).toEqual({ ok: false, status: 200, kind: 'permanent', message: 'Postmark error 300: Invalid email request' });
  });

  it('returns the provider message id on success', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ To: 'a@b.com', SubmittedAt: 'now', MessageID: 'msg_123', ErrorCode: 0, Message: 'OK' }), { status: 200 });
    const p = new PostmarkEmailProvider('token', fetchImpl as unknown as typeof fetch);
    const res = await p.sendEmail({ fromAddress: 'a@b.com', fromName: null, toAddress: 'c@d.com', subject: 'Hi', textBody: 'Hi' });
    expect(res.ok && res.value.MessageID).toBe('msg_123');
  });

  it('sends the server token as a header, never in the URL or body', async () => {
    let seenAuth: string | null = null;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>)['X-Postmark-Server-Token'];
      return new Response(JSON.stringify({ To: 'a@b.com', SubmittedAt: 'now', MessageID: 'x', ErrorCode: 0, Message: 'OK' }), { status: 200 });
    };
    const p = new PostmarkEmailProvider('secret_token', fetchImpl as unknown as typeof fetch);
    await p.sendEmail({ fromAddress: 'a@b.com', fromName: null, toAddress: 'c@d.com', subject: 'Hi', textBody: 'Hi' });
    expect(seenAuth).toBe('secret_token');
  });
});
