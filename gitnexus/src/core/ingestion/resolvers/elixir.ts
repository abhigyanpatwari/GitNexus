/**
 * Elixir module import resolution.
 * Converts Elixir module paths (e.g., MyApp.Accounts.User) to file paths
 * using the standard Elixir convention: CamelCase module segments → snake_case directories.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';

/**
 * Convert a CamelCase Elixir module segment to snake_case.
 * Examples: "MyApp" → "my_app", "HTTPClient" → "http_client", "UserService" → "user_service"
 */
function toSnakeCase(segment: string): string {
  return segment
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Resolve an Elixir module path to matching .ex or .exs file(s).
 *
 * Module paths use dots: MyApp.Accounts.User → lib/my_app/accounts/user.ex
 * Convention: each CamelCase segment becomes a snake_case directory/file.
 *
 * Also handles multi-alias syntax captured as a single string:
 * "MyApp.{User, Admin}" → expands to ["MyApp.User", "MyApp.Admin"]
 */
export function resolveElixirImport(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  const results = resolveElixirImports(importPath, normalizedFileList, allFileList, index);
  return results.length > 0 ? results[0] : null;
}

/**
 * Resolve an Elixir module path to all matching .ex or .exs file paths.
 * For multi-alias syntax (MyApp.{User, Admin}), returns one path per resolved module.
 */
export function resolveElixirImports(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string[] {
  // Handle multi-alias: MyApp.{User, Admin} — resolve all matches
  const multiMatch = importPath.match(/^(.+)\.\{(.+)\}$/);
  if (multiMatch) {
    const prefix = multiMatch[1];
    const names = multiMatch[2].split(',').map(s => s.trim());
    const results: string[] = [];
    for (const name of names) {
      const resolved = resolveElixirSingleImport(`${prefix}.${name}`, normalizedFileList, allFileList, index);
      if (resolved) results.push(resolved);
    }
    return results;
  }

  const resolved = resolveElixirSingleImport(importPath, normalizedFileList, allFileList, index);
  return resolved ? [resolved] : [];
}

function resolveElixirSingleImport(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  // Convert MyApp.Accounts.User → my_app/accounts/user
  const segments = importPath.split('.');
  const snakeParts = segments.map(toSnakeCase);

  return suffixResolve(snakeParts, normalizedFileList, allFileList, index);
}
