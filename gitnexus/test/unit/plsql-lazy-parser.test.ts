/**
 * The generated PL/SQL parser is ~14 MB of JS (~120 MB resident). Every
 * analysis process and parse worker loads the provider registry, so the
 * modules it reaches must not import the parser, its runtime or the fact
 * extractor at evaluation time — only `plsql/facts-store.ts` loads them, on
 * demand. A value import slipping into one of these files would put that cost
 * back on every repository, PL/SQL or not.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const INGESTION = path.resolve(__dirname, '../../src/core/ingestion');

/**
 * The shared registries that register PL/SQL (provider list, scope-resolver
 * table, phase index and phase list) plus every module they reach through it.
 */
const LIGHT_MODULES = [
  'languages/index.ts',
  'scope-resolution/pipeline/registry.ts',
  'pipeline-phases/index.ts',
  'pipeline.ts',
  'languages/plsql.ts',
  'languages/plsql/index.ts',
  'languages/plsql/captures.ts',
  'languages/plsql/interpret.ts',
  'languages/plsql/flow.ts',
  'languages/plsql/rename.ts',
  'languages/plsql/scope-resolver.ts',
  'pipeline-phases/plsql.ts',
  'plsql-processor.ts',
  'plsql/facts-store.ts',
  'plsql/file-types.ts',
  'plsql/names.ts',
  'plsql/preprocess.ts',
  'plsql/resolve.ts',
  'plsql/script-include.ts',
];

/** The ANTLR runtime, or (resolved from `file`) the PL/SQL extractor, parse module or generated parser. */
function isHeavy(file: string, spec: string): boolean {
  if (spec === 'antlr4ng') return true;
  if (!spec.startsWith('.')) return false;
  const target = path.posix.join(path.posix.dirname(file), spec);
  return /^plsql\/(?:extract|parse)\.js$|^plsql\/generated\//.test(target);
}

/**
 * Every module specifier this file evaluates at load: `import … from '…'`
 * (not `import type`), side-effect `import '…'`, and `export … from '…'`
 * (not `export type`) — a re-export evaluates its target too.
 */
function valueImports(source: string): string[] {
  const out: string[] = [];
  // Either quote style; clauses may span lines but never cross a `;`.
  for (const m of source.matchAll(/^import\s+(type\s+)?[^;'"]*?\s+from\s+(['"])([^'"]+)\2/gm)) {
    if (!m[1]) out.push(m[3]!);
  }
  for (const m of source.matchAll(/^import\s+(['"])([^'"]+)\1/gm)) out.push(m[2]!);
  for (const m of source.matchAll(
    /^export\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(['"])([^'"]+)\2/gm,
  )) {
    if (!m[1]) out.push(m[3]!);
  }
  return out;
}

/**
 * Every module specifier this file loads at run time: `import('…')` and
 * `require('…')`, including a `createRequire(…)('…')` call, but not a
 * type-only `typeof import('…')`. A top-level
 * `void import('./extract.js')` would load the parser at evaluation even
 * though no import statement names it.
 */
function dynamicLoads(source: string): string[] {
  return [
    ...source.matchAll(
      /(?<!\btypeof\s+)\b(?:import|require|createRequire\([^)]*\))\s*\(\s*(['"`])([^'"`]+)\1/g,
    ),
  ].map((m) => m[2]!);
}

const FACTS_STORE = 'plsql/facts-store.ts';

describe('PL/SQL parser loads lazily', () => {
  it.each(LIGHT_MODULES)('%s imports the parser and extractor by type only', (file) => {
    const source = readFileSync(path.join(INGESTION, file), 'utf8');
    expect(valueImports(source).filter((spec) => isHeavy(file, spec))).toEqual([]);
  });

  it.each(LIGHT_MODULES.filter((file) => file !== FACTS_STORE))(
    '%s never loads the parser or extractor dynamically either',
    (file) => {
      const source = readFileSync(path.join(INGESTION, file), 'utf8');
      expect(dynamicLoads(source).filter((spec) => isHeavy(file, spec))).toEqual([]);
    },
  );

  it('resolves specifiers before judging them: only the PL/SQL parser modules are heavy', () => {
    expect(isHeavy('pipeline-phases/index.ts', './parse.js')).toBe(false);
    expect(isHeavy('pipeline-phases/index.ts', '../plsql/parse.js')).toBe(true);
    expect(isHeavy('languages/index.ts', '../plsql/extract.js')).toBe(true);
    expect(isHeavy('plsql/facts-store.ts', './generated/PlSqlParser.js')).toBe(true);
    expect(isHeavy('plsql/resolve.ts', './names.js')).toBe(false);
    expect(isHeavy('pipeline.ts', 'antlr4ng')).toBe(true);
  });

  it('the dynamic-load scanner sees import(), require() and createRequire()()', () => {
    expect(
      dynamicLoads(
        [
          "void import('./extract.js');",
          'const p = await import("./generated/PlSqlParser.js");',
          "require('antlr4ng');",
          "createRequire(import.meta.url)('./extract.js');",
          "const t: typeof import('./extract.js') = x;",
        ].join('\n'),
      ),
    ).toEqual(['./extract.js', './generated/PlSqlParser.js', 'antlr4ng', './extract.js']);
  });

  it('the scanner sees side-effect imports and re-exports', () => {
    expect(
      valueImports(
        [
          "import './generated/PlSqlParser.js';",
          "export { extractPlSqlFacts } from './extract.js';",
          "export type { X } from './extract.js';",
          'import { PlSqlLexer } from "./generated/PlSqlLexer.js";',
          'import {',
          '  ParseTreeWalker,',
          '  ParserRuleContext,',
          "} from 'antlr4ng';",
          "import type { Y } from './extract.js';",
          "export * as all from './parse.js';",
        ].join('\n'),
      ),
    ).toEqual([
      './generated/PlSqlLexer.js',
      'antlr4ng',
      './generated/PlSqlParser.js',
      './extract.js',
      './parse.js',
    ]);
  });

  it('facts-store is the one place the extractor is loaded: dynamically, or by its require fallback', () => {
    const source = readFileSync(path.join(INGESTION, FACTS_STORE), 'utf8');
    expect(source).toMatch(/await import\('\.\/extract\.js'\)/);
    expect(source).toMatch(/createRequire\(import\.meta\.url\)\('\.\/extract\.js'\)/);
    // Exactly those two (inside loadPlSqlParser and the fallback): any other
    // load, such as an eager top-level `void import(…)`, changes this list.
    expect(dynamicLoads(source).filter((spec) => isHeavy(FACTS_STORE, spec))).toEqual([
      './extract.js',
      './extract.js',
    ]);
  });
});
