/**
 * Unit 2 coverage for the TypeScript import interpreter + target resolver.
 *
 * Asserts the ParsedImport shape for every TS import/export flavor and
 * checks the resolver adapter's single-target behavior against a small
 * set of fake file paths (with and without tsconfig path aliases).
 */

import { describe, it, expect } from 'vitest';
import { emitTsScopeCaptures } from '../../../../src/core/ingestion/languages/typescript/captures.js';
import { splitImportStatement } from '../../../../src/core/ingestion/languages/typescript/import-decomposer.js';
import { interpretTsImport } from '../../../../src/core/ingestion/languages/typescript/interpret.js';
import {
  resolveTsImportTarget,
  type TsResolveContext,
} from '../../../../src/core/ingestion/languages/typescript/import-target.js';
import type { SyntaxNode } from '../../../../src/core/ingestion/utils/ast-helpers.js';
import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';

function importsFor(src: string): ParsedImport[] {
  const matches = emitTsScopeCaptures(src, 'test.ts');
  return matches
    .filter((m) => m['@import.statement'] !== undefined)
    .map((m) => interpretTsImport(m))
    .filter((p): p is ParsedImport => p !== null);
}

function mockNode(
  type: string,
  text: string,
  fields: Record<string, SyntaxNode | null> = {},
  children: readonly SyntaxNode[] = [],
  startIndex = 0,
): SyntaxNode {
  return {
    type,
    text,
    startIndex,
    startPosition: { row: 0, column: startIndex },
    endPosition: { row: 0, column: startIndex + text.length },
    get namedChildCount() {
      return children.length;
    },
    namedChild: (index: number) => children[index] ?? null,
    childForFieldName: (name: string) => fields[name] ?? null,
  } as unknown as SyntaxNode;
}

describe('interpretTsImport — static imports', () => {
  it('named: `import { X } from "./a"`', () => {
    const [imp, ...rest] = importsFor('import { X } from "./a";');
    expect(rest).toHaveLength(0);
    expect(imp).toEqual({
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: './a',
    });
  });

  it('aliased named: `import { X as Y } from "./a"`', () => {
    const [imp] = importsFor('import { X as Y } from "./a";');
    expect(imp).toEqual({
      kind: 'alias',
      localName: 'Y',
      importedName: 'X',
      alias: 'Y',
      targetRaw: './a',
    });
  });

  it('default: `import D from "./a"` maps to alias on the module default export', () => {
    const [imp] = importsFor('import D from "./a";');
    expect(imp).toEqual({
      kind: 'alias',
      localName: 'D',
      importedName: 'default',
      alias: 'D',
      targetRaw: './a',
    });
  });

  it('namespace: `import * as N from "./a"`', () => {
    const [imp] = importsFor('import * as N from "./a";');
    expect(imp).toEqual({
      kind: 'namespace',
      localName: 'N',
      importedName: './a',
      targetRaw: './a',
    });
  });

  it('type-only: `import type { X } from "./a"` folds into `named`', () => {
    const [imp] = importsFor('import type { X } from "./a";');
    expect(imp).toEqual({
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: './a',
    });
  });

  it('per-specifier type-only: `import { type X, Y } from "./a"` gives 2 named', () => {
    const imps = importsFor('import { type X, Y } from "./a";');
    expect(imps).toHaveLength(2);
    const kinds = imps.map((i) => i.kind);
    expect(kinds).toEqual(['named', 'named']);
  });

  it('combined default + named + aliased in one statement emits 3 ParsedImports', () => {
    const imps = importsFor('import D, { X, Y as Z } from "./m";');
    expect(imps).toHaveLength(3);
    expect(imps.map((i) => i.kind)).toEqual(['alias', 'named', 'alias']);

    const def = imps.find((i) => i.localName === 'D');
    expect(def).toMatchObject({ importedName: 'default', targetRaw: './m' });

    const named = imps.find((i) => i.localName === 'X');
    expect(named).toMatchObject({
      kind: 'named',
      importedName: 'X',
      targetRaw: './m',
    });

    const aliased = imps.find((i) => i.localName === 'Z');
    expect(aliased).toMatchObject({
      kind: 'alias',
      importedName: 'Y',
      alias: 'Z',
      targetRaw: './m',
    });
  });

  it('combined default + namespace: `import D, * as N from "./m"` emits 2 imports', () => {
    const imps = importsFor('import D, * as N from "./m";');
    expect(imps).toHaveLength(2);

    const def = imps.find((i) => i.localName === 'D');
    expect(def?.kind).toBe('alias');
    expect((def as { importedName: string }).importedName).toBe('default');

    const ns = imps.find((i) => i.localName === 'N');
    expect(ns?.kind).toBe('namespace');
    expect((ns as { importedName: string }).importedName).toBe('./m');
  });

  it('side-effect: `import "./polyfill"` emits a side-effect ParsedImport (no local binding)', () => {
    const imps = importsFor('import "./polyfill";');
    expect(imps).toHaveLength(1);
    expect(imps[0]).toEqual({
      kind: 'side-effect',
      targetRaw: './polyfill',
    });
  });

  it('fails closed when an import specifier is missing its `name` field', () => {
    const source = mockNode('string', '"./m"');
    const alias = mockNode('identifier', 'Alias', {}, [], 12);
    const spec = mockNode('import_specifier', 'Missing as Alias', { alias }, [alias]);
    const named = mockNode('named_imports', '{ Missing as Alias }', {}, [spec]);
    const clause = mockNode('import_clause', '{ Missing as Alias }', {}, [named]);
    const stmt = mockNode(
      'import_statement',
      'import { Missing as Alias } from "./m";',
      { source },
      [clause, source],
    );

    expect(splitImportStatement(stmt)).toHaveLength(0);
  });

  it('preserves the module path as written (no quote stripping leftovers)', () => {
    const [imp] = importsFor("import X from '@scope/pkg';");
    expect(imp?.targetRaw).toBe('@scope/pkg');
  });
});

describe('interpretTsImport — re-exports', () => {
  it('reexport: `export { X } from "./a"`', () => {
    const [imp] = importsFor('export { X } from "./a";');
    expect(imp).toEqual({
      kind: 'reexport',
      localName: 'X',
      importedName: 'X',
      targetRaw: './a',
    });
  });

  it('reexport-alias: `export { X as Y } from "./a"`', () => {
    const [imp] = importsFor('export { X as Y } from "./a";');
    expect(imp).toEqual({
      kind: 'reexport',
      localName: 'Y',
      importedName: 'X',
      alias: 'Y',
      targetRaw: './a',
    });
  });

  it('wildcard: `export * from "./a"` emits kind=wildcard', () => {
    const [imp] = importsFor('export * from "./a";');
    expect(imp).toEqual({ kind: 'wildcard', targetRaw: './a' });
  });

  it('export-namespace: `export * as ns from "./a"` emits namespace', () => {
    const [imp] = importsFor('export * as ns from "./a";');
    expect(imp).toEqual({
      kind: 'namespace',
      localName: 'ns',
      importedName: './a',
      targetRaw: './a',
    });
  });

  it('type-only re-export folds into `reexport`: `export type { X } from "./a"`', () => {
    const [imp] = importsFor('export type { X } from "./a";');
    expect(imp).toEqual({
      kind: 'reexport',
      localName: 'X',
      importedName: 'X',
      targetRaw: './a',
    });
  });

  it('local `export { X }` (no `from`) is not an import', () => {
    const imps = importsFor('const X = 1; export { X };');
    expect(imps).toHaveLength(0);
  });

  it('fails closed when a re-export specifier is missing its `name` field', () => {
    const source = mockNode('string', '"./m"');
    const alias = mockNode('identifier', 'Alias', {}, [], 12);
    const spec = mockNode('export_specifier', 'Missing as Alias', { alias }, [alias]);
    const clause = mockNode('export_clause', '{ Missing as Alias }', {}, [spec]);
    const stmt = mockNode(
      'export_statement',
      'export { Missing as Alias } from "./m";',
      { source },
      [clause, source],
    );

    expect(splitImportStatement(stmt)).toHaveLength(0);
  });
});

describe('interpretTsImport — dynamic imports', () => {
  it('literal argument: `import("./m")` → dynamic-resolved (targetRaw is a literal path)', () => {
    const [imp] = importsFor('const p = import("./m");');
    expect(imp).toEqual({
      kind: 'dynamic-resolved',
      targetRaw: './m',
    });
  });

  it('non-literal argument: `import(expr)` stays dynamic-unresolved', () => {
    const [imp] = importsFor('const p = import(x);');
    expect(imp?.kind).toBe('dynamic-unresolved');
    expect((imp as { targetRaw: string | null }).targetRaw).toBe('x');
  });

  it('templated argument keeps the source text for diagnostics', () => {
    const [imp] = importsFor('const p = import(`./m/${name}`);');
    expect(imp?.kind).toBe('dynamic-unresolved');
    expect((imp as { targetRaw: string | null }).targetRaw).toContain('name');
  });

  it('await + literal: `await import("./m")` → dynamic-resolved', () => {
    const [imp] = importsFor('async function f() { return await import("./m"); }');
    expect(imp).toEqual({
      kind: 'dynamic-resolved',
      targetRaw: './m',
    });
  });
});

describe('resolveTsImportTarget — standard suffix + alias resolution', () => {
  function ctx(
    fromFile: string,
    paths: string[],
    extra?: Partial<TsResolveContext>,
  ): WorkspaceIndex {
    return {
      fromFile,
      allFilePaths: new Set(paths),
      ...(extra ?? {}),
    } as unknown as WorkspaceIndex;
  }

  it('resolves a relative ./ path with extension appended', () => {
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: './a',
    };
    const result = resolveTsImportTarget(parsed, ctx('src/main.ts', ['src/main.ts', 'src/a.ts']));
    expect(result).toBe('src/a.ts');
  });

  it('resolves ../ paths across directories', () => {
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: '../lib/helpers',
    };
    const result = resolveTsImportTarget(
      parsed,
      ctx('src/app/main.ts', ['src/app/main.ts', 'src/lib/helpers.ts']),
    );
    expect(result).toBe('src/lib/helpers.ts');
  });

  it('prefers an index file when the import targets a directory', () => {
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: './utils',
    };
    const result = resolveTsImportTarget(
      parsed,
      ctx('src/main.ts', ['src/main.ts', 'src/utils/index.ts']),
    );
    expect(result).toBe('src/utils/index.ts');
  });

  it('honors tsconfig path aliases — `@/services/user` → `src/services/user.ts`', () => {
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'UserService',
      importedName: 'UserService',
      targetRaw: '@/services/user',
    };
    const result = resolveTsImportTarget(
      parsed,
      ctx('src/main.ts', ['src/main.ts', 'src/services/user.ts'], {
        tsconfigPaths: {
          baseUrl: '.',
          aliases: [['@/', 'src/']],
        },
      }),
    );
    expect(result).toBe('src/services/user.ts');
  });

  it('returns null when the target does not exist', () => {
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: './missing',
    };
    const result = resolveTsImportTarget(parsed, ctx('src/main.ts', ['src/main.ts']));
    expect(result).toBe(null);
  });

  it('returns null for dynamic-unresolved with null targetRaw', () => {
    const parsed: ParsedImport = { kind: 'dynamic-unresolved', localName: '', targetRaw: null };
    const result = resolveTsImportTarget(parsed, ctx('src/main.ts', ['src/main.ts']));
    expect(result).toBe(null);
  });

  it('resolves dynamic-resolved (literal dynamic import) the same as a static import', () => {
    const parsed: ParsedImport = {
      kind: 'dynamic-resolved',
      targetRaw: './a',
    };
    const result = resolveTsImportTarget(parsed, ctx('src/main.ts', ['src/main.ts', 'src/a.ts']));
    expect(result).toBe('src/a.ts');
  });

  it('returns null when WorkspaceIndex shape is wrong (missing allFilePaths)', () => {
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: './a',
    };
    const result = resolveTsImportTarget(parsed, {
      fromFile: 'src/main.ts',
    } as unknown as WorkspaceIndex);
    expect(result).toBe(null);
  });

  it('switches extensions when language=JavaScript', () => {
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: './a',
    };
    const result = resolveTsImportTarget(
      parsed,
      ctx('src/main.js', ['src/main.js', 'src/a.js'], {
        language: SupportedLanguages.JavaScript,
      }),
    );
    expect(result).toBe('src/a.js');
  });
});
