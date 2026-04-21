/**
 * Directly assert the shape of `WorkspaceResolutionIndex` — in
 * particular that `defsByFileAndName` and `callablesBySimpleName`
 * filter class-body attributes and nested-function locals out of the
 * file-level export keyspace.
 *
 * The equivalent integration-level assertions in
 * `test/integration/resolvers/python.test.ts` (see the
 * `python-class-attr-export-leak` fixture) cover the downstream
 * edge-emission path. This unit test pins the index shape directly
 * because the downstream consumer in Python today doesn't emit an
 * ACCESSES edge for `mod.NAME` member access, so the leak would be
 * latent at the index layer until a future capture path makes it
 * visible. That's precisely when a unit-level pin is most valuable.
 */

import { describe, it, expect } from 'vitest';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { pythonScopeResolver } from '../../../src/core/ingestion/languages/python/scope-resolver.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';

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

describe('buildWorkspaceResolutionIndex — module-export filter', () => {
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
    const index = buildWorkspaceResolutionIndex([parsed]);
    const fileBucket = index.defsByFileAndName.get('mod.py');
    expect(fileBucket).toBeDefined();
    expect(fileBucket!.get('User')?.type).toBe('Class');
    expect(fileBucket!.get('helper')?.type).toBe('Function');
  });

  it('excludes class-body Variable defs from defsByFileAndName', () => {
    // Python's scope extractor captures `MAX_USERS = 100` inside a
    // class body as `Variable:MAX_USERS` in the Class scope's
    // ownedDefs. Without the scope-defining-def filter, this entry
    // would leak into defsByFileAndName['mod.py']['MAX_USERS'] and
    // `mod.MAX_USERS` / `from mod import MAX_USERS` would silently
    // resolve to the class attribute.
    const parsed = parsePython(
      `
class User:
    MAX_USERS = 100
`,
      'mod.py',
    );
    const index = buildWorkspaceResolutionIndex([parsed]);
    const fileBucket = index.defsByFileAndName.get('mod.py');
    expect(fileBucket).toBeDefined();
    expect(fileBucket!.get('MAX_USERS')).toBeUndefined();
    // Positive-case invariant: the Class def itself is still exported.
    expect(fileBucket!.get('User')?.type).toBe('Class');
  });

  it('excludes class methods from defsByFileAndName', () => {
    // A method lives in a Function scope whose parent is the Class
    // scope (not the Module), so it shouldn't be reachable through
    // the direct-child filter at all. Guard against a regression to
    // the earlier "method wins module-export slot" bug.
    const parsed = parsePython(
      `
class User:
    def save(self) -> bool:
        return True
`,
      'mod.py',
    );
    const index = buildWorkspaceResolutionIndex([parsed]);
    const fileBucket = index.defsByFileAndName.get('mod.py');
    expect(fileBucket).toBeDefined();
    // `save` is a method — NOT a module export.
    expect(fileBucket!.get('save')).toBeUndefined();
    expect(fileBucket!.get('User')?.type).toBe('Class');
  });

  it('excludes class methods from callablesBySimpleName', () => {
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
    const index = buildWorkspaceResolutionIndex([parsed]);
    const saves = index.callablesBySimpleName.get('save') ?? [];
    // Only the top-level `def save(x)` is a module-level callable.
    // The `User.save` method lives under a Class scope and must not
    // appear in the workspace callable fallback.
    expect(saves).toHaveLength(1);
    expect(saves[0].qualifiedName).toBe('save');
  });

  it('keeps memberByOwner populated for class methods (unchanged contract)', () => {
    // Regression guard: the narrowing of defsByFileAndName must NOT
    // collaterally drop class-method entries from memberByOwner.
    // findOwnedMember relies on this for receiver-bound dispatch.
    const parsed = parsePython(
      `
class User:
    def save(self) -> bool:
        return True
`,
      'mod.py',
    );
    pythonScopeResolver.populateOwners(parsed);
    const index = buildWorkspaceResolutionIndex([parsed]);
    // User's nodeId is derivable from its ownedDefs — find the Class
    // scope's Class def and look up 'save' under its nodeId.
    const classScope = parsed.scopes.find((s) => s.kind === 'Class');
    const classDef = classScope?.ownedDefs.find((d) => d.type === 'Class');
    expect(classDef).toBeDefined();
    const members = index.memberByOwner.get(classDef!.nodeId);
    expect(members).toBeDefined();
    expect(members!.get('save')?.type).toBe('Function');
  });
});
