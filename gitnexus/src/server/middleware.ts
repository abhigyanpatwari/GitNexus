/**
 * Shared Express route guards (alongside createRouteLimiter in validation.ts).
 */

import type { Request, Response } from 'express';

/**
 * Restrict a route to localhost browser origins. Non-browser requests (no
 * Origin header, e.g. curl / the CLI) pass through. This closes cross-origin
 * reach (the allow-listed public deploy + Private Network Access) to write
 * routes without affecting read routes.
 */
export function requireLocalhostOrigin(req: Request, res: Response, next: () => void): void {
  const origin = req.headers.origin;
  if (origin === undefined) {
    next();
    return;
  }
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      next();
      return;
    }
  } catch {
    /* malformed origin → reject */
  }
  res.status(403).json({ error: 'This endpoint is restricted to localhost origins' });
}
