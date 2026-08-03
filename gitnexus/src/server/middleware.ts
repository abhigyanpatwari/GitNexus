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
 * Browser origin a hosted deployment is reached through. A wildcard bind makes
 * {@link normalizeBoundHost} undefined, so writes would stay loopback-only.
 */
export const PUBLIC_ORIGIN_ENV = 'GITNEXUS_PUBLIC_ORIGIN';

/** Matches a parsed browser `Origin` against {@link PUBLIC_ORIGIN_ENV}. */
export type PublicOriginMatcher = (protocol: string, hostname: string) => boolean;

/**
 * Build a matcher for {@link PUBLIC_ORIGIN_ENV}. Accepts a bare host, because
 * platform service-discovery fields resolve to a hostname with no scheme; a
 * supplied scheme is then enforced, so `https://app.example.com` does not also
 * admit plaintext `http://`.
 *
 * `undefined` when unset or unparseable, mirroring {@link normalizeBoundHost}:
 * an invalid origin must never widen the allow-list.
 */
export function createPublicOriginMatcher(rawOrigin?: string): PublicOriginMatcher | undefined {
  const trimmed = rawOrigin?.trim();
  if (!trimmed) return undefined;

  let expectedProtocol: string | undefined;
  let host = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      expectedProtocol = parsed.protocol;
      host = parsed.host;
    } catch {
      return undefined;
    }
  }

  const expectedHostname = normalizeBoundHost(stripPort(host));
  if (!expectedHostname) return undefined;
  return (protocol, hostname) =>
    hostname === expectedHostname &&
    (expectedProtocol === undefined || protocol === expectedProtocol);
}

// normalizeBoundHost brackets any unbracketed colon as IPv6, which would mangle
// `host:port`. More than one colon means a bare IPv6 literal, which has no port.
function stripPort(host: string): string {
  if (host.startsWith('[')) return host.replace(/](:\d+)$/, ']');
  if ((host.match(/:/g)?.length ?? 0) > 1) return host;
  return host.replace(/:\d+$/, '');
}

/**
 * Restrict a route to same-host browser origins. Allows:
 *   - loopback (`localhost`, `127.0.0.1`, `[::1]`)
 *   - the server's own bound host (when non-loopback, e.g. a LAN IP)
 *   - the configured public origin ({@link PUBLIC_ORIGIN_ENV}), if any
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
  // Snapshotted at construction like normalizedBoundHost, so a later env
  // mutation cannot widen a running server's write surface.
  const matchesPublicOrigin = createPublicOriginMatcher(process.env[PUBLIC_ORIGIN_ENV]);
  return function requireLocalhostOrigin(req: Request, res: Response, next: () => void): void {
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    try {
      const { hostname, protocol } = new URL(origin);
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error('Unsupported origin protocol');
      }
      // `normalizedBoundHost` is canonicalized to the WHATWG form `hostname`
      // already carries, and is undefined for wildcard/no binds. It covers the
      // operator running `gitnexus serve --host <LAN-IP>`.
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname === normalizedBoundHost ||
        matchesPublicOrigin?.(protocol, hostname)
      ) {
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

/** Loopback + RFC1918 + link-local: the hops a self-hosted install sees. */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

/** Overrides {@link DEFAULT_TRUST_PROXY}; a public cloud LB needs it set. */
export const TRUST_PROXY_ENV = 'GITNEXUS_TRUST_PROXY';

/**
 * Coerce {@link TRUST_PROXY_ENV} into a value Express accepts for `trust proxy`.
 * Prefer a hop count (`1`) over `true` behind a load balancer: `true` takes the
 * client-controlled leftmost `X-Forwarded-For` entry, so a spoofed chain would
 * hand the rate limiter a fresh IP per request.
 */
export function resolveTrustProxy(raw?: string): string | number | boolean {
  const value = raw?.trim();
  if (!value) return DEFAULT_TRUST_PROXY;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return value;
}
