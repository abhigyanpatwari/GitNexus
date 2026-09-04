import { isIP } from 'net';

// Cloud metadata hostnames that must never be reachable via user-supplied URLs
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.internal',
]);

/**
 * Validate an outbound http(s) URL to prevent SSRF.
 * Only allows https:// and http:// schemes. Blocks private/internal addresses,
 * IPv6 private ranges, cloud metadata hostnames, and numeric IP encodings.
 */
export function validateGitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Only https:// and http:// git URLs are allowed');
  }

  if (parsed.search || parsed.hash) {
    throw new Error('Git URLs must not include query strings or fragments');
  }

  const host = parsed.hostname.toLowerCase();

  // Block known dangerous hostnames (cloud metadata services)
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Strip IPv6 brackets if present (URL parser behavior varies across Node versions)
  let normalizedHost = host;
  if (host.startsWith('[') && host.endsWith(']')) {
    normalizedHost = host.slice(1, -1);
  }

  // Check if this is an IPv6 address
  // Use manual colon detection as fallback since isIP may return 0 for some
  // normalized IPv6 forms (e.g. ::ffff:7f00:1)
  const isIPv6 = isIP(normalizedHost) === 6 || normalizedHost.includes(':');
  if (isIPv6) {
    assertNotPrivateIPv6(normalizedHost);
    return;
  }

  // Check if this is an IPv4 address (including numeric encodings)
  if (isIP(normalizedHost) === 4) {
    assertNotPrivateIPv4(normalizedHost);
    return;
  }

  // For non-IP hostnames, check for numeric IP tricks
  // Decimal encoding: 2130706433 = 127.0.0.1
  // Hex encoding: 0x7f000001 = 127.0.0.1
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Standard IPv4 regex checks for dotted notation
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    host === '0.0.0.0' ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^198\.1[89]\./.test(host)
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

function assertNotPrivateIPv6(ip: string): void {
  // Expand common compressed forms for comparison
  const lower = ip.toLowerCase();

  // IPv6 loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Unspecified address
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 Unique Local Address (fc00::/7 = fc and fd prefixes)
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 link-local (fe80::/10)
  if (
    lower.startsWith('fe80') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:hex:hex)
  // Node may normalize ::ffff:127.0.0.1 to ::ffff:7f00:1
  if (lower.startsWith('::ffff:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Expanded IPv4-mapped form only (0:0:0:0:0:ffff:…). A public address that
  // merely contains a `ffff` hextet is not mapped.
  if (lower.startsWith('0:0:0:0:0:ffff:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv4-compatible IPv6 (RFC 4291 § 2.5.5.1, deprecated form: ::w.x.y.z).
  // Node's URL parser collapses http://[::127.0.0.1]/ to "::7f00:1" — the IPv4
  // is hidden in the last 32 bits without the ::ffff: marker, so the check
  // above misses it. The form is still routable to the embedded IPv4 on most
  // network stacks, so any address compressed to ::xxxx[:yyyy] must be blocked.
  if (/^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(lower)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // NAT64 well-known prefix (RFC 6052 § 2.1: 64:ff9b::/96, plus the local
  // 64:ff9b:1::/48 from RFC 8215). Maps any IPv4 address — including private
  // ranges — into IPv6, so a host with NAT64 can reach the embedded IPv4 via
  // e.g. 64:ff9b::7f00:1 → 127.0.0.1.
  // The check intentionally covers the full 64:ff9b::/32 block (broader than
  // the two cited ranges): IANA reserves it for IPv4-IPv6 translation, so
  // blocking the whole prefix is defensively sound and prevents a narrower
  // CIDR check from quietly re-opening the bypass for 64:ff9b:1::/48 or any
  // future translation assignment.
  if (lower.startsWith('64:ff9b:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // 6to4 (RFC 3056, 2002::/16). Encodes an IPv4 address in bits 17-48, so
  // 2002:7f00:0001::1 routes to 127.0.0.1 on 6to4-capable stacks. The
  // protocol was deprecated by RFC 7526 and the public relay anycast
  // (192.88.99.1) has been retired, so broad-blocking the prefix has near-
  // zero false-positive cost while closing the IPv4-embedded bypass.
  // Teredo (2001::/32) embeds IPv4 obfuscated by XOR; precise blocking is
  // impractical and is out of scope here.
  if (lower.startsWith('2002:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

function assertNotPrivateIPv4(ip: string): void {
  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  if (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}
