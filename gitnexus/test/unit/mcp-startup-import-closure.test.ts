// #2802 — MCP server startup must not eagerly load the analyze-only language
// provider registry.
//
// `mcp/local/pdg-impact.ts` once imported `core/ingestion/languages/index.ts`
// for a single extension→language lookup. That edge pulled all 16 providers,
// their extractors, and the tree-sitter native binding into every MCP server
// start: 226 extra modules and ~130 ms on a native filesystem, for a server that
// never analyzes anything.
//
// The finding was discovered and lost once already (during #2793) before #2802
// re-derived it, so it gets a guard rather than a comment. The guard walks the
// STATIC import graph only — `await import(...)` is the sanctioned escape hatch
// `local-backend.ts` already uses for embeddings and `bm25-index`, and lazy
// loading is exactly the outcome this test wants to permit.

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const ENTRY = path.join(SRC, 'mcp/local/local-backend.ts');

/** The directory whose modules must stay off the startup path. */
const FORBIDDEN = path.join(SRC, 'core/ingestion/languages');

/** Block and line comments — stripped so prose mentioning a path is not an edge. */
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
/**
 * Whole-clause type-only declarations: `import type ... from 'x'`. TypeScript
 * erases these, so they cost nothing at runtime and must not count as edges —
 * `pdg-impact.ts` type-imports `pool-adapter.js`, and following that would make
 * this walk diverge from the module graph Node actually loads.
 */
const TYPE_ONLY = /\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*['"][^'"]*['"]/g;
/**
 * Every remaining `from '<spec>'` — covers `import ... from`, `export ... from`,
 * and multi-line brace forms. `await import('<spec>')` has no `from` clause, so
 * dynamic imports are excluded structurally rather than by a fragile negative
 * lookahead (see file header for why they must be excluded).
 */
const STATIC_FROM = /\bfrom\s*['"]([^'"]+)['"]/g;
/** Bare side-effect form: `import './foo.js';` */
const STATIC_BARE = /(?:^|[;}\n])\s*import\s*['"](\.[^'"]+)['"]/g;

/**
 * Resolve a repo-relative specifier to a source file on disk. Mirrors the
 * project's NodeNext emit convention: sources import each other with a `.js`
 * suffix that maps to the `.ts` on disk. Package specifiers (no leading `.`)
 * resolve outside the walk and are skipped by the caller.
 */
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    base,
    path.join(base, 'index.ts'),
  ];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** Static-import closure of `entry`, as a map of file → the file that pulled it. */
function staticClosure(entry: string): Map<string, string | null> {
  const importedBy = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const source = fs.readFileSync(current, 'utf8').replace(COMMENTS, '').replace(TYPE_ONLY, '');

    const specs: string[] = [];
    for (const m of source.matchAll(STATIC_FROM)) specs.push(m[1]);
    for (const m of source.matchAll(STATIC_BARE)) specs.push(m[1]);

    const local = specs.filter((s) => s.startsWith('.'));
    for (const spec of local) {
      const resolved = resolveLocal(current, spec);
      const unseen = resolved !== null && !importedBy.has(resolved);
      if (!unseen) continue;
      importedBy.set(resolved as string, current);
      queue.push(resolved as string);
    }
  }

  return importedBy;
}

const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');

describe('MCP server startup import closure (#2802)', () => {
  const closure = staticClosure(ENTRY);

  it('does not statically reach the language provider registry', () => {
    const offenders = [...closure.entries()]
      .filter(([file]) => file.startsWith(FORBIDDEN + path.sep))
      .map(([file, importer]) => `${rel(importer as string)} -> ${rel(file)}`);

    // Named chains, not a bare boolean — whoever reintroduces the edge should
    // see which import did it without re-deriving the graph.
    expect(offenders).toEqual([]);
  });

  it('actually walks the graph (guards against a vacuously-empty closure)', () => {
    // A resolver bug that returned nothing would make the assertion above pass
    // for the wrong reason. Pin a module the entry genuinely imports statically.
    expect([...closure.keys()].map(rel)).toContain('mcp/local/pdg-impact.ts');
    expect(closure.size).toBeGreaterThan(20);
  });

  it('does not follow dynamic imports', () => {
    // `local-backend.ts` reaches `bm25-index.ts` only through `await import()`.
    // If it ever shows up in the closure, the walk started following dynamic
    // imports and the guard above would fire on legitimately-lazy modules.
    expect([...closure.keys()].map(rel)).not.toContain('core/search/bm25-index.ts');
  });
});
