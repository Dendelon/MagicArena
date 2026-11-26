export type OriginRejectionReason =
  | 'missing_origin'
  | 'malformed_origin'
  | 'disallowed_origin';

export type OriginCheckResult =
  | { readonly allowed: true; readonly origin: string | null }
  | {
      readonly allowed: false;
      readonly reason: OriginRejectionReason;
      readonly origin: string | null;
    };

const MAX_LOGGED_ORIGIN_LENGTH = 160;

/**
 * Normalizes a single Origin value (`http:` or `https:` with no path, query, fragment, or userinfo).
 * Returns `null` when malformed or wildcarded.
 */
export const normalizeAllowedOrigin = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === '*') {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    trimmed.endsWith('/')
  ) {
    return null;
  }

  return parsed.origin;
};

const sanitizeOriginForLog = (raw: string): string =>
  raw.trim().slice(0, MAX_LOGGED_ORIGIN_LENGTH);

/**
 * Evaluates a WebSocket upgrade `Origin` header against an exact-match allowlist.
 */
export const validateWebSocketOrigin = (
  originHeader: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  allowMissingOrigin: boolean,
): OriginCheckResult => {
  if (originHeader === undefined) {
    if (allowMissingOrigin) {
      return { allowed: true, origin: null };
    }
    return { allowed: false, reason: 'missing_origin', origin: null };
  }

  const trimmed = originHeader.trim();
  if (trimmed.length === 0) {
    if (allowMissingOrigin) {
      return { allowed: true, origin: null };
    }
    return { allowed: false, reason: 'missing_origin', origin: null };
  }

  const normalized = normalizeAllowedOrigin(trimmed);
  if (normalized === null) {
    return {
      allowed: false,
      reason: 'malformed_origin',
      origin: sanitizeOriginForLog(trimmed),
    };
  }

  if (!allowedOrigins.has(normalized)) {
    return {
      allowed: false,
      reason: 'disallowed_origin',
      origin: normalized,
    };
  }

  return { allowed: true, origin: normalized };
};

