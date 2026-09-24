/**
 * Shared Express route guards (alongside createRouteLimiter in validation.ts),
 * plus the `serve` configuration surface they read: GITNEXUS_PUBLIC_ORIGIN and
 * GITNEXUS_TRUST_PROXY.
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
 * The three loopback spellings a browser can send, and that
 * {@link normalizeBoundHost} can return.
 *
 * Takes a hostname already through WHATWG URL parsing, so IPv6 arrives
 * bracketed — unlike `isLoopbackHost` in `mcp/http-transport.ts`, which compares
 * a raw `--host` value and so matches bare `::1`.
 */
function isLoopbackHostname(hostname: string | undefined): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Canonicalize a configured host — `--host`, or the one inside
 * {@link PUBLIC_ORIGIN_ENV} — into the form a browser `Origin` hostname takes
 * after WHATWG URL parsing, so the comparisons in
 * {@link createWriteOriginGuard} can use a plain `===`.
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
export interface PublicOriginMatcher {
  readonly hostname: string;
  matches(origin: URL): boolean;
}

/**
 * Build a matcher for {@link PUBLIC_ORIGIN_ENV}. Compares hostname and scheme
 * always — a value with no scheme is read as `https`, never as either — and
 * port only when the configured value carried an explicit one.
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

  // A bare host stays permissive on the port, since platform service-discovery
  // fields resolve to a hostname with neither — but it defaults to https rather
  // than to any scheme, because those platforms always terminate TLS, and
  // accepting either would make `app.example.com` an http downgrade path into
  // both the CORS read allowlist and the write guard. Plain http needs the
  // explicit `http://` form.
  const expectedProtocol = `${scheme ?? 'https'}:`;
  let expectedPort: string | undefined;
  if (authority.port) {
    let configured: URL;
    try {
      // Round-trip through `new URL` so the configured port normalizes the same
      // way a request Origin's does — an elided default, a leading zero — and so
      // an out-of-range port throws here rather than yielding a dead matcher.
      configured = new URL(`${expectedProtocol}//${hostname}:${authority.port}`);
    } catch {
      return undefined;
    }
    // Port 0 survives that round-trip (so does `:00`) but no browser ever sends
    // it, so keeping it would build exactly the dead-but-configured matcher this
    // function exists to reject. `:0080` is unaffected — it normalizes to the
    // elided default, not to 0.
    if (configured.port === '0') return undefined;
    expectedPort = effectivePort(configured);
  }

  return {
    hostname,
    matches: (origin: URL): boolean =>
      origin.hostname === hostname &&
      origin.protocol === expectedProtocol &&
      (expectedPort === undefined || effectivePort(origin) === expectedPort),
  };
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
  // can never match a real Origin while still reading as configured. A trailing
  // dot is the same failure — it is a legal FQDN that survives parsing as
  // `example.com.`, but a browser sends `example.com`, so the matcher is dead.
  if (/[\s,;*/?#@\\]/.test(host) || /^\d+$/.test(host) || host.endsWith('.')) return undefined;
  return { host, port: parts[2] };
}

/**
 * Restrict a route to the browser origins this server trusts. Allows:
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
 * @param boundPort - The port the server actually listens on. Omit it — and
 *   match the bound host on any port — when that is not known, as it is not
 *   for an ephemeral `--port 0` bind.
 */
export function createWriteOriginGuard(boundHost?: string, boundPort?: number) {
  const normalizedBoundHost = normalizeBoundHost(boundHost);
  const normalizedBoundPort = boundPort === undefined ? undefined : String(boundPort);
  // Snapshotted at construction like normalizedBoundHost, so a later env
  // mutation cannot widen a running server's write surface.
  const publicOrigin = createPublicOriginMatcher(process.env[PUBLIC_ORIGIN_ENV]);
  return function requireTrustedOrigin(req: Request, res: Response, next: () => void): void {
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
      if (isLoopbackHostname(hostname) || matchesBoundHost || publicOrigin?.matches(parsed)) {
        next();
        return;
      }
    } catch {
      /* malformed origin → reject */
    }
    res.status(403).json({
      error: 'This endpoint is restricted to trusted browser origins',
      code: 'origin_not_allowed',
    });
  };
}

/**
 * Whether `serve` has any request authentication configured.
 *
 * Nothing can configure it yet: `serve` has no authentication of any kind, and
 * {@link createWriteOriginGuard} passes every request that carries no `Origin`
 * header, so `curl` reaches `POST /api/analyze` and `DELETE /api/repo`
 * unauthenticated. That has been safe only because `serve` bound loopback.
 *
 * So this returns `false` unconditionally, and it is a placeholder on purpose:
 * the `serve` auth change replaces this body, and {@link assertServeAuthForPublicOrigin}
 * and its tests then hold without being rewritten.
 */
export function isServeAuthConfigured(): boolean {
  return false;
}

/**
 * Refuse to start when {@link PUBLIC_ORIGIN_ENV} is set and no `serve`
 * authentication is configured.
 *
 * {@link PUBLIC_ORIGIN_ENV} is the setting that makes a public bind usable — it
 * is what admits a non-loopback browser origin to the write routes. Until
 * {@link isServeAuthConfigured} can return `true`, setting it opens the door
 * with nothing behind it, so the door does not open at all. There is
 * deliberately no override flag: an escape hatch is the thing an operator sets
 * once and forgets, which is exactly the state this guards against.
 *
 * @throws when {@link PUBLIC_ORIGIN_ENV} is set without authentication. `serve`
 *   surfaces it as `serve.startFailed` and exits non-zero.
 */
export function assertServeAuthForPublicOrigin(): void {
  const raw = process.env[PUBLIC_ORIGIN_ENV]?.trim();
  if (!raw || isServeAuthConfigured()) return;
  throw new Error(
    `${PUBLIC_ORIGIN_ENV} is set (${raw}), but 'gitnexus serve' has no authentication yet. ` +
      `It would admit browser writes from that origin, and requests without an Origin header ` +
      `(curl, any script) already reach POST /api/analyze and DELETE /api/repo unauthenticated — ` +
      `so a reachable deployment would let anyone index and delete repositories. Unset ` +
      `${PUBLIC_ORIGIN_ENV} and bind loopback (the default), or reach the server through a proxy ` +
      `that authenticates for it.`,
  );
}

/**
 * Report at startup what {@link createWriteOriginGuard} will admit, so an
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
  const admitted = publicOrigin
    ? `accept loopback origins (localhost/127.0.0.1/[::1]) and ${publicOrigin.hostname} via ` +
      `${PUBLIC_ORIGIN_ENV}.`
    : `accept only loopback origins (localhost/127.0.0.1/[::1]). To admit writes from a specific ` +
      `LAN address, bind --host <that-address> instead of a wildcard; to admit them from a ` +
      `public origin, set ${PUBLIC_ORIGIN_ENV} to it.`;
  logger.warn(
    { host: boundHost },
    `[gitnexus serve] Bound to a wildcard address (${boundHost}); browser write routes ${admitted}`,
  );
}

/** Loopback + RFC1918 + link-local: the hops a self-hosted install sees. */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

/** Overrides {@link DEFAULT_TRUST_PROXY}; a public cloud LB needs it set. */
export const TRUST_PROXY_ENV = 'GITNEXUS_TRUST_PROXY';

/**
 * Sanity ceiling on a hop count, well past any real proxy chain — it exists to
 * catch a digit string long enough to overflow to `Infinity`, not to make any
 * value under it safe. The correct hop count is the exact number of proxies you
 * control; each extra hop hands the caller one more entry of the chain.
 */
export const MAX_TRUST_PROXY_HOPS = 16;

/**
 * Resolve {@link TRUST_PROXY_ENV} to a value Express accepts for `trust proxy`:
 * `false` (`false`/`no`/`off`, and a `0` hop count), a hop count in
 * `1..{@link MAX_TRUST_PROXY_HOPS}`, or a proxy list Express can compile.
 * Anything else warns and returns {@link DEFAULT_TRUST_PROXY}. Express compiles
 * this value inside `app.set`, so an unvalidated bad one takes `serve` down at
 * startup; a number it accepts without any range check at all.
 *
 * `true` is rejected, not accepted-with-a-warning. It makes `req.ip` the
 * client-controlled leftmost `X-Forwarded-For` entry, so a spoofed chain earns a
 * fresh rate-limit key per request — and the limiter is the only thing in front
 * of `/api/analyze` and `/api/embed`, both of which spawn workers. It is also
 * not a working configuration: express-rate-limit's own `validations.trustProxy`
 * throws `ERR_ERL_PERMISSIVE_TRUST_PROXY` on it. Any real chain has a knowable
 * length, so a hop count or a proxy list covers every legitimate case.
 */
export function resolveTrustProxy(raw?: string): string | number | boolean {
  const value = raw?.trim();
  if (!value) return DEFAULT_TRUST_PROXY;

  if (/^(true|yes|on)$/i.test(value)) {
    return rejectTrustProxy(
      value,
      `it trusts every hop, so req.ip is read from the client-controlled leftmost ` +
        `X-Forwarded-For entry and a spoofed chain earns a fresh rate-limit key per request; ` +
        `express-rate-limit rejects it too. Set the number of proxies you control instead`,
    );
  }
  if (/^(false|no|off)$/i.test(value)) return false;

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    // Express tests a hop count as `i < hops`, so 0 trusts nothing, exactly as
    // `false` does. Rejecting it would fall back to a default that trusts more
    // than was asked for.
    if (hops === 0) return false;
    // The same test means a digit string long enough to overflow to Infinity
    // trusts the whole chain rather than failing loudly.
    if (Number.isInteger(hops) && hops <= MAX_TRUST_PROXY_HOPS) return hops;
    return rejectTrustProxy(value, `expected a hop count of 0..${MAX_TRUST_PROXY_HOPS}`);
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

/**
 * Warn when the rate limiter is about to key every request to the same address.
 *
 * {@link resolveTrustProxy} cannot detect this — it sees the env value and not
 * what the server bound. A non-loopback bind is the shape of a deployment behind
 * a load balancer, and {@link DEFAULT_TRUST_PROXY} matches only loopback and the
 * private ranges, so a cloud LB outside them is never trusted: `req.ip` is the
 * LB on every request and the per-IP limit silently becomes one global limit.
 *
 * Silent when {@link TRUST_PROXY_ENV} is set — including to a value that then
 * fails validation, which {@link resolveTrustProxy} has already warned about.
 *
 * @param boundHost - `createServer`'s `host`. A wildcard bind warns too: it
 *   accepts traffic on every interface, a load balancer included.
 */
export function warnIfRateLimitKeysCollapse(boundHost?: string): void {
  if (process.env[TRUST_PROXY_ENV]?.trim()) return;
  if (!boundHost) return;
  // normalizeBoundHost returns undefined for a wildcard or unparseable host,
  // neither of which is loopback — so both warn.
  if (isLoopbackHostname(normalizeBoundHost(boundHost))) return;
  logger.warn(
    { host: boundHost, trustProxy: DEFAULT_TRUST_PROXY },
    `[gitnexus serve] Bound to ${boundHost} with ${TRUST_PROXY_ENV} unset, so 'trust proxy' is ` +
      `'${DEFAULT_TRUST_PROXY}'. A load balancer outside those ranges is not trusted, so req.ip ` +
      `is the balancer on every request and the per-IP rate limit becomes one shared limit across ` +
      `all callers. Set ${TRUST_PROXY_ENV} to the number of proxies you control.`,
  );
}

function rejectTrustProxy(value: string, reason: string): string {
  logger.warn(
    { [TRUST_PROXY_ENV]: value },
    `[gitnexus serve] Ignoring ${TRUST_PROXY_ENV}=${value} (${reason}); falling back to ` +
      `'${DEFAULT_TRUST_PROXY}'.`,
  );
  return DEFAULT_TRUST_PROXY;
}
