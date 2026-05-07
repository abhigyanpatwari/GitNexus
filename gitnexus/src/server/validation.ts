/**
 * Server-side input validation helpers.
 *
 * Convention: helpers throw BadRequestError (or its 403 subclass ForbiddenError)
 * when user input fails validation. Existing route handlers wrap their bodies in
 * try/catch and translate the error to res.status(err.status).json({error: err.message}).
 * This pattern was chosen over an asyncHandler middleware to stay compatible with
 * Express 4's non-propagation of async-thrown errors and to match the existing
 * try/catch shape used throughout api.ts.
 *
 * Scope (this PR — U1 of the security remediation plan):
 *   - assertString:      closes js/type-confusion-through-parameter-tampering (api.ts:1118)
 *   - assertSafePath:    consolidates the path-traversal guard from api.ts:1067-1077
 *                        for reuse across other path-injection findings (U2/U3)
 *   - escapeRegExp:      utility for upcoming regex-injection fix at /api/grep (U5)
 *
 * Helpers added in later units (U3 git-clone hardening, U4 rate-limiting) live
 * in this module too but are introduced with the dependency they require.
 */

import path from 'node:path';
import rateLimit, { type RateLimitRequestHandler, ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Thrown by validation helpers when user input is rejected.
 * Routes catch via existing try/catch and convert with err.status / err.message.
 */
export class BadRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BadRequestError';
    this.status = status;
  }
}

export class ForbiddenError extends BadRequestError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

/**
 * Type guard for HTTP request parameters that must be a single string.
 *
 * Express's req.query and req.body parsers return `string | string[] | ParsedQs`
 * for any field, but route handlers commonly cast to `string` and operate on
 * `.length`. When the caller passes the same key twice (?x=a&x=b) the value
 * arrives as an array, and a `.length` check intended for the string ends up
 * counting array elements — bypassing length-based guards (CodeQL
 * js/type-confusion-through-parameter-tampering, alert at api.ts:1118).
 *
 * @throws BadRequestError when value is not a string (array, object, undefined, etc.)
 */
export function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) {
      throw new BadRequestError(`Parameter "${fieldName}" must be a single string, got an array`);
    }
    throw new BadRequestError(`Parameter "${fieldName}" must be a string`);
  }
  return value;
}

/**
 * Resolve a user-supplied relative path against an allowed root and verify it
 * stays inside that root. Mirrors the existing guard at api.ts:1067-1077.
 *
 * Returns the absolute resolved path. Rejects empty paths, null bytes, and
 * paths that resolve outside the root (e.g., `../../../etc/passwd`).
 *
 * @throws BadRequestError when the path is empty or contains a null byte
 * @throws ForbiddenError when the resolved path escapes the root
 */
export function assertSafePath(rawPath: string, root: string): string {
  if (rawPath.length === 0) {
    throw new BadRequestError('Path must not be empty');
  }
  if (rawPath.includes('\0')) {
    throw new BadRequestError('Path must not contain null bytes');
  }
  const resolvedRoot = path.resolve(root);
  const fullPath = path.resolve(resolvedRoot, rawPath);
  if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + path.sep)) {
    throw new ForbiddenError('Path traversal denied');
  }
  return fullPath;
}

/**
 * Escape regex metacharacters in a user-supplied string so it can be safely
 * embedded as a literal in `new RegExp(...)`. Used by /api/grep's literal mode
 * and any future endpoint that constructs a regex from caller input.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Default rate-limit policy for FS-touching API routes (CodeQL
 * js/missing-rate-limiting). Tuned for the local-bound HTTP server's expected
 * traffic — interactive web UI use stays well under the limit; abusive loops
 * trip 429.
 *
 * Module-internal — not exported. Tests assert the observable behavior
 * (61st request returns 429), not the literal value, so callers don't grow
 * a coupling on this number.
 */
const DEFAULT_RATE_LIMIT_RPM = 60;

/**
 * Project-specific subset of express-rate-limit options that callers may
 * override. Intentionally narrow — `Partial<RateLimitOptions>` would let a
 * caller pass `{ skip: () => true }` and silently disable limiting on a
 * route. The two knobs below are sufficient for tests and any future
 * legitimate per-route tuning.
 */
export interface RouteLimiterOverrides {
  windowMs?: number;
  /** Canonical name in express-rate-limit v8+. `max` is the deprecated alias. */
  limit?: number;
}

/**
 * Build a per-route rate-limit middleware with project-uniform defaults.
 *
 * Each call returns a NEW limiter instance — independent counters per route,
 * so /api/file traffic doesn't push /api/grep into 429.
 *
 * Defaults:
 *   - 60 requests per IP per minute
 *   - draft-7 RateLimit-* response headers (no legacy X-RateLimit-* headers)
 *   - 429 with a JSON body matching the project's `{ error: '...' }` shape
 *   - passOnStoreError: store failures let the request through rather than
 *     producing an HTML 500 from Express's default error handler
 *   - keyGenerator: req.ip with a socket.remoteAddress fallback so abruptly
 *     closed connections do not trigger ERR_ERL_UNDEFINED_IP_ADDRESS
 *     (which would 500 the request via Express's default error handler).
 *     The IP is passed through `ipKeyGenerator` so IPv6 addresses are
 *     normalised to their /56 subnet — without this, each IPv6 address
 *     gets its own counter and the limit is trivially bypassed (#1360).
 *     Caller must wire `app.set('trust proxy', ...)` correctly — see
 *     createServer in api.ts.
 *
 * Tests pass `{ windowMs: 100, limit: 3 }` to keep limiter tests fast and
 * deterministic.
 */
export function createRouteLimiter(opts?: RouteLimiterOverrides): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: DEFAULT_RATE_LIMIT_RPM,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: (req: Request) => {
      const ip = req.ip ?? req.socket?.remoteAddress;
      return ip ? ipKeyGenerator(ip) : 'unknown';
    },
    message: { error: 'Too many requests, please try again later.' },
    ...opts,
  });
}
