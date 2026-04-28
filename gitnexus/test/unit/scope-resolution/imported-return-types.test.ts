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
 * The tests use the real TypeScript scope-resolver to keep them
 * close to production behavior — synthetic ParsedFiles would have
 * to fabricate `Scope.typeBindings` correctly, defeating the
 * purpose. Each fixture is small (4 files max) and runs in <100ms.
 */

import { describe, it, expect } from 'vitest';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';
import { propagateImportedReturnTypes } from '../../../src/core/ingestion/scope-resolution/passes/imported-return-types.js';
import type {
  BindingRef,
  ParsedFile,
  Scope,
  ScopeId,
  ScopeTree,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';

interface InMemoryFile {
  readonly path: string;
  readonly content: string;
}

function parseAll(files: readonly InMemoryFile[]): ParsedFile[] {
  const parsed: ParsedFile[] = [];
  for (const f of files) {
    const p = extractParsedFile(typescriptScopeResolver.languageProvider, f.content, f.path);
    if (p === undefined) throw new Error(`scope extraction failed for ${f.path}`);
    typescriptScopeResolver.populateOwners(p);
    parsed.push(p);
  }
  return parsed;
}

function runPipelineToPropagation(files: readonly InMemoryFile[]) {
  const parsedFiles = parseAll(files);
  const allFilePaths = new Set(parsedFiles.map((p) => p.filePath));
  const finalized = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (targetRaw, fromFile) =>
        typescriptScopeResolver.resolveImportTarget(targetRaw, fromFile, allFilePaths),
      mergeBindings: (existing, incoming, scopeId) =>
        typescriptScopeResolver.mergeBindings(existing, incoming, scopeId),
    },
  });
  const workspaceIndex = buildWorkspaceResolutionIndex(parsedFiles);
  propagateImportedReturnTypes(parsedFiles, finalized, workspaceIndex);
  return { parsedFiles, finalized, workspaceIndex };
}

function moduleTypeBinding(parsedFiles: readonly ParsedFile[], filePath: string, name: string) {
  const parsed = parsedFiles.find((p) => p.filePath === filePath);
  if (parsed === undefined) throw new Error(`no ParsedFile for ${filePath}`);
  const moduleScope = parsed.scopes.find((s) => s.id === parsed.moduleScope);
  if (moduleScope === undefined) throw new Error(`no module scope for ${filePath}`);
  return moduleScope.typeBindings.get(name);
}

describe('propagateImportedReturnTypes — SCC-ordered terminal-type collapse', () => {
  it('collapses a 4-file alias chain in a single pass (leaves first)', () => {
    // models.ts: declares User; getUser() returns User.
    // service.ts: imports getUser, exports `user = getUser()`.
    // util.ts: imports user from service, re-binds as `alias`.
    // app.ts: imports alias from util.
    //
    // Expected: app.alias.typeBindings → User (terminal class), not
    // an intermediate alias/getUser/user ref. SCC order is
    // models → service → util → app (reverse-topological).
    const { parsedFiles } = runPipelineToPropagation([
      {
        path: 'models.ts',
        content: `
export class User {
  save(): boolean { return true; }
}
export function getUser(): User {
  return new User();
}
`,
      },
      {
        path: 'service.ts',
        content: `
import { getUser } from './models';
export const user = getUser();
`,
      },
      {
        path: 'util.ts',
        content: `
import { user } from './service';
export const alias = user;
`,
      },
      {
        path: 'app.ts',
        content: `
import { alias } from './util';
`,
      },
    ]);

    const appAlias = moduleTypeBinding(parsedFiles, 'app.ts', 'alias');
    expect(appAlias).toBeDefined();
    // The terminal type is `User`. The exact rawName depends on the
    // TS extractor's annotation capture (return-type vs inferred-from-
    // call); we assert the chain has collapsed away from the
    // intermediate `getUser` / `user` / `alias` rawNames.
    expect(appAlias!.rawName).toBe('User');
  });

  it('respects local-annotation guard: explicit local typeBinding wins over import-derived', () => {
    // app.ts: imports `user` from service AND has a local
    // `const user: Account = ...` annotation. The local annotation
    // must win — propagation must skip when the importer already
    // has a typeBinding for the same name.
    const { parsedFiles } = runPipelineToPropagation([
      {
        path: 'models.ts',
        content: `
export class User {}
export class Account {}
export function getUser(): User {
  return new User();
}
`,
      },
      {
        path: 'service.ts',
        content: `
import { getUser } from './models';
export const user = getUser();
`,
      },
      {
        path: 'app.ts',
        content: `
import { user as importedUser } from './service';
const user: Account = new Account();
`,
      },
    ]);

    // The module-scope `user` binding should be `Account` (local
    // annotation), NOT `User` (import-mirrored). The imported alias
    // `importedUser` may carry the User type — only the LOCAL `user`
    // is shielded.
    const appUser = moduleTypeBinding(parsedFiles, 'app.ts', 'user');
    expect(appUser).toBeDefined();
    expect(appUser!.rawName).toBe('Account');
  });

  it('skips imports whose source module has no typeBinding (no crash, no phantom binding)', () => {
    // service.ts exports `helper` but has NO return-type annotation,
    // so service.ts's module typeBindings does NOT include `helper`.
    // app.ts imports helper → propagation must skip silently.
    const { parsedFiles } = runPipelineToPropagation([
      {
        path: 'service.ts',
        content: `
export function helper(x) {
  return x;
}
`,
      },
      {
        path: 'app.ts',
        content: `
import { helper } from './service';
`,
      },
    ]);

    // No phantom binding for `helper` in app's module scope (or, if
    // present, it MUST resolve to a real type — never to `undefined`
    // or an empty rawName). The pass simply does nothing for this
    // import, and the test verifies the pipeline did not throw.
    const appHelper = moduleTypeBinding(parsedFiles, 'app.ts', 'helper');
    if (appHelper !== undefined) {
      expect(appHelper.rawName.length).toBeGreaterThan(0);
    }
  });

  it('mirrors import return types from bindingAugmentations-only refs', () => {
    const appScopeId = 'scope:app' as ScopeId;
    const sourceScopeId = 'scope:source' as ScopeId;
    const appModule = {
      id: appScopeId,
      kind: 'Module',
      parent: null,
      filePath: 'app.ts',
      bindings: new Map(),
      typeBindings: new Map(),
    } as unknown as Scope;
    const sourceModule = {
      id: sourceScopeId,
      kind: 'Module',
      parent: null,
      filePath: 'source.ts',
      bindings: new Map(),
      typeBindings: new Map([['getUser', { rawName: 'User', source: 'return-annotation' }]]),
    } as unknown as Scope;
    const importedDef = {
      nodeId: 'def:source.getUser',
      filePath: 'source.ts',
      qualifiedName: 'getUser',
      type: 'Function',
    } as SymbolDefinition;
    const scopeTree = {
      getScope: (id: ScopeId) => {
        if (id === appScopeId) return appModule;
        if (id === sourceScopeId) return sourceModule;
        return undefined;
      },
    } as unknown as ScopeTree;
    const indexes = {
      scopeTree,
      bindings: new Map(),
      bindingAugmentations: new Map([
        [
          appScopeId,
          new Map([['getUser', [{ def: importedDef, origin: 'import' } as BindingRef]]]),
        ],
      ]),
      sccs: [{ files: ['app.ts'] }],
    } as unknown as ScopeResolutionIndexes;
    const workspaceIndex = {
      moduleScopeByFile: new Map([
        ['app.ts', appModule],
        ['source.ts', sourceModule],
      ]),
    } as unknown as WorkspaceResolutionIndex;

    propagateImportedReturnTypes([], indexes, workspaceIndex);

    expect(appModule.typeBindings.get('getUser')?.rawName).toBe('User');
  });

  it('does not throw on a cyclic SCC (partial fixpoint, best-effort)', () => {
    // a.ts imports from b, b.ts imports from a. The two files form
    // a single cyclic SCC. Within one pass we mirror what we can;
    // we do NOT iterate to convergence. The contract is "no throw,
    // best effort" — see ts-circular cross-file-binding fixture.
    expect(() =>
      runPipelineToPropagation([
        {
          path: 'a.ts',
          content: `
import { B } from './b';
export class A {
  b: B;
  constructor() { this.b = new B(); }
}
export function getA(): A { return new A(); }
`,
        },
        {
          path: 'b.ts',
          content: `
import { A } from './a';
export class B {
  a: A;
  constructor() { this.a = new A(); }
}
export function getB(): B { return new B(); }
`,
        },
      ]),
    ).not.toThrow();
  });
});
