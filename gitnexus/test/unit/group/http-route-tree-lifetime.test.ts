/**
 * Tree lifetime in the HTTP source scan.
 *
 * node-tree-sitter frees a Tree's native memory only in a finalizer that Node
 * runs from a `setImmediate` after GC. The extractor must therefore (a) keep
 * no tree reachable once its own file is done, and (b) yield a macrotask every
 * `PARSES_PER_RELEASE` parses so those finalizers run. A large Kotlin/Android
 * monorepo otherwise held every tree of the family pass at once (gigabytes of
 * native memory) between two graph queries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import v8 from 'node:v8';
import Parser from 'tree-sitter';
import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
import { getPluginForFile } from '../../../src/core/group/extractors/http-patterns/index.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

const TreeClass = (Parser as unknown as { Tree: abstract new (...args: never[]) => unknown }).Tree;
/** Reachable Tree wrappers; `queryObjects` runs a full GC first. */
const liveTrees = (): number => v8.queryObjects(TreeClass, { format: 'count' });
function write(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const makeRepo = (repoPath: string): RepoHandle => ({
  id: 'tree-lifetime',
  path: 'test/tree-lifetime',
  repoPath,
  storagePath: path.join(repoPath, '.gitnexus'),
});

/** Every plugin, interface-inherited Spring routes, a constant-folded route. */
describe('HTTP source scan tree lifetime', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-http-tree-lifetime-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps no file source alive through the cached scan detections', async () => {
    // One detection per file, whose path V8 slices from the file's source, and
    // only the padding around it grows between the two runs.
    const FILES = 16;
    const LARGE_PAD = 1024 * 1024;
    const projectScan = getPluginForFile('x.ts')?.projectScan;
    if (!projectScan) throw new Error('expected the JS/TS project scan');
    const heapAtResolve = async (padChars: number): Promise<number> => {
      const root = fs.mkdtempSync(path.join(tmpDir, 'pad-'));
      for (let i = 0; i < FILES; i++) {
        write(
          root,
          `src/c${i}.ts`,
          `// ${'x'.repeat(padChars)}\nexport const load${i} = () => fetch('/api/customer/preferences${i}');\n`,
        );
      }
      // Every scanned file is cached by then; `liveTrees` runs a full GC.
      let atResolve = 0;
      const resolve = projectScan.resolve;
      projectScan.resolve = (...args) => {
        liveTrees();
        atResolve = process.memoryUsage().heapUsed;
        return resolve.apply(projectScan, args);
      };
      try {
        liveTrees();
        const before = process.memoryUsage().heapUsed;
        const contracts = await new HttpRouteExtractor().extract(null, root, makeRepo(root));
        expect(contracts).toHaveLength(FILES);
        return atResolve - before;
      } finally {
        projectScan.resolve = resolve;
      }
    };

    const small = await heapAtResolve(1024);
    const large = await heapAtResolve(LARGE_PAD);
    // The large run reads 16 MB more source; the detections must keep none of it.
    expect(large - small).toBeLessThan((FILES * LARGE_PAD) / 4);
  });

  it('keeps no scope view in the JS/TS project facts', () => {
    const plugin = getPluginForFile('x.ts');
    if (!plugin?.projectScan) throw new Error('expected the JS/TS project scan');
    const parser = new Parser();
    parser.setLanguage(plugin.language);
    const tree = parser.parse(
      "import { Router } from 'express';\nexport const r = Router();\nr.get('/items', (_req, res) => res.send('x'));\n",
    );
    const collected = plugin.projectScan.collect({ filePath: 'src/r.ts', tree });
    // A scope view (ParsedFile) has a module scope and its scope list; the
    // import resolvers need only file paths, so `resolve` must not get one.
    const scopeViews: string[] = [];
    const visit = (value: unknown, at: string): void => {
      if (value === null || typeof value !== 'object') return;
      if ('moduleScope' in value && 'scopes' in value) scopeViews.push(at);
      for (const [key, child] of Object.entries(value)) visit(child, `${at}.${key}`);
    };
    visit(collected, 'facts');
    expect(scopeViews).toEqual([]);
    expect(collected).toMatchObject({ filePath: 'src/r.ts', facts: { filePath: 'src/r.ts' } });
  });
});
