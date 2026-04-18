/**
 * Unit tests for `import-target-adapter` (RFC #909 Ring 2 PKG #922).
 *
 * Exercises the language-dispatching FinalizeHook. We don't need the
 * real per-language resolvers here — mock `ImportResolverFn`s let each
 * branch be tested in isolation. Real-resolver integration is covered
 * by the existing per-language import-resolver test suites.
 */

import { describe, it, expect } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  buildImportTargetWorkspace,
  resolveImportTargetAcrossLanguages,
  type ImportTargetWorkspace,
} from '../../../src/core/ingestion/import-target-adapter.js';
import type {
  ImportResolverFn,
  ResolveCtx,
} from '../../../src/core/ingestion/import-resolvers/types.js';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const emptyCtx: ResolveCtx = {
  allFilePaths: new Set(),
  allFileList: [],
  normalizedFileList: [],
  index: { bySuffix: new Map() } as unknown as ResolveCtx['index'],
  resolveCache: new Map(),
  configs: {
    tsconfigPaths: null,
    goModule: null,
    composerConfig: null,
    swiftPackageConfig: null,
    csharpConfigs: [],
  },
};

function fakeProvider(importResolver: ImportResolverFn | undefined): LanguageProvider {
  return { importResolver } as unknown as LanguageProvider;
}

function workspace(
  entries: Array<[SupportedLanguages, ImportResolverFn | undefined]>,
): ImportTargetWorkspace {
  const providers = new Map<SupportedLanguages, LanguageProvider>();
  for (const [lang, resolver] of entries) providers.set(lang, fakeProvider(resolver));
  return buildImportTargetWorkspace(providers, emptyCtx);
}

// ─── buildImportTargetWorkspace ────────────────────────────────────────────

describe('buildImportTargetWorkspace', () => {
  it('registers languages that expose an importResolver', () => {
    const pyResolver: ImportResolverFn = () => ({ kind: 'files', files: ['resolved.py'] });
    const ws = workspace([[SupportedLanguages.Python, pyResolver]]);
    expect(ws.perLanguage.has(SupportedLanguages.Python)).toBe(true);
  });

  it("skips providers whose importResolver is absent (defensive — shouldn't happen in practice)", () => {
    const ws = workspace([[SupportedLanguages.Python, undefined]]);
    expect(ws.perLanguage.size).toBe(0);
  });

  it('threads the shared ResolveCtx into every entry', () => {
    const pyResolver: ImportResolverFn = () => ({ kind: 'files', files: ['x.py'] });
    const tsResolver: ImportResolverFn = () => ({ kind: 'files', files: ['x.ts'] });
    const ws = workspace([
      [SupportedLanguages.Python, pyResolver],
      [SupportedLanguages.TypeScript, tsResolver],
    ]);
    expect(ws.perLanguage.get(SupportedLanguages.Python)!.ctx).toBe(emptyCtx);
    expect(ws.perLanguage.get(SupportedLanguages.TypeScript)!.ctx).toBe(emptyCtx);
  });
});

// ─── resolveImportTargetAcrossLanguages ────────────────────────────────────

describe('resolveImportTargetAcrossLanguages', () => {
  it('dispatches to the resolver for the fromFile extension', () => {
    let seenPath: string | undefined;
    const pyResolver: ImportResolverFn = (raw, _file) => {
      seenPath = raw;
      return { kind: 'files', files: ['models/user.py'] };
    };
    const ws = workspace([[SupportedLanguages.Python, pyResolver]]);
    const result = resolveImportTargetAcrossLanguages('models.user', 'src/app.py', ws);
    expect(seenPath).toBe('models.user');
    expect(result).toBe('models/user.py');
  });

  it('routes to different resolvers based on the fromFile extension', () => {
    const pyResolver: ImportResolverFn = () => ({ kind: 'files', files: ['resolved.py'] });
    const tsResolver: ImportResolverFn = () => ({ kind: 'files', files: ['resolved.ts'] });
    const ws = workspace([
      [SupportedLanguages.Python, pyResolver],
      [SupportedLanguages.TypeScript, tsResolver],
    ]);
    expect(resolveImportTargetAcrossLanguages('x', 'a.py', ws)).toBe('resolved.py');
    expect(resolveImportTargetAcrossLanguages('x', 'a.ts', ws)).toBe('resolved.ts');
  });

  it('returns null when the resolver returns null', () => {
    const pyResolver: ImportResolverFn = () => null;
    const ws = workspace([[SupportedLanguages.Python, pyResolver]]);
    expect(resolveImportTargetAcrossLanguages('external_pkg', 'app.py', ws)).toBeNull();
  });

  it('takes the first file from a package-kind result', () => {
    const resolver: ImportResolverFn = () => ({
      kind: 'package',
      files: ['pkg/index.py', 'pkg/other.py'],
      dirSuffix: 'pkg',
    });
    const ws = workspace([[SupportedLanguages.Python, resolver]]);
    expect(resolveImportTargetAcrossLanguages('pkg', 'app.py', ws)).toBe('pkg/index.py');
  });

  it('returns null when a result has kind=files but an empty files[]', () => {
    // Defensive: resolvers shouldn't return this shape, but tolerate it.
    const resolver: ImportResolverFn = () => ({ kind: 'files', files: [] });
    const ws = workspace([[SupportedLanguages.Python, resolver]]);
    expect(resolveImportTargetAcrossLanguages('x', 'a.py', ws)).toBeNull();
  });

  it('returns null when no resolver is registered for the language', () => {
    const ws = workspace([]); // empty
    // .py file but no Python resolver registered
    expect(resolveImportTargetAcrossLanguages('x', 'a.py', ws)).toBeNull();
  });

  it('returns null when fromFile has an unknown extension', () => {
    const pyResolver: ImportResolverFn = () => ({ kind: 'files', files: ['resolved.py'] });
    const ws = workspace([[SupportedLanguages.Python, pyResolver]]);
    expect(resolveImportTargetAcrossLanguages('x', 'README.xyz', ws)).toBeNull();
  });

  it('returns null when workspaceIndex is undefined / malformed', () => {
    expect(resolveImportTargetAcrossLanguages('x', 'a.py', undefined)).toBeNull();
    // Cast to exercise the runtime guard against caller misuse.
    expect(resolveImportTargetAcrossLanguages('x', 'a.py', {} as unknown)).toBeNull();
  });

  it('swallows resolver exceptions and returns null (treated upstream as unresolved)', () => {
    const throwingResolver: ImportResolverFn = () => {
      throw new Error('resolver boom');
    };
    const ws = workspace([[SupportedLanguages.Python, throwingResolver]]);
    expect(resolveImportTargetAcrossLanguages('x', 'a.py', ws)).toBeNull();
  });
});
