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
