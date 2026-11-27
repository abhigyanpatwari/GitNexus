import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createFileResultsFixture } from '../helpers/file-results-fixture.js';
import { graphIdentity } from '../helpers/graph-identity.js';
import { javascriptParseContext } from '../../src/core/ingestion/languages/javascript/parse-context.js';
import { javascriptScopeResolver } from '../../src/core/ingestion/languages/javascript/scope-resolver.js';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { initGitRepo } from '../helpers/temp-git-repo.js';
import { gitCommitAll } from '../helpers/incremental-test-repo.js';

const legacySource = 'const obj = { [077]() {} }; function use() { obj[077](); }';
const jsxSource = 'const obj = { [077]() { return <i />; } }; function use() { obj[077](); }';
const ordinarySource = 'const timestamp2026 = 1000 + .005;';

it.each([
  ['script.js', legacySource],
  ['script.jsx', jsxSource],
])(
  'uses package format when scope resolution re-extracts %s without worker facts',
  (file, source) => {
    const packages = (esm: boolean) => ({
      nodeWorkspacePackages: { byName: new Map(), packageModules: new Map([['', esm]]) },
    });
    expect(javascriptParseContext(file, ordinarySource, packages(false))).toBeUndefined();
    for (const literal of ['obj[+077]()', '({077() {}})', 'obj[/* comment */ 077]()']) {
      expect(javascriptParseContext(file, literal, packages(false))).toBeDefined();
    }
    for (const esm of [false, true, false]) {
      let sites: string[] | undefined;
      runScopeResolution(
        {
          graph: createKnowledgeGraph(),
          model: createSemanticModel(),
          files: [{ path: file, content: source }],
          resolutionConfig: packages(esm),
          onResolved({ parsedFiles }) {
            sites = parsedFiles[0]?.referenceSites.map((site) => site.name);
          },
        },
        javascriptScopeResolver,
      );
      expect(sites?.includes('63')).toBe(!esm);
    }
  },
);

it('changes only format-sensitive parse results on a package-only edit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitnexus-property-package-'));
  try {
    const fixture = await createFileResultsFixture(root, {
      'script.js': legacySource,
      'script.jsx': jsxSource,
      'explicit/plain.jsx': legacySource,
      'nested/component.jsx': jsxSource,
      'syntax.jsx': jsxSource + '\nexport {};',
      'strict.jsx': '"use strict"; ' + jsxSource,
      'class.jsx': 'class C { [077]() {} } ' + jsxSource,
      'invalid.jsx': 'const bad = <A></B>; ' + jsxSource,
      'view.tsx': jsxSource,
      'explicit/package.json': '{"type":"commonjs"}',
      'explicit/script.js': legacySource,
      'nested/package.json': '{"type":"module"}',
      'nested/script.js': legacySource,
      'syntax.js': legacySource + '\nexport {};',
      'ordinary.js': ordinarySource,
    });
    for (const format of [undefined, 'module', 'commonjs']) {
      if (format)
        await writeFile(path.join(fixture.repo, 'package.json'), JSON.stringify({ type: format }));
      const run = await fixture.run(format ? 'reuse' : 'cold');
      const target = (file: string) => 'Method:' + file + ':obj.63#0';
      const files =
        format === 'module'
          ? ['explicit/plain.jsx', 'explicit/script.js']
          : ['explicit/plain.jsx', 'explicit/script.js', 'script.js', 'script.jsx'];
      const methods = [...run.graph.iterNodes()]
        .filter((node) => node.label === 'Method')
        .map((node) => node.id)
        .sort();
      expect(methods).toEqual(files.map(target));
      const calls = [...run.graph.iterRelationshipsByType('CALLS')]
        .map((edge) => [edge.sourceId, edge.targetId])
        .sort();
      expect(calls).toEqual(files.map((file) => ['Function:' + file + ':use', target(file)]));
      expect(graphIdentity(run.graph)).toEqual(graphIdentity((await fixture.run('none')).graph));
      const warm = await fixture.run('reuse');
      expect(warm.reparsedFileCount).toBe(0);
      expect(warm.parseCacheHitFileCount).toBe(13);
      if (format) expect(run.parseCacheHitFileCount).toBeGreaterThanOrEqual(3);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it('replaces persisted method and call rows when only package.json changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitnexus-persisted-property-'));
  const repo = path.join(root, 'repo');
  try {
    await mkdir(repo);
    initGitRepo(repo);
    await writeFile(path.join(repo, 'script.js'), legacySource);
    // Leave enough unchanged files to exercise the surgical write path.
    for (let i = 0; i < 8; i++)
      await writeFile(path.join(repo, 'unchanged' + i + '.js'), 'function stable' + i + '() {}');
    const method = 'Method:script.js:obj.63#0';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITNEXUS_HOME: path.join(root, 'home'),
      GITNEXUS_SHARED_STORE: 'off',
    };
    delete env.GITNEXUS_STORAGE_PATH;
    delete env.GITNEXUS_STORAGE_ROOT;
    for (const [index, type] of ['commonjs', 'module', 'commonjs'].entries()) {
      await writeFile(path.join(repo, 'package.json'), JSON.stringify({ type }));
      gitCommitAll(repo, 'package format ' + index);
      const analysis = spawnSync(
        process.execPath,
        [
          path.resolve('dist/cli/index.js'),
          'analyze',
          '.',
          '--index-only',
          '--skip-fts',
          '--workers',
          '1',
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          env,
        },
      );
      const report = analysis.stdout + analysis.stderr;
      expect(analysis.status, report).toBe(0);
      if (index) expect(report).toContain('Incremental: changed=2');
      await initLbug(path.join(repo, '.gitnexus', 'lbug'), { skipFts: true });
      try {
        const methods = await executeQuery('MATCH (m:Method) RETURN m.id AS method');
        const calls = await executeQuery(
          "MATCH (f:Function)-[r:CodeRelation]->(m:Method) WHERE r.type = 'CALLS' RETURN f.id AS caller, m.id AS method",
        );
        expect(methods).toEqual(type === 'module' ? [] : [{ method }]);
        expect(calls).toEqual(
          type === 'module' ? [] : [{ caller: 'Function:script.js:use', method }],
        );
      } finally {
        await closeLbug();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
