import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveTsImportTarget,
  type TsResolveContext,
} from '../../../../src/core/ingestion/languages/typescript/import-target.js';
import * as importResolverUtils from '../../../../src/core/ingestion/utils/suffix-index.js';
import { typescriptScopeResolver } from '../../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

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
        tsconfigs: {
          scopes: [{ dir: '', baseUrl: '', paths: [{ pattern: '@/*', targets: ['src/*'] }] }],
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

  it('resolves JavaScript extensions from a JavaScript source file', () => {
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'X',
      importedName: 'X',
      targetRaw: './a',
    };
    const result = resolveTsImportTarget(parsed, ctx('src/main.js', ['src/main.js', 'src/a.js']));
    expect(result).toBe('src/a.js');
  });

  it('does not resolve a bare specifier that no config declares (#2953)', () => {
    // `components/Button` is not relative, names no package, and this workspace
    // declares no `baseUrl` to make it project-relative. The old resolver
    // answered `src/components/Button.ts` anyway, by searching the file list for
    // any path ending in the specifier — the defect in #2953. Nothing declares
    // that edge, so there is none.
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'Button',
      importedName: 'Button',
      targetRaw: 'components/Button',
    };
    const result = resolveTsImportTarget(
      parsed,
      ctx('src/main.ts', ['src/main.ts', 'src/components/Button.ts']),
    );
    expect(result).toBeNull();
  });

  it('resolves that same specifier once a tsconfig `baseUrl` declares it (#2953)', () => {
    // The other half of the arm above, and the reason it is not a regression:
    // the specifier resolves when the project says it should, and to the same
    // file. What changed is that the answer now has a declared basis.
    const parsed: ParsedImport = {
      kind: 'named',
      localName: 'Button',
      importedName: 'Button',
      targetRaw: 'components/Button',
    };
    const result = resolveTsImportTarget(
      parsed,
      ctx('src/main.ts', ['src/main.ts', 'src/components/Button.ts'], {
        tsconfigs: { scopes: [{ dir: '', baseUrl: 'src', paths: [] }] },
      }),
    );
    expect(result).toBe('src/components/Button.ts');
  });
});

describe('typescriptScopeResolver.resolveImportTarget — real wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds no suffix index, and answers null for an undeclared bare specifier (#2953)', () => {
    // Both halves matter. The index is not built because nothing asks the
    // question it answered — "does any file's path end in this specifier?" —
    // and the specifier does not resolve because nothing in this workspace
    // declares it. The spy is what keeps the first half honest: an index built
    // and then ignored would still be per-pass work over the whole file list.
    const spy = vi.spyOn(importResolverUtils, 'buildSuffixIndex');
    const files = new Set(['src/main.ts', 'src/components/Button.ts']);

    const result = typescriptScopeResolver.resolveImportTarget!(
      'components/Button',
      'src/main.ts',
      files,
    );

    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null for unresolvable package-style imports', () => {
    const files = new Set(['src/main.ts', 'src/utils/helper.ts']);

    const result = typescriptScopeResolver.resolveImportTarget!(
      'nonexistent/Module',
      'src/main.ts',
      files,
    );

    expect(result).toBeNull();
  });

  it('resolves relative imports through the scope-resolver entry point', () => {
    const files = new Set(['src/main.ts', 'src/utils.ts']);

    const result = typescriptScopeResolver.resolveImportTarget!('./utils', 'src/main.ts', files);

    expect(result).toBe('src/utils.ts');
  });
});
