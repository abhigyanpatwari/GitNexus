import { chmodSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { finalizeParseCacheIdentity } from '../../src/core/parse-cache-identity.js';
import { createParseIdentityFixture } from '../helpers/parse-cache-identity-fixture.js';

describe('parse cache artifact identity', () => {
  const fixtures: ReturnType<typeof createParseIdentityFixture>[] = [];
  const fixture = (kind: 'source' | 'distribution' = 'source') => {
    const result = createParseIdentityFixture(kind);
    fixtures.push(result);
    return result;
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const f of fixtures.splice(0)) f.cleanup();
  });

  it.each(['source', 'distribution'] as const)(
    'is stable across locations, mtimes and creation order in %s mode',
    (kind) => {
      const a = fixture(kind);
      const b = fixture(kind);
      const build = kind === 'source' ? 'src' : 'dist';
      a.write(`${build}/core/ingestion/z.ts`);
      a.write(`${build}/core/ingestion/a.ts`);
      b.write(`${build}/core/ingestion/a.ts`);
      b.write(`${build}/core/ingestion/z.ts`);
      utimesSync(path.join(b.root, `${build}/core/ingestion/a.ts`), 1, 1);
      expect(a.identity()).toEqual(b.identity());
      expect(a.identity()).toEqual(a.identity());
      expect(a.identity().base).toMatch(/^sha256:[a-f0-9]{64}$/);
    },
  );

  it.each([
    'src/core/tree-sitter/query.scm',
    'src/core/ingestion/languages/new-provider.ts',
    'src/core/ingestion/preprocess.ts',
    'src/core/ingestion/workers/helper.ts',
    'src/core/ingestion/taint/guard-refinement.ts',
    'src/core/ingestion/taint/value-refinement.ts',
    'src/core/ingestion/languages/cobol/flow-source.ts',
    'node_modules/gitnexus-shared/src/index.ts',
    'node_modules/gitnexus-shared/dist/index.js',
    'node_modules/tree-sitter-javascript/prebuilds/test/binding.node',
    'vendor/tree-sitter-proto/src/node-types.json',
  ])('invalidates for changed input bytes: %s', (relative) => {
    const f = fixture();
    f.write(relative, 'before');
    const before = f.identity();
    f.write(relative, 'after!');
    expect(f.identity().base).not.toBe(before.base);
  });

  it('distinguishes adding, renaming and deleting owned inputs', () => {
    const f = fixture();
    const initial = f.identity();
    const added = f.write('src/core/tree-sitter/extra.scm');
    const afterAdd = f.identity();
    renameSync(added, path.join(f.root, 'src/core/tree-sitter/renamed.scm'));
    const afterRename = f.identity();
    rmSync(path.join(f.root, 'src/core/tree-sitter/renamed.scm'));
    expect(new Set([initial.base, afterAdd.base, afterRename.base]).size).toBe(3);
    expect(f.identity()).toEqual(initial);
  });

  it.each(['src/core/ingestion/cfg/harvest.ts', 'src/core/ingestion/languages/cobol/flow.ts'])(
    'isolates extraction-only PDG changes: %s',
    (relative) => {
      const f = fixture();
      const before = f.identity();
      f.write(relative, 'changed PDG extraction');
      const after = f.identity();
      expect(after.base).toBe(before.base);
      expect(after.pdg).not.toBe(before.pdg);
    },
  );

  it('excludes unrelated docs, CLI, UI and package changes', () => {
    const f = fixture();
    const before = f.identity();
    f.write('README.md', 'docs');
    f.write('src/cli/command.ts', 'CLI');
    f.write('gitnexus-web/src/App.tsx', 'UI');
    f.addPackage('unrelated-service');
    expect(f.identity()).toEqual(before);
  });

  it('tracks transitive runtime package bytes, including optional absence', () => {
    const f = fixture();
    f.addPackage('tree-sitter-javascript', { 'grammar-loader': '1.0.0' });
    f.addPackage('grammar-loader');
    const before = f.identity();
    f.write('node_modules/grammar-loader/index.js', 'new same-version loader');
    expect(f.identity().base).not.toBe(before.base);
    rmSync(path.join(f.root, 'vendor/tree-sitter-swift'), { recursive: true });
    const absent = f.identity();
    f.addPackage('tree-sitter-swift');
    expect(f.identity().base).not.toBe(absent.base);
  });

  it('uses effective optional grammar selections and ignores required-grammar opt-outs', () => {
    const f = fixture();
    expect(f.identity({ skipOptionalGrammars: 'swift,dart' })).toEqual(
      f.identity({ skipOptionalGrammars: ' tree-sitter-dart,SWIFT ' }),
    );
    expect(f.identity({ skipOptionalGrammars: 'all' })).toEqual(
      f.identity({ skipOptionalGrammars: '*' }),
    );
    expect(f.identity({ skipOptionalGrammars: 'c,javascript,objc' })).toEqual(
      f.identity({ skipOptionalGrammars: '' }),
    );
    expect(f.identity({ skipOptionalGrammars: 'swift' }).base).not.toBe(
      f.identity({ skipOptionalGrammars: '' }).base,
    );
  });

  it('matches optional-grammar aliases accepted by the runtime loader', async () => {
    const alias = 'tree-sitter-tree-sitter-swift';
    vi.stubEnv('GITNEXUS_SKIP_OPTIONAL_GRAMMARS', alias);
    vi.resetModules();
    const { isGrammarRuntimeSkipped } = await import('../../src/core/tree-sitter/parser-loader.js');
    expect(isGrammarRuntimeSkipped(SupportedLanguages.Swift)).toBe(true);
    const f = fixture();
    expect(f.identity({ skipOptionalGrammars: alias })).toEqual(
      f.identity({ skipOptionalGrammars: 'swift' }),
    );
    expect(f.identity({ skipOptionalGrammars: alias })).not.toEqual(
      f.identity({ skipOptionalGrammars: '' }),
    );
  });

  it('keeps runtime opt-outs lazy and memoized independently of identity capture', async () => {
    vi.stubEnv('GITNEXUS_SKIP_OPTIONAL_GRAMMARS', '');
    vi.resetModules();
    const { isGrammarRuntimeSkipped } = await import('../../src/core/tree-sitter/parser-loader.js');
    expect(isGrammarRuntimeSkipped(SupportedLanguages.C)).toBe(false);

    const f = fixture();
    const dartIdentity = f.identity({ skipOptionalGrammars: 'dart' });
    vi.stubEnv('GITNEXUS_SKIP_OPTIONAL_GRAMMARS', 'swift');
    expect(isGrammarRuntimeSkipped(SupportedLanguages.Swift)).toBe(true);
    expect(isGrammarRuntimeSkipped(SupportedLanguages.Dart)).toBe(false);
    const swiftIdentity = f.identity();

    vi.stubEnv('GITNEXUS_SKIP_OPTIONAL_GRAMMARS', 'dart');
    expect(f.identity()).toEqual(dartIdentity);
    expect(f.identity()).not.toEqual(swiftIdentity);
    expect(isGrammarRuntimeSkipped(SupportedLanguages.Swift)).toBe(true);
    expect(isGrammarRuntimeSkipped(SupportedLanguages.Dart)).toBe(false);
  });

  it('normalizes effective parser options and distinguishes module conditions', () => {
    const f = fixture();
    const before = f.identity();
    vi.stubEnv('GITNEXUS_PARSE_TIMEOUT_MS', '15000.9');
    expect(f.identity()).toEqual(before);
    vi.stubEnv('GITNEXUS_PARSE_TIMEOUT_MS', '12000');
    expect(f.identity().base).not.toBe(before.base);
    vi.stubEnv('GITNEXUS_PARSE_TIMEOUT_MS', '15000');
    vi.stubEnv('NODE_OPTIONS', '--conditions=custom');
    expect(f.identity().base).not.toBe(before.base);
  });

  it('covers the compiled worker and its shared runtime when selected from source', () => {
    const f = fixture();
    rmSync(path.join(f.root, 'src/core/ingestion/workers/parse-worker.js'));
    f.build('dist');
    const before = f.identity();
    f.write('dist/_shared/index.js', 'compiled shared mutation');
    expect(f.identity().base).not.toBe(before.base);
    expect(() => finalizeParseCacheIdentity(f.moduleUrl, before, f.options)).toThrow(
      /changed during analysis/,
    );
    const next = f.identity();
    f.write('dist/core/ingestion/cfg/harvest.js', 'PDG-only compiled mutation');
    expect(f.identity().base).toBe(next.base);
    expect(f.identity().pdg).not.toBe(next.pdg);
  });

  it('detects worker-selection and native-fallback changes after an initial resolution', () => {
    const f = fixture();
    const initial = f.identity();
    f.write('runtime/prebuilds/test/loader.node', 'native executable fallback');
    expect(f.identity().base).not.toBe(initial.base);
    const before = f.identity();
    rmSync(path.join(f.root, 'src/core/ingestion/workers/parse-worker.js'));
    f.build('dist');
    expect(() => finalizeParseCacheIdentity(f.moduleUrl, before, f.options)).toThrow(
      /changed during analysis/,
    );
  });

  it('does not reread unchanged payload bytes for a verified memoized identity', () => {
    const f = fixture();
    let reads = 0;
    f.identity({ onHashedInput: () => reads++ });
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    f.identity({ onHashedInput: () => reads++ });
    expect(reads).toBe(0);
  });

  it('fails closed when required inputs or the selected worker are missing', () => {
    const f = fixture();
    rmSync(path.join(f.root, 'node_modules/tree-sitter-javascript'), { recursive: true });
    expect(f.resolve()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Required parser package is unavailable'),
    });
    f.addPackage('tree-sitter-javascript');
    rmSync(path.join(f.root, 'src/core/ingestion/workers/parse-worker.js'));
    expect(f.resolve()).toMatchObject({ ok: false });
  });

  it('fails closed for bounded traversal', () => {
    const f = fixture();
    expect(f.resolve({ traversalLimits: { entries: 1 } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('exceeded'),
    });
  });

  // Windows does not implement POSIX mode bits or guarantee unprivileged symlinks.
  it.skipIf(process.platform === 'win32')('fails closed for symbolic links', () => {
    const f = fixture();
    const file = f.write('src/core/tree-sitter/protected.ts');
    symlinkSync(file, path.join(f.root, 'src/core/tree-sitter/alias.ts'));
    expect(f.resolve()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('symbolic link'),
    });
  });

  it.skipIf(process.platform === 'win32')('fails closed for unreadable inputs', ({ skip }) => {
    const f = fixture();
    const file = f.write('src/core/tree-sitter/protected.ts');
    chmodSync(file, 0);
    try {
      let readable = false;
      try {
        readFileSync(file);
        readable = true;
      } catch (error) {
        expect(['EACCES', 'EPERM']).toContain((error as NodeJS.ErrnoException).code);
      }
      if (readable) skip('The current process can read files despite chmod(0).');
      expect(f.resolve()).toMatchObject({ ok: false });
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it('rejects inputs changed while their identity is being captured', () => {
    const f = fixture();
    let mutated = false;
    const result = f.resolve({
      onHashedInput: (input) => {
        if (!mutated && input.path.endsWith('core/ingestion/input.ts')) {
          mutated = true;
          f.write('src/core/ingestion/input.ts', 'changed during read');
        }
      },
    });
    expect(mutated).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('changed during identity capture'),
    });
  });

  it.each([
    ['NODE_OPTIONS', '--preserve-symlinks'],
    ['NODE_OPTIONS', '--conditions="unterminated'],
    ['TREE_SITTER_JAVASCRIPT_PREBUILD', '/outside/loader.node'],
  ])('rejects unverifiable resolution overrides: %s=%s', (name, value) => {
    const f = fixture();
    vi.stubEnv(name, value);
    expect(f.resolve()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Unverifiable'),
    });
  });
});
