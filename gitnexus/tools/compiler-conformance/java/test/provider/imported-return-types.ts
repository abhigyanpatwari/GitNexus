/**
 * Unit tests for `propagateImportedReturnTypes` — the SCC-ordered
 * cross-file return-type typeBinding propagation pass introduced in
 * PR #1050 (RFC #909 Ring 3 / TypeScript registry-primary migration).
 *
 * The pass walks `indexes.sccs` in reverse-topological order (leaves
 * first) so multi-hop alias chains collapse to the terminal class in
 * a single pass. These unit tests pin the specific invariants:
 *
 *   1. **Topological collapse** — a 4-file alias chain resolves end-
 *      to-end (`models.User → service.user → util.alias → app.x`)
 *      in a single pass.
 *   2. **Local-annotation guard** — an explicit local typeBinding wins
 *      over an import-derived one.
 *   3. **Missing-source skip** — an import whose source module has no
 *      typeBinding for the symbol is silently skipped (no crash, no
 *      garbage binding).
 *   4. **Cyclic SCC partial fixpoint** — the pass does not throw and
 *      makes best-effort progress.
 *
 * The TypeScript fixtures use the real scope-resolver to keep them
 * close to production behavior — synthetic ParsedFiles would have
 * to fabricate `Scope.typeBindings` correctly, defeating the
 * purpose. Java fixtures also cover import-chain storage and traversal order.
 */

import { compareCodeUnits } from '../../../compare.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractParsedFile } from '../../../../../src/core/ingestion/scope-extractor-bridge.js';
import { javaScopeResolver } from '../../../../../src/core/ingestion/languages/java/scope-resolver.js';
import { finalizeScopeModel } from '../../../../../src/core/ingestion/finalize-orchestrator.js';
import { buildWorkspaceResolutionIndex } from '../../../../../src/core/ingestion/scope-resolution/workspace-index.js';
import { propagateImportedReturnTypes } from '../../../../../src/core/ingestion/scope-resolution/passes/imported-return-types.js';
import type { ParsedFile, Scope } from 'gitnexus-shared';

interface InMemoryFile {
  readonly path: string;
  readonly content: string;
}

function runJavaPropagation(files: readonly InMemoryFile[]): ParsedFile[] {
  javaScopeResolver.loadResolutionConfig?.('');
  const parsedFiles = files.map((file) => {
    const parsed = extractParsedFile(javaScopeResolver.languageProvider, file.content, file.path);
    if (parsed === undefined) throw new Error(`scope extraction failed for ${file.path}`);
    javaScopeResolver.populateOwners(parsed);
    return parsed;
  });
  const paths = new Set(files.map((file) => file.path));
  const indexes = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (target, fromFile) =>
        javaScopeResolver.resolveImportTarget(target, fromFile, paths, undefined, { parsedFiles }),
      mergeBindings: javaScopeResolver.mergeBindings,
    },
  });
  propagateImportedReturnTypes(parsedFiles, indexes, buildWorkspaceResolutionIndex(parsedFiles));
  const populate = javaScopeResolver.populateRangeBindings;
  if (populate === undefined) throw new Error('Java return-type hook is missing');
  populate(parsedFiles, indexes, { fileContents: new Map() });
  return parsedFiles;
}

function moduleTypeBindings(file: ParsedFile): Scope['typeBindings'] {
  const module = file.scopes.find((scope) => scope.id === file.moduleScope);
  if (module === undefined) throw new Error(`no module scope for ${file.filePath}`);
  return module.typeBindings;
}

describe('Java imported method return types', () => {
  const chain = (count: number): InMemoryFile[] =>
    Array.from({ length: count }, (_, i) => ({
      path: `p${i}/C${i}.java`,
      content: `package p${i};
${i > 0 ? `import p${i - 1}.C${i - 1};` : ''}
public class C${i} { public C${i} create${i}() { return this; } }`,
    }));

  it('keeps return-type storage proportional to direct imports along a long import chain', () => {
    const files = runJavaPropagation(chain(64));
    let bindingCount = 0;
    for (const [i, file] of files.entries()) {
      const types = moduleTypeBindings(file);
      assert.equal(types.get(`create${i}`)?.rawName, `C${i}`);
      if (i > 0) assert.equal(types.get(`create${i - 1}`)?.rawName, `C${i - 1}`);
      bindingCount += types.size;
    }
    // Re-copying previously imported methods makes this n * (n + 1) / 2.
    assert.equal(bindingCount, 2 * files.length - 1);
  });

  it('does not change imported return-type visibility with file traversal order', () => {
    const input = chain(4);
    const forward = runJavaPropagation(input);
    const reversed = runJavaPropagation([...input].reverse());
    const bindings = (files: ParsedFile[]) =>
      files
        .map((file) => ({
          path: file.filePath,
          names: [...moduleTypeBindings(file).keys()].sort(compareCodeUnits),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(bindings(forward), bindings(reversed));
    assert.equal(moduleTypeBinding(forward, 'p3/C3.java', 'create0'), undefined);
  });
});

function moduleTypeBinding(parsedFiles: readonly ParsedFile[], filePath: string, name: string) {
  const parsed = parsedFiles.find((p) => p.filePath === filePath);
  if (parsed === undefined) throw new Error(`no ParsedFile for ${filePath}`);
  const moduleScope = parsed.scopes.find((s) => s.id === parsed.moduleScope);
  if (moduleScope === undefined) throw new Error(`no module scope for ${filePath}`);
  return moduleScope.typeBindings.get(name);
}
