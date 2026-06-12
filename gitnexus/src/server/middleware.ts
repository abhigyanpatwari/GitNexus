/**
 * Shared Express route guards (alongside createRouteLimiter in validation.ts).
 */

import type { Request, Response } from 'express';

/**
 * Restrict a route to same-host browser origins. Allows:
 *   - loopback (`localhost`, `127.0.0.1`, `[::1]`)
 *   - the server's own bound host (when non-loopback, e.g. a LAN IP)
 *
 * Non-browser requests (no Origin header, e.g. curl / the CLI) pass through.
 * This closes cross-origin reach to write routes without affecting read routes.
 *
 * @param boundHost - The hostname/IP the server is listening on (from
 *   `createServer`'s `host` parameter). When `undefined` or `'localhost'`, only
 *   loopback origins are admitted.
 */
export function createLocalhostOriginGuard(boundHost?: string) {
  return function requireLocalhostOrigin(req: Request, res: Response, next: () => void): void {
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
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
        next();
        return;
      }
      // Allow origin matching the server's own bound host (same-host check).
      // This covers the case where the operator runs `gitnexus serve --host <LAN-IP>`.
      if (boundHost && hostname === boundHost) {
        next();
        return;
      }
    } catch {
      /* malformed origin → reject */
    }
    res.status(403).json({ error: 'This endpoint is restricted to same-host origins' });
  };
}

/**
 * Default guard that only allows loopback origins. For use in tests or when
 * the bound host is not available.
 */
export const requireLocalhostOrigin = createLocalhostOriginGuard();
