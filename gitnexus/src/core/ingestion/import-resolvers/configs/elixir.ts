/**
 * Elixir import resolution config.
 *
 * Elixir modules are identified by atoms (capitalized names, e.g. MyApp.User).
 * By convention, `MyApp.User` maps to `lib/my_app/user.ex` (or `.exs`).
 * Each dotted segment is snake_cased independently.
 *
 * Handles: import, alias, use, require directives.
 * External/hex dependencies (no slash in module path context) return empty.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';

/**
 * Convert a PascalCase module name segment to snake_case.
 * HTTPClient → http_client, MyApp → my_app, XmlParser → xml_parser
 */
function toSnakeCase(segment: string): string {
  return segment
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Convert a dotted Elixir module alias to a relative file path.
 * MyApp.User → my_app/user
 * Elixir.MyApp.User → elixir/my_app/user (Erlang-namespaced modules)
 */
function moduleToRelPath(moduleName: string): string {
  return moduleName
    .split('.')
    .map(toSnakeCase)
    .join('/');
}

const ELIXIR_EXTS = ['.ex', '.exs'];

/** Elixir module alias → file path strategy. */
const elixirModuleStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const moduleName = rawImportPath.trim();

  // Must start with a capital letter (Elixir module alias convention)
  if (!moduleName || !/^[A-Z]/.test(moduleName)) return null;

  const relPath = moduleToRelPath(moduleName);

  // Try common Elixir project roots: lib/, test/, apps/*/lib/, apps/*/test/
  const prefixes = ['lib/', 'test/', ''];
  const files: string[] = [];

  for (const prefix of prefixes) {
    for (const ext of ELIXIR_EXTS) {
      const candidate = `${prefix}${relPath}${ext}`;
      for (const fp of ctx.allFileList) {
        if (fp === candidate || fp.endsWith(`/${candidate}`)) {
          files.push(fp);
          break;
        }
      }
      if (files.length > 0) return { kind: 'files', files };
    }
  }

  // No local file found — likely an external hex dependency
  return { kind: 'files', files: [] };
};

export const elixirImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Elixir,
  strategies: [elixirModuleStrategy],
};
