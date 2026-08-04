import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { pythonScopeResolver } from '../../../../src/core/ingestion/languages/python/scope-resolver.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { finalizeScopeModel } from '../../../../src/core/ingestion/finalize-orchestrator.js';
import { resolveCompoundReceiverClass } from '../../../../src/core/ingestion/scope-resolution/passes/compound-receiver.js';
import { collectNamespaceTargets } from '../../../../src/core/ingestion/scope-resolution/scope/namespace-targets.js';
import { buildWorkspaceResolutionIndex } from '../../../../src/core/ingestion/scope-resolution/workspace-index.js';

const SOURCES = new Map([
  [
    'pkg/app.py',
    `from pkg import models
from decoy import Missing

def valid():
    return models.User()

def missing():
    return models.Missing()

def shadowed(models):
    return models.User()

def locally_shadowed():
    models = object()
    return models.User()
`,
  ],
  [
    'pkg/dotted.py',
    `import pkg.models

def dotted():
    return pkg.models.User()

def dotted_root_shadowed():
    pkg = object()
    return pkg.models.User()
`,
  ],
  [
    'pkg/models.py',
    `class User:
    pass
`,
  ],
  ['pkg/__init__.py', '# package marker\n'],
  [
    'decoy.py',
    `class Missing:
    pass
`,
  ],
]);

function build() {
  const parsedFiles: ParsedFile[] = [];
  for (const [filePath, source] of SOURCES) {
    const parsed = extractParsedFile(pythonScopeResolver.languageProvider, source, filePath);
    if (parsed === undefined) throw new Error(`scope extraction failed for ${filePath}`);
    pythonScopeResolver.populateOwners(parsed);
    parsedFiles.push(parsed);
  }

  const allFilePaths = new Set(parsedFiles.map((file) => file.filePath));
  const scopes = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (targetRaw, fromFile, _workspaceIndex, parsedImport) =>
        pythonScopeResolver.resolveImportTarget(targetRaw, fromFile, allFilePaths, undefined, {
          parsedFiles,
          parsedImport,
        }),
      isNamespaceImport: (parsedImport, targetFile, fromFile) =>
        pythonScopeResolver.isNamespaceImport?.(parsedImport, targetFile, fromFile) ?? false,
      mergeBindings: (existing, incoming, scopeId) =>
        pythonScopeResolver.mergeBindings(existing, incoming, scopeId),
    },
  });
  const index = buildWorkspaceResolutionIndex(parsedFiles);
  const namespaceTargetsFor = (file: ParsedFile) =>
    collectNamespaceTargets(file, scopes, {
      // Mirror the production wiring in receiver-bound-calls.ts: the dotted
      // import-path key is the provider's opt-in, not a default.
      includeImportPath: pythonScopeResolver.namespaceReceiverIncludesImportPath === true,
    });
  const app = parsedFiles.find((file) => file.filePath === 'pkg/app.py');
  if (app === undefined) throw new Error('missing app fixture');
  const namespaceTargets = namespaceTargetsFor(app);

  const resolveIn = (functionName: string, expression: string) => {
    const functionScope = app.scopes.find(
      (scope) =>
        scope.kind === 'Function' &&
        scope.ownedDefs.some((def) => def.qualifiedName === functionName),
    );
    if (functionScope === undefined) throw new Error(`missing scope for ${functionName}`);
    return resolveCompoundReceiverClass(expression, functionScope.id, scopes, index, {
      constructionSyntax: { bare: true },
      namespaceTargets,
    });
  };

  const dotted = parsedFiles.find((file) => file.filePath === 'pkg/dotted.py');
  if (dotted === undefined) throw new Error('missing dotted fixture');
  const dottedNamespaceTargets = namespaceTargetsFor(dotted);

  const resolveDottedIn = (functionName: string, expression: string) => {
    const functionScope = dotted.scopes.find(
      (scope) =>
        scope.kind === 'Function' &&
        scope.ownedDefs.some((def) => def.qualifiedName === functionName),
    );
    if (functionScope === undefined) throw new Error(`missing scope for ${functionName}`);
    return resolveCompoundReceiverClass(expression, functionScope.id, scopes, index, {
      constructionSyntax: { bare: true },
      namespaceTargets: dottedNamespaceTargets,
    });
  };

  return { resolveIn, resolveDottedIn };
}

describe('Python module namespace construction', () => {
  const { resolveIn, resolveDottedIn } = build();

  it('resolves an exported class from the verified module target', () => {
    expect(resolveIn('valid', 'models.User()')).toMatchObject({
      filePath: 'pkg/models.py',
      qualifiedName: 'User',
    });
  });

  it('fails closed when the module lacks the requested class', () => {
    expect(resolveIn('missing', 'models.Missing()')).toBeUndefined();
  });

  it('does not reuse a file-level namespace when a parameter shadows it', () => {
    expect(resolveIn('shadowed', 'models.User()')).toBeUndefined();
  });

  it('does not reuse a file-level namespace when a local shadows it', () => {
    expect(resolveIn('locally_shadowed', 'models.User()')).toBeUndefined();
  });

  // #2826: `import pkg.models` binds only `pkg`, so the namespace key is the
  // dotted path `pkg.models` while the shadowable name is the root `pkg`.
  it('resolves construction through a dotted import-path namespace', () => {
    expect(resolveDottedIn('dotted', 'pkg.models.User()')).toMatchObject({
      filePath: 'pkg/models.py',
      qualifiedName: 'User',
    });
  });

  it('does not reuse a dotted namespace when a local shadows its ROOT segment', () => {
    // Fails without the root-segment fix: testing the whole `pkg.models`
    // string against scope bindings never matches, so the guard would pass a
    // shadowed receiver straight through to the authoritative namespace branch.
    expect(resolveDottedIn('dotted_root_shadowed', 'pkg.models.User()')).toBeUndefined();
  });
});
