/**
 * Shared service-path normalization for group tools (`service` monorepo filter).
 * Segments are compared case-sensitively (typical POSIX-style repo paths).
 */

export function normalizeServicePrefix(service: unknown): string | undefined {
  if (service === undefined || service === null) return undefined;
  const s = String(service).trim().replace(/\/+$/, '');
  return s.length > 0 ? s : undefined;
}

export function fileMatchesServicePrefix(
  filePath: string | undefined,
  prefix: string | undefined,
): boolean {
  if (!prefix) return true;
  if (!filePath) return false;
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}
