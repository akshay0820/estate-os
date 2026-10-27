// One error shape for every backend call: { code, message, details }.
// Database functions raise with DETAIL = stable code (see private.fail in the migrations).

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_REFERENCE'
  | 'INVALID_TRANSITION'
  | 'APPOINTMENT_CONFLICT'
  | 'OUTSIDE_BUSINESS_HOURS'
  | 'PROPERTY_UNAVAILABLE'
  | 'LAST_OWNER'
  | 'INVALID_INVITATION'
  | 'RATE_LIMITED'
  | 'UNAUTHENTICATED'
  | 'NETWORK'
  | 'UNKNOWN';

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const KNOWN = new Set<string>([
  'VALIDATION_ERROR', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INVALID_REFERENCE', 'INVALID_TRANSITION', 'APPOINTMENT_CONFLICT',
  'OUTSIDE_BUSINESS_HOURS', 'PROPERTY_UNAVAILABLE', 'LAST_OWNER', 'INVALID_INVITATION', 'RATE_LIMITED', 'UNAUTHENTICATED',
]);

interface PgLike {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
  status?: number;
}

/** Converts PostgREST / Auth / network errors into ApiError without leaking internals. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const e = (err ?? {}) as PgLike;
  if (e.details && KNOWN.has(e.details)) {
    let details: Record<string, unknown> = {};
    try {
      details = e.hint ? (JSON.parse(e.hint) as Record<string, unknown>) : {};
    } catch {
      /* hint is not JSON */
    }
    return new ApiError(e.details as ErrorCode, e.message ?? 'Request failed', details);
  }
  switch (e.code) {
    case '42501':
      return new ApiError('FORBIDDEN', 'You don’t have permission to do that.');
    case '23505':
      return new ApiError('CONFLICT', 'That record already exists.');
    case '23514':
    case '23502':
    case '22P02':
    case '22001':
      return new ApiError('VALIDATION_ERROR', 'Some fields are invalid. Check the form and try again.');
    case '23503':
      return new ApiError('INVALID_REFERENCE', 'A linked record no longer exists.');
    case 'PGRST116':
      return new ApiError('NOT_FOUND', 'Record not found.');
    case 'PGRST301':
    case 'PGRST303':
      return new ApiError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  }
  if (e.status === 401) return new ApiError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  if (err instanceof TypeError && /fetch/i.test(err.message)) return new ApiError('NETWORK', 'Can’t reach the server. Check your connection and retry.');
  if (import.meta.env.DEV) console.error('[api] unmapped error', err);
  return new ApiError('UNKNOWN', 'Something went wrong. Please try again.');
}

/** Unwraps a supabase-js `{ data, error }` result; a missing body is treated as not found. */
export function check<T>(res: { data: T; error: unknown }): NonNullable<T> {
  if (res.error) throw toApiError(res.error);
  if (res.data == null) throw new ApiError('NOT_FOUND', 'Record not found.');
  return res.data as NonNullable<T>;
}

/** For `.maybeSingle()` and void RPCs, where an empty body is a valid answer. */
export function checkMaybe<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw toApiError(res.error);
  return res.data;
}

export function errorMessage(err: unknown): string {
  return toApiError(err).message;
}
