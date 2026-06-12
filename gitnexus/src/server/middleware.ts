/**
 * Shared Express route guards (alongside createRouteLimiter in validation.ts).
 */

import type { Request, Response } from 'express';
import { isRfc1918PrivateIpv4, isValidIpv4Address } from './private-ip.js';

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

    if (!isValidIpv4Address(hostname)) {
      throw new Error('Unsupported origin hostname');
    }

    if (isRfc1918PrivateIpv4(hostname)) {
      next();
      return;
    }
  } catch {
    /* malformed origin → reject */
  }
  res.status(403).json({ error: 'This endpoint is restricted to localhost origins' });
}
