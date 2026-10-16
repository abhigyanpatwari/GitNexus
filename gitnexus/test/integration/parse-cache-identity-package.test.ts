import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { createTempDir } from '../helpers/test-db.js';
import { analyzeRuntime, PACKAGE_ROOT } from '../helpers/parse-identity-runtime.js';

describe('automatic parser identity in the installed distribution', () => {
  it('uses packed artifacts without source, Git metadata, a sibling shared package, or TypeScript', async () => {
    const artifacts = await createTempDir();
    const repo = await setupMiniRepo();
    try {
      // The integration gate builds first. Pack that output with npm's actual
      // files/bundled-dependencies rules; do not rerun a build in a parallel suite.
      const packed = JSON.parse(
        execFileSync(
          process.platform === 'win32' ? 'npm.cmd' : 'npm',
          ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts.dbPath],
          { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
        ),
      ) as Array<{ filename: string }>;
      execFileSync('tar', [
        '-xzf',
        path.join(artifacts.dbPath, packed[0].filename),
        '-C',
        artifacts.dbPath,
      ]);
      const runtime = path.join(artifacts.dbPath, 'package');
      const manifest = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
      // Supply already-installed production dependencies offline. Bundled
      // grammars stay the independent physical files produced by npm pack.
      for (const name of Object.keys(manifest.dependencies)) {
        const target = path.join(runtime, 'node_modules', name);
        if (
          await access(target).then(
            () => true,
            () => false,
          )
        )
          continue;
        await mkdir(path.dirname(target), { recursive: true });
        await symlink(path.join(PACKAGE_ROOT, 'node_modules', name), target, 'junction');
      }
      for (const absent of [
        'src',
        '.git',
        '../gitnexus-shared',
        'node_modules/typescript',
        'node_modules/gitnexus-shared',
      ]) {
        expect(
          await access(path.join(runtime, absent)).then(
            () => true,
            () => false,
          ),
          absent,
        ).toBe(false);
      }
      const installedRequire = createRequire(path.join(runtime, 'package.json'));
      expect(() => installedRequire.resolve('typescript')).toThrow();
      expect(() => installedRequire.resolve('gitnexus-shared')).toThrow();
      await writeFile(
        path.join(repo.dbPath, 'src/probe.ts'),
        'export function parserProbe() { return 1; }\n',
      );
      const run = (force = false) =>
        analyzeRuntime(runtime, repo.dbPath, path.join(artifacts.dbPath, 'home'), {
          options: { force },
        });
      const cold = await run();
      expect(cold.error).toBeUndefined();
      expect(cold.meta?.parseCacheIdentity?.base).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(cold.facts).toContainEqual({ kind: 'Function', name: 'parserProbe' });
      const warm = await run(true);
      expect(warm.error).toBeUndefined();
      expect(warm.reparsed).toBe(0);
      expect(warm.hits).toBe(cold.reparsed);
      expect(warm.facts).toEqual(cold.facts);

      const queries = path.join(runtime, 'dist/core/ingestion/tree-sitter-queries.js');
      const source = await readFile(queries, 'utf8');
      const changed = source.replace(
        '(function_declaration\n  name: (identifier) @name) @definition.function',
        '(function_declaration\n  name: (identifier) @name) @definition.class',
      );
      expect(changed).not.toBe(source);
      await writeFile(queries, changed);
      const captures = await run();
      expect(captures.error).toBeUndefined();
      expect(captures.hits).toBe(0);
      expect(captures.meta?.parseCacheIdentity).not.toEqual(cold.meta?.parseCacheIdentity);
      expect(captures.facts).toContainEqual({ kind: 'Class', name: 'parserProbe' });

      const metadata = path.join(
        runtime,
        'node_modules/tree-sitter-typescript/typescript/src/node-types.json',
      );
      await writeFile(metadata, `${await readFile(metadata, 'utf8')}\n`);
      const grammar = await run();
      expect(grammar.error).toBeUndefined();
      expect(grammar.hits).toBe(0);
      expect(grammar.meta?.parseCacheIdentity).not.toEqual(captures.meta?.parseCacheIdentity);
      expect(grammar.facts).toEqual(captures.facts);
      expect(JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8')).version).toBe(
        manifest.version,
      );
    } finally {
      await repo.cleanup();
      await artifacts.cleanup();
    }
  }, 240_000);
});
