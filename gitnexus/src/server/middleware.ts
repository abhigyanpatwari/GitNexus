/**
 * Shared Express route guards (alongside createRouteLimiter in validation.ts).
 */

import type { Request, Response } from 'express';
import proxyaddr from 'proxy-addr';
import { logger } from '../core/logger.js';

/** Port a browser omits from `Origin`, so both sides compare on one value. */
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

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

/**
 * Matches a parsed browser `Origin` against {@link PUBLIC_ORIGIN_ENV}. Carries
 * the hostname the env value resolved to, so startup can log what it parsed.
 */
export type PublicOriginMatcher = ((origin: URL) => boolean) & {
  readonly hostname: string;
};

/**
 * Build a matcher for {@link PUBLIC_ORIGIN_ENV}. Compares hostname always,
 * scheme only when the configured value carried one, and port only when it
 * carried an explicit one.
 *
 * `undefined` when unset or not a single reachable host, mirroring
 * {@link normalizeBoundHost}: an invalid origin must never widen the
 * allow-list, and must not read as a configured one either.
 */
export function createPublicOriginMatcher(rawOrigin?: string): PublicOriginMatcher | undefined {
  const trimmed = rawOrigin?.trim();
  if (!trimmed) return undefined;

  const scheme = /^(https?):\/\//i.exec(trimmed)?.[1].toLowerCase();
  // An `Origin` never carries a path, but a pasted URL often ends in a slash.
  const raw = (scheme ? trimmed.slice(scheme.length + 3) : trimmed).replace(/\/$/, '');
  const authority = splitAuthority(raw);
  if (!authority) return undefined;

  const hostname = normalizeBoundHost(authority.host);
  if (!hostname) return undefined;

  // A bare host stays deliberately permissive on scheme and port: platform
  // service-discovery fields resolve to a hostname with neither.
  const expectedProtocol = scheme ? `${scheme}:` : undefined;
  let expectedPort: string | undefined;
  if (authority.port) {
    try {
      expectedPort = effectivePort(new URL(`${scheme ?? 'http'}://${hostname}:${authority.port}`));
    } catch {
      return undefined;
    }
  }

  const matcher = (origin: URL): boolean =>
    origin.hostname === hostname &&
    (expectedProtocol === undefined || origin.protocol === expectedProtocol) &&
    (expectedPort === undefined || effectivePort(origin) === expectedPort);
  return Object.assign(matcher, { hostname });
}

/**
 * Split `host[:port]` into parts `new URL` can reassemble, or `undefined` when
 * the value is not a single reachable host.
 */
function splitAuthority(authority: string): { host: string; port?: string } | undefined {
  const bracketed = /^(\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/.exec(authority);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] };

  // More than one colon means a bare IPv6 literal, which carries no port.
  if ((authority.match(/:/g)?.length ?? 0) > 1) {
    return /^[0-9A-Fa-f:.]+$/.test(authority) ? { host: `[${authority}]` } : undefined;
  }

  const parts = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!parts) return undefined;
  const host = parts[1];
  // `new URL` is far laxer than DNS: it takes `a.com,b.com` verbatim and reads
  // `8080` as the integer IP 0.0.31.144, either of which yields a matcher that
  // can never match a real Origin while still reading as configured.
  if (/[\s,;*/?#@\\]/.test(host) || /^\d+$/.test(host)) return undefined;
  return { host, port: parts[2] };
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
 * Loopback stays port-agnostic — the dev UI and the server run on different
 * ports — but the bound host is matched on its port too, when one is given.
 *
 * @param boundHost - The hostname/IP the server is listening on (from
 *   `createServer`'s `host` parameter). When `undefined`, `'localhost'`, or a
 *   wildcard (`0.0.0.0`/`::`), only loopback origins are admitted.
 * @param boundPort - The port the server is listening on. Omit to match the
 *   bound host on any port.
 */
export function createLocalhostOriginGuard(boundHost?: string, boundPort?: number) {
  const normalizedBoundHost = normalizeBoundHost(boundHost);
  const normalizedBoundPort = boundPort === undefined ? undefined : String(boundPort);
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
      const parsed = new URL(origin);
      const { hostname, protocol } = parsed;
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error('Unsupported origin protocol');
      }
      const matchesBoundHost =
        hostname === normalizedBoundHost &&
        (normalizedBoundPort === undefined || effectivePort(parsed) === normalizedBoundPort);
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        matchesBoundHost ||
        matchesPublicOrigin?.(parsed)
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

/**
 * Report at startup what {@link createLocalhostOriginGuard} will admit, so an
 * operator can see it without reproducing a 403. A wildcard bind always warns —
 * gating that on {@link PUBLIC_ORIGIN_ENV} being constructible would diagnose a
 * misconfigured value worse than an absent one.
 */
export function logOriginPolicy(boundHost?: string): void {
  const raw = process.env[PUBLIC_ORIGIN_ENV]?.trim();
  const publicOrigin = createPublicOriginMatcher(raw);
  if (publicOrigin) {
    logger.info(
      { [PUBLIC_ORIGIN_ENV]: raw, hostname: publicOrigin.hostname },
      `[gitnexus serve] Browser write routes also accept origins on ${publicOrigin.hostname}.`,
    );
  } else if (raw) {
    logger.warn(
      { [PUBLIC_ORIGIN_ENV]: raw },
      `[gitnexus serve] Ignoring ${PUBLIC_ORIGIN_ENV}=${raw} — not a single reachable origin, ` +
        `so it admits nothing. Set it to one host, optionally with a scheme and a port.`,
    );
  }

  if (!boundHost || normalizeBoundHost(boundHost) !== undefined) return;
  const remedy = publicOrigin
    ? `Writes from ${publicOrigin.hostname} are admitted via ${PUBLIC_ORIGIN_ENV}.`
    : `To admit writes from a specific LAN address, bind --host <that-address> instead of a ` +
      `wildcard; to admit them from a public origin, set ${PUBLIC_ORIGIN_ENV} to it.`;
  logger.warn(
    { host: boundHost },
    `[gitnexus serve] Bound to a wildcard address (${boundHost}); browser write routes ` +
      `accept only loopback origins (localhost/127.0.0.1/[::1]). ${remedy}`,
  );
}

/** Loopback + RFC1918 + link-local: the hops a self-hosted install sees. */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

/** Overrides {@link DEFAULT_TRUST_PROXY}; a public cloud LB needs it set. */
export const TRUST_PROXY_ENV = 'GITNEXUS_TRUST_PROXY';

/** Upper bound on a hop count, well past any real proxy chain. */
export const MAX_TRUST_PROXY_HOPS = 16;

/**
 * Resolve {@link TRUST_PROXY_ENV} to a value Express accepts for `trust proxy`:
 * a boolean (`true`/`false`/`yes`/`no`/`on`/`off`), a hop count in
 * `1..{@link MAX_TRUST_PROXY_HOPS}`, or a proxy list Express can compile.
 * Anything else warns and returns {@link DEFAULT_TRUST_PROXY}. Express compiles
 * this value inside `app.set`, so an unvalidated bad one takes `serve` down at
 * startup — except a number, which it range-checks not at all.
 */
export function resolveTrustProxy(raw?: string): string | number | boolean {
  const value = raw?.trim();
  if (!value) return DEFAULT_TRUST_PROXY;

  if (/^(true|yes|on)$/i.test(value)) {
    logger.warn(
      { [TRUST_PROXY_ENV]: value },
      `[gitnexus serve] ${TRUST_PROXY_ENV}=${value} trusts every hop, so req.ip is read from ` +
        `the client-controlled leftmost X-Forwarded-For entry and a spoofed chain earns a fresh ` +
        `rate-limit key per request. Prefer the number of proxies in front of this server.`,
    );
    return true;
  }
  if (/^(false|no|off)$/i.test(value)) return false;

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (Number.isInteger(hops) && hops >= 1 && hops <= MAX_TRUST_PROXY_HOPS) return hops;
    // A hop count reaches Express as `i < hops`, so an overflowed 1e400 → Infinity
    // would trust the whole chain rather than fail loudly.
    return rejectTrustProxy(value, `expected a hop count of 1..${MAX_TRUST_PROXY_HOPS}`);
  }

  try {
    // Mirror Express 5's compileTrust (`express/lib/utils.js`): it splits on `,`
    // and trims before handing the list to proxy-addr, which rejects unknown
    // subnet names itself. proxy-addr does not split, so pass the array form.
    proxyaddr.compile(value.split(',').map((entry) => entry.trim()));
  } catch (err) {
    return rejectTrustProxy(value, err instanceof Error ? err.message : String(err));
  }
  return value;
}

function rejectTrustProxy(value: string, reason: string): string {
  logger.warn(
    { [TRUST_PROXY_ENV]: value },
    `[gitnexus serve] Ignoring ${TRUST_PROXY_ENV}=${value} (${reason}); falling back to ` +
      `'${DEFAULT_TRUST_PROXY}'.`,
  );
  return DEFAULT_TRUST_PROXY;
}
