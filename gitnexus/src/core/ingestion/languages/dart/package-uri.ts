export const DART_PACKAGE_SCHEME = 'package:';

/**
 * Name from `package:name/library.dart`.
 * A bare `package:name` has no library path, so it is not an import target
 * and it does not create a package-identity dependency.
 */
export function dartPackageImportName(targetRaw: string): string | null {
  if (!targetRaw.startsWith(DART_PACKAGE_SCHEME)) return null;
  const slash = targetRaw.indexOf('/', DART_PACKAGE_SCHEME.length);
  if (slash <= DART_PACKAGE_SCHEME.length) return null;
  return targetRaw.slice(DART_PACKAGE_SCHEME.length, slash);
}
