/**
 * Pin the invariants the workspace-index layer MUST preserve after the
 * symbol-indexed duplicates moved to `SemanticModel`.
 *
 * Previously this file asserted on `defsByFileAndName`,
 * `callablesBySimpleName`, and `memberByOwner` directly. Those fields
 * were removed — symbol-keyed lookups now consult `SemanticModel` and
 * `WorkspaceResolutionIndex` holds only `classScopeByDefId` +
 * `moduleScopeByFile`. The same invariants are now asserted via the
 * walker helpers (`findExportedDef`, `findExportedDefByName`,
 * `findOwnedMember`) which are the authoritative consumers. This
 * keeps the regression guard (class-body attributes / methods must
 * not leak into module-export lookups, and method membership must
 * stay reachable after `populateOwners`) without asserting on the
 * now-deleted index shape.
 */

import { describe, it, expect } from 'vitest';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { pythonScopeResolver } from '../../../src/core/ingestion/languages/python/scope-resolver.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';
import {
  findExportedDef,
  findExportedDefByName,
  findOwnedMember,
} from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { reconcileOwnership } from '../../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';

function parsePython(source: string, filePath: string) {
  const parsed = extractParsedFile(
    pythonScopeResolver.languageProvider,
    source,
    filePath,
    () => {},
  );
  if (parsed === undefined) throw new Error('scope extraction failed');
  return parsed;
}

describe('WorkspaceResolutionIndex — scope-only maps', () => {
  it('exposes classScopeByDefId, classScopeIdToDefId, and moduleScopeByFile', () => {
    const parsed = parsePython(
      `
class User:
    pass
`,
      'mod.py',
    );
    const index = buildWorkspaceResolutionIndex([parsed]);
    expect(index.classScopeByDefId).toBeInstanceOf(Map);
    expect(index.classScopeIdToDefId).toBeInstanceOf(Map);
    expect(index.moduleScopeByFile).toBeInstanceOf(Map);
    // No symbol-indexed duplicates.
    expect((index as { memberByOwner?: unknown }).memberByOwner).toBeUndefined();
    expect((index as { defsByFileAndName?: unknown }).defsByFileAndName).toBeUndefined();
    expect((index as { callablesBySimpleName?: unknown }).callablesBySimpleName).toBeUndefined();
  });

  it('classScopeByDefId maps class nodeIds to their Scope', () => {
    const parsed = parsePython(
      `
class User:
    pass
`,
      'mod.py',
    );
    const index = buildWorkspaceResolutionIndex([parsed]);
    const classScope = parsed.scopes.find((s) => s.kind === 'Class');
    const classDef = classScope?.ownedDefs.find((d) => d.type === 'Class');
    expect(classDef).toBeDefined();
    expect(index.classScopeByDefId.get(classDef!.nodeId)).toBe(classScope);
  });

  it('moduleScopeByFile maps filePath to Module scope', () => {
    const parsed = parsePython(
      `
def helper() -> int:
    return 42
`,
      'mod.py',
    );
    const index = buildWorkspaceResolutionIndex([parsed]);
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    expect(index.moduleScopeByFile.get('mod.py')).toBe(moduleScope);
  });
});

describe('findExportedDef — module-export visibility filter', () => {
  it('keeps top-level class and function defs', () => {
    const parsed = parsePython(
      `
class User:
    def save(self) -> bool:
        return True

def helper() -> int:
    return 42
`,
      'mod.py',
    );
    pythonScopeResolver.populateOwners(parsed);
    finalizeScopeModel([parsed]);
    const index = buildWorkspaceResolutionIndex([parsed]);

    expect(findExportedDef('mod.py', 'User', index)?.type).toBe('Class');
    expect(findExportedDef('mod.py', 'helper', index)?.type).toBe('Function');
  });

  it('excludes class-body Variable defs from module-export lookup', () => {
    // Python `MAX_USERS = 100` inside a class body is captured as
    // `Variable:MAX_USERS` in the Class scope's ownedDefs. It must
    // NOT be visible via the file-level export lookup — otherwise
    // `from mod import MAX_USERS` would silently resolve to the
    // class attribute.
    const parsed = parsePython(
      `
class User:
    MAX_USERS = 100
`,
      'mod.py',
    );
    pythonScopeResolver.populateOwners(parsed);
    finalizeScopeModel([parsed]);
    const index = buildWorkspaceResolutionIndex([parsed]);

    expect(findExportedDef('mod.py', 'MAX_USERS', index)).toBeUndefined();
    // Positive-case invariant: the Class def itself is still exported.
    expect(findExportedDef('mod.py', 'User', index)?.type).toBe('Class');
  });

  it('excludes class methods from module-export lookup', () => {
    const parsed = parsePython(
      `
class User:
    def save(self) -> bool:
        return True
`,
      'mod.py',
    );
    pythonScopeResolver.populateOwners(parsed);
    finalizeScopeModel([parsed]);
    const index = buildWorkspaceResolutionIndex([parsed]);

    // `save` is a method — NOT a module export.
    expect(findExportedDef('mod.py', 'save', index)).toBeUndefined();
    expect(findExportedDef('mod.py', 'User', index)?.type).toBe('Class');
  });
});

describe('findExportedDefByName — workspace-wide callable fallback', () => {
  it('excludes class methods when same-named module function exists', () => {
    const parsed = parsePython(
      `
class User:
    def save(self) -> bool:
        return True

def save(x: int) -> int:
    return x
`,
      'mod.py',
    );
    pythonScopeResolver.populateOwners(parsed);
    const finalized = finalizeScopeModel([parsed]);
    const index = buildWorkspaceResolutionIndex([parsed]);

    // Workspace-wide fallback: iterates moduleScopeByFile and returns
    // the first locally-declared callable binding. The method
    // `User.save` lives under a Class scope and must not win.
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module')!;
    const result = findExportedDefByName('save', moduleScope.id, finalized, index);
    expect(result?.qualifiedName).toBe('save');
  });
});

describe('findOwnedMember — SemanticModel-backed owner lookup', () => {
  it('resolves a class method via the reconciled model', () => {
    const parsed = parsePython(
      `
class User:
    def save(self) -> bool:
        return True
`,
      'mod.py',
    );
    pythonScopeResolver.populateOwners(parsed);
    const model = createSemanticModel();
    reconcileOwnership([parsed], model);

    const classScope = parsed.scopes.find((s) => s.kind === 'Class');
    const classDef = classScope?.ownedDefs.find((d) => d.type === 'Class');
    expect(classDef).toBeDefined();

    const found = findOwnedMember(classDef!.nodeId, 'save', model);
    expect(found?.type).toBe('Method');
    expect(found?.qualifiedName).toBe('User.save');
  });
});

describe('classScopeIdToDefId — inverse-map invariant', () => {
  it('classScopeIdToDefId is populated in sync with classScopeByDefId and is an exact inverse', () => {
    const parsed = parsePython(
      `
class User:
    def save(self) -> bool:
        return True

class Admin:
    def promote(self) -> None:
        pass
`,
      'mod.py',
    );
    const index = buildWorkspaceResolutionIndex([parsed]);

    // Same size — the two maps are populated in lockstep.
    expect(index.classScopeIdToDefId.size).toBe(index.classScopeByDefId.size);
    expect(index.classScopeIdToDefId.size).toBe(2);

    // Forward → reverse round-trip.
    for (const [defId, scope] of index.classScopeByDefId) {
      expect(index.classScopeIdToDefId.get(scope.id)).toBe(defId);
    }

    // Reverse → forward round-trip.
    for (const [scopeId, defId] of index.classScopeIdToDefId) {
      const scope = index.classScopeByDefId.get(defId);
      expect(scope).toBeDefined();
      expect(scope!.id).toBe(scopeId);
    }
  });

  it('classScopeIdToDefId is empty for a file with no classes', () => {
    const parsed = parsePython(
      `
def helper() -> int:
    return 42
`,
      'mod.py',
    );
    const index = buildWorkspaceResolutionIndex([parsed]);
    expect(index.classScopeIdToDefId.size).toBe(0);
  });
});
