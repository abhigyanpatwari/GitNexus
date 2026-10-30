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

/** Every `import … from '…'` whose clause is not `import type`. */
function valueImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^import\s+(type\s+)?[\s\S]*?\s+from\s+'([^']+)';/gm)) {
    if (!m[1]) out.push(m[2]!);
  }
  return out;
}

describe('PL/SQL parser loads lazily', () => {
  it.each(LIGHT_MODULES)('%s imports the parser and extractor by type only', (file) => {
    const source = readFileSync(path.join(INGESTION, file), 'utf8');
    expect(valueImports(source).filter((spec) => HEAVY.test(spec))).toEqual([]);
  });

  it('facts-store reaches the extractor only through dynamic loading', () => {
    const source = readFileSync(path.join(INGESTION, 'plsql/facts-store.ts'), 'utf8');
    expect(source).toMatch(/await import\('\.\/extract\.js'\)/);
  });
});
