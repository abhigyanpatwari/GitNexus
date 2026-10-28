import type { RouteFrameworkAlias } from '../../language-provider.js';
import { goRouteFramework } from '../../route-extractors/go-gin-echo.js';

const FIELDS = new Set(['importPath', 'type', 'framework']);

/** Validate the Go-owned alias syntax before analysis starts. */
export function normalizeRouterAliases(value: unknown, source: string): RouteFrameworkAlias[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source} must be a non-empty array of alias objects.`);
  }
  const out = new Map<string, RouteFrameworkAlias>();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `${source} entries must be objects like {"importPath": "...", "type": "Engine", "framework": "gin"}.`,
      );
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!FIELDS.has(key)) throw new Error(`${source} entry has unknown field "${key}".`);
    }
    const field = (name: string, pattern: RegExp, hint: string): string => {
      const raw = record[name];
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error(`${source} entry field "${name}" must be a non-empty string.`);
      }
      const trimmed = raw.trim();
      if (!pattern.test(trimmed)) throw new Error(`${source} entry field "${name}" ${hint}.`);
      return trimmed;
    };
    const importPath = field(
      'importPath',
      /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/,
      'must be a Go import path (e.g. "example.com/org/pkg")',
    );
    const type = field('type', /^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a Go type name');
    const framework = field('framework', /^[a-z]+$/, 'must be "gin" or "echo"');
    if (!goRouteFramework(framework)) {
      throw new Error(`${source} entry field "framework" must be "gin" or "echo".`);
    }
    const key = `${importPath}\u0000${type}`;
    const previous = out.get(key);
    if (previous && previous.framework !== framework) {
      throw new Error(
        `${source} declares ${importPath}.${type} as both "${previous.framework}" and "${framework}".`,
      );
    }
    out.set(key, { importPath, type, framework });
  }
  return [...out.values()].slice(0, 100);
}
