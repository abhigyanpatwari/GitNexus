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
    const parsed = new URL(origin);
    const hostname = parsed.hostname;
    const protocol = parsed.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('Unsupported origin protocol');
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      next();
      return;
    }

    const octets = hostname.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      throw new Error('Unsupported origin hostname');
    }

    const [a, b] = octets;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      next();
      return;
    }
  } catch {
    /* malformed origin → reject */
  }
  res.status(403).json({ error: 'This endpoint is restricted to localhost origins' });
}
