/**
 * Shared Express route guards (alongside createRouteLimiter in validation.ts).
 */

import type { Request, Response } from 'express';

/**
 * Canonicalize a bound-host string into the form a browser `Origin` hostname
 * takes after WHATWG URL parsing, so the same-host comparison in
 * {@link createLocalhostOriginGuard} can use a plain `===`.
 *
 * Returns `undefined` when the host carries no single comparable identity:
 *   - empty / not provided
 *   - a wildcard bind (`0.0.0.0`, `::`, expanded `0:0:0:0:0:0:0:0`) — the server
 *     listens on every interface and has no one address a browser Origin maps to,
 *     so writes stay loopback-only (we deliberately do NOT trust the whole subnet)
 *   - an unparseable value
 *
 * Otherwise returns `new URL(...).hostname` (lowercased, IPv6 bracketed and
 * compressed) — provably identical to how the request Origin is parsed below.
 * Hand-rolling lowercase + bracketing is insufficient: it fails to compress
 * non-canonical IPv6 forms (e.g. `fe80:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`).
 */
export function normalizeBoundHost(boundHost?: string): string | undefined {
  if (!boundHost) return undefined;
  // Bracket a bare IPv6 literal so `new URL` can parse it as a host.
  const candidate =
    boundHost.includes(':') && !boundHost.startsWith('[') ? `[${boundHost}]` : boundHost;
  let hostname: string;
  try {
    hostname = new URL(`http://${candidate}`).hostname;
  } catch {
    return undefined;
  }
  // Wildcard binds have no single host identity → keep writes loopback-only.
  if (hostname === '' || hostname === '0.0.0.0' || hostname === '[::]') {
    return undefined;
  }
  return hostname;
}

/**
 * Restrict a route to same-host browser origins. Allows:
 *   - loopback (`localhost`, `127.0.0.1`, `[::1]`)
 *   - the server's own bound host (when non-loopback, e.g. a LAN IP)
 *
 * Non-browser requests (no Origin header, e.g. curl / the CLI) pass through.
 * This closes cross-origin reach to write routes without affecting read routes.
 *
 * @param boundHost - The hostname/IP the server is listening on (from
 *   `createServer`'s `host` parameter). When `undefined`, `'localhost'`, or a
 *   wildcard (`0.0.0.0`/`::`), only loopback origins are admitted.
 */
export function createLocalhostOriginGuard(boundHost?: string) {
  const normalizedBoundHost = normalizeBoundHost(boundHost);
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
      // `normalizedBoundHost` is canonicalized to the WHATWG form `hostname`
      // already carries; it is `undefined` for wildcard/no binds (loopback-only).
      // This covers the case where the operator runs `gitnexus serve --host <LAN-IP>`.
      if (normalizedBoundHost && hostname === normalizedBoundHost) {
        next();
        return;
      }
    } catch {
      /* malformed origin → reject */
    }
    res.status(403).json({
      error: 'This endpoint is restricted to same-host origins',
      code: 'origin_not_allowed',
    });
  };
}

/**
 * Default guard that only allows loopback origins. For use in tests or when
 * the bound host is not available.
 */
export const requireLocalhostOrigin = createLocalhostOriginGuard();
