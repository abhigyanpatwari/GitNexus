/**
 * Unit 2 coverage for the C# import interpreter + target resolver.
 *
 * Asserts the ParsedImport shape for every `using` flavor and checks
 * the resolver adapter's single-target behavior against a small set
 * of fake file paths.
 */

import { describe, it, expect } from 'vitest';
import { emitCsharpScopeCaptures } from '../../../../src/core/ingestion/languages/csharp/captures.js';
import { interpretCsharpImport } from '../../../../src/core/ingestion/languages/csharp/interpret.js';
import { resolveCsharpImportTarget } from '../../../../src/core/ingestion/languages/csharp/import-target.js';
import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

function importsFor(src: string): ParsedImport[] {
  const matches = emitCsharpScopeCaptures(src, 'test.cs');
  return matches
    .filter((m) => m['@import.statement'] !== undefined)
    .map((m) => interpretCsharpImport(m))
    .filter((p): p is ParsedImport => p !== null);
}

describe('interpretCsharpImport — using flavors', () => {
  it('interprets `using System;` as a namespace import', () => {
    const [imp, ...rest] = importsFor('using System;\nclass A {}');
    expect(rest).toHaveLength(0);
    expect(imp).toEqual({
      kind: 'namespace',
      localName: 'System',
      importedName: 'System',
      targetRaw: 'System',
    });
  });

  it('interprets multi-segment namespace — localName is the last segment', () => {
    const [imp] = importsFor('using System.Collections.Generic;\nclass A {}');
    expect(imp).toEqual({
      kind: 'namespace',
      localName: 'Generic',
      importedName: 'System.Collections.Generic',
      targetRaw: 'System.Collections.Generic',
    });
  });

  it('interprets `using Alias = Path;` as an alias import with generics stripped', () => {
    const [imp] = importsFor(
      'using Dict = System.Collections.Generic.Dictionary<string, int>;\nclass A {}',
    );
    expect(imp).toEqual({
      kind: 'alias',
      localName: 'Dict',
      importedName: 'Dictionary',
      alias: 'Dict',
      targetRaw: 'System.Collections.Generic.Dictionary',
    });
  });

  it('interprets `using static X.Y;` as a namespace import targeting the type', () => {
    // `using static` brings static members into unqualified scope.
    // Initially this was mapped to `kind: 'wildcard'` but that
    // requires `expandsWildcardTo` to materialize any IMPORTS edge;
    // we map to `namespace` so the File→File edge still emits and
    // the namespace-siblings pass (which walks known namespaces)
    // picks up the target file's classes. Unqualified static-member
    // access is a deferred limitation — see csharp/index.ts.
    const [imp] = importsFor('using static System.Math;\nclass A {}');
    expect(imp).toEqual({
      kind: 'namespace',
      localName: 'Math',
      importedName: 'System.Math',
      targetRaw: 'System.Math',
    });
  });

  it('strips `global::` qualifier — `using global::X.Y;` → namespace X.Y', () => {
    const [imp] = importsFor('using global::System.IO;\nclass A {}');
    expect(imp).toEqual({
      kind: 'namespace',
      localName: 'IO',
      importedName: 'System.IO',
      targetRaw: 'System.IO',
    });
  });

  it('treats `global using X;` as a file-scoped namespace import', () => {
    // Plan decision: defer first-class global-using support; treat as
    // same-file namespace using for this PR. Unit 7 parity gate flags
    // any regression.
    const [imp] = importsFor('global using System;\nclass A {}');
    expect(imp?.kind).toBe('namespace');
    expect(imp?.targetRaw).toBe('System');
  });

  it('emits exactly one ParsedImport per using directive', () => {
    const src = `
      using System;
      using System.Collections.Generic;
      using Dict = System.Collections.Generic.Dictionary<string, int>;
      using static System.Math;
    `;
    const imps = importsFor(src);
    expect(imps).toHaveLength(4);
    expect(imps.map((p) => p.kind)).toEqual(['namespace', 'namespace', 'alias', 'namespace']);
  });
});

describe('resolveCsharpImportTarget — suffix match against .cs files', () => {
  function ctx(fromFile: string, paths: string[]): WorkspaceIndex {
    return { fromFile, allFilePaths: new Set(paths) } as unknown as WorkspaceIndex;
  }

  it('resolves `MyApp.Services` to `MyApp/Services/...cs` when a direct child exists', () => {
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Services',
      importedName: 'MyApp.Services',
      targetRaw: 'MyApp.Services',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx('MyApp/Program.cs', [
        'MyApp/Program.cs',
        'MyApp/Services/UserService.cs',
        'MyApp/Services/Nested/Inner.cs',
      ]),
    );
    expect(result).toBe('MyApp/Services/UserService.cs');
  });

  it('resolves via suffix when namespace dir is nested under a project root', () => {
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Models',
      importedName: 'MyApp.Models',
      targetRaw: 'MyApp.Models',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx('src/Program.cs', ['src/Program.cs', 'src/MyApp/Models/User.cs']),
    );
    expect(result).toBe('src/MyApp/Models/User.cs');
  });

  it('returns null when no matching .cs file exists', () => {
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Nothing',
      importedName: 'Not.Here',
      targetRaw: 'Not.Here',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx('a.cs', ['a.cs', 'b.cs', 'some/Other/Thing.cs']),
    );
    expect(result).toBe(null);
  });

  it('returns null for dynamic-unresolved imports', () => {
    const parsed: ParsedImport = { kind: 'dynamic-unresolved', localName: '', targetRaw: null };
    const result = resolveCsharpImportTarget(parsed, ctx('a.cs', ['a.cs']));
    expect(result).toBe(null);
  });

  it('returns null when WorkspaceIndex has the wrong shape', () => {
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'X',
      importedName: 'X',
      targetRaw: 'X',
    };
    // Intentionally missing `allFilePaths`.
    const result = resolveCsharpImportTarget(parsed, {
      fromFile: 'a.cs',
    } as unknown as WorkspaceIndex);
    expect(result).toBe(null);
  });
});
