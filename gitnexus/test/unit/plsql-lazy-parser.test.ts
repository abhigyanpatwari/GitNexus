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

/** Modules reachable from the provider registry, the scope resolver and the pipeline phase. */
const LIGHT_MODULES = [
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

const HEAVY = /(?:^|\/)(?:extract|parse)\.js$|\/generated\/|^antlr4ng$/;

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

describe('PL/SQL parser loads lazily', () => {
  it.each(LIGHT_MODULES)('%s imports the parser and extractor by type only', (file) => {
    const source = readFileSync(path.join(INGESTION, file), 'utf8');
    expect(valueImports(source).filter((spec) => HEAVY.test(spec))).toEqual([]);
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
    const source = readFileSync(path.join(INGESTION, 'plsql/facts-store.ts'), 'utf8');
    expect(source).toMatch(/await import\('\.\/extract\.js'\)/);
    expect(source).toMatch(/createRequire\(import\.meta\.url\)\('\.\/extract\.js'\)/);
  });
});
