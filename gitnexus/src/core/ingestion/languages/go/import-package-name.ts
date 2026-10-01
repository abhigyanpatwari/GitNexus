/** Conventional package qualifier; semantic-version suffixes name modules, not packages. */
export function goImportPackageName(importPath: string): string {
  const segments = importPath.split('/').filter(Boolean);
  const leaf = segments.at(-1) ?? importPath;
  const name = /^v\d+$/.test(leaf) && segments.length > 1 ? segments[segments.length - 2] : leaf;
  return name.replace(/\.v\d+$/, '');
}
