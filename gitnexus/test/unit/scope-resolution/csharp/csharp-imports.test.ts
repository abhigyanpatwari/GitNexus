/**
 * Unit 2 coverage for the C# import interpreter + target resolver.
 *
 * Asserts the ParsedImport shape for every `using` flavor and checks
 * the resolver adapter's single-target behavior against a small set
 * of fake file paths.
 */

import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { emitCsharpScopeCaptures } from '../../../../src/core/ingestion/languages/csharp/captures.js';
import { interpretCsharpImport } from '../../../../src/core/ingestion/languages/csharp/interpret.js';
import { resolveCsharpImportTarget } from '../../../../src/core/ingestion/languages/csharp/import-target.js';
import { loadCsharpResolutionConfig } from '../../../../src/core/ingestion/languages/csharp/resolution-config.js';
import { getMaxFileSizeBytes } from '../../../../src/core/ingestion/utils/max-file-size.js';
import {
  csharpSuffixFallbackAllowed,
  importAlignsWithDeclaredNamespaces,
} from '../../../../src/core/ingestion/csharp-namespace-gate.js';
import { csharpScopeResolver } from '../../../../src/core/ingestion/languages/csharp/scope-resolver.js';
import type { CSharpProjectConfig } from '../../../../src/core/ingestion/language-config.js';
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
  function ctx(
    fromFile: string,
    paths: string[],
    declaredNamespaces?: ReadonlySet<string>,
    extra?: {
      rootNamespaces?: ReadonlySet<string>;
      truncated?: boolean;
      csharpConfigs?: readonly CSharpProjectConfig[];
    },
  ): WorkspaceIndex {
    const hasEvidence =
      declaredNamespaces !== undefined ||
      extra?.rootNamespaces !== undefined ||
      extra?.truncated !== undefined;
    return {
      fromFile,
      allFilePaths: new Set(paths),
      csharpConfigs: extra?.csharpConfigs,
      namespaces: hasEvidence
        ? {
            declaredNamespaces,
            rootNamespaces: extra?.rootNamespaces,
            truncated: extra?.truncated,
          }
        : undefined,
    } as unknown as WorkspaceIndex;
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

  it('does not map BCL usings to coincidentally-named local files (#1881)', () => {
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Tasks',
      importedName: 'System.Threading.Tasks',
      targetRaw: 'System.Threading.Tasks',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx(
        'Services/OrderService.cs',
        ['Services/OrderService.cs', 'Tasks.cs', 'Events/OrderCreatedEvent.cs'],
        new Set(['MyApp.Services', 'MyApp.Events', 'MyApp.Legacy']),
      ),
    );
    expect(result).toBe(null);
  });

  it('does not map a BCL using to a coincidentally PATH-ALIGNED local file via direct-match (#1881, Codex F2)', () => {
    // The no-csproj direct-match must be gated too: `Legacy/System/Threading/
    // Tasks.cs` path-aligns with `using System.Threading.Tasks;` and would
    // satisfy resolveDirectMatch's nested-suffix match — but System.* is not a
    // declared in-repo namespace, so the gate (now run FIRST) blocks it.
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Tasks',
      importedName: 'System.Threading.Tasks',
      targetRaw: 'System.Threading.Tasks',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx(
        'Services/OrderService.cs',
        ['Services/OrderService.cs', 'Legacy/System/Threading/Tasks.cs', 'Models/User.cs'],
        new Set(['MyApp.Services', 'MyApp.Legacy', 'MyApp.Models']),
      ),
    );
    expect(result).toBe(null);
  });

  it('still resolves a legitimate in-repo using via direct-match when evidence is present (Codex F2 guard)', () => {
    // Gating the direct-match must NOT over-block a legitimate aligned import:
    // `using MyApp.Services;` aligns (exact declared) so the gate passes and the
    // namespace-dir direct-child match still resolves.
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Services',
      importedName: 'MyApp.Services',
      targetRaw: 'MyApp.Services',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx(
        'MyApp/Program.cs',
        ['MyApp/Program.cs', 'MyApp/Services/UserService.cs'],
        new Set(['MyApp.Services']),
      ),
    );
    expect(result).toBe('MyApp/Services/UserService.cs');
  });

  it('still resolves in-repo namespace imports via progressive stripping', () => {
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Models',
      importedName: 'MyApp.Models',
      targetRaw: 'MyApp.Models',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx(
        'Services/UserService.cs',
        ['Services/UserService.cs', 'Models/User.cs'],
        new Set(['MyApp.Models', 'MyApp.Services']),
      ),
    );
    expect(result).toBe('Models/User.cs');
  });

  it('drives the csproj-first branch: resolves via the internal resolver when configs exist (#7)', () => {
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Models',
      importedName: 'MyApp.Models',
      targetRaw: 'MyApp.Models',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx(
        'Services/OrderService.cs',
        ['Services/OrderService.cs', 'Models/User.cs'],
        new Set(['MyApp.Services', 'MyApp.Models']),
        {
          rootNamespaces: new Set(['MyApp']),
          csharpConfigs: [{ rootNamespace: 'MyApp', projectDir: '' }],
        },
      ),
    );
    expect(result).toBe('Models/User.cs');
  });

  it('mirrors legacy authority: csproj present + internal-resolver-empty returns null, no ungated direct match (#2)', () => {
    // `Foo/Bar.cs` is an exact whole-path match that the ungated
    // `resolveDirectMatch` would have returned. With csproj configs present
    // and `Foo.Bar` outside the declared namespaces, the legacy strategy
    // returns an empty result that STOPS the chain — the registry path must
    // now do the same (return null) instead of falling through.
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Bar',
      importedName: 'Foo.Bar',
      targetRaw: 'Foo.Bar',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx(
        'Services/OrderService.cs',
        ['Services/OrderService.cs', 'Foo/Bar.cs'],
        new Set(['MyApp.Models']),
        {
          rootNamespaces: new Set(['MyApp']),
          csharpConfigs: [{ rootNamespace: 'MyApp', projectDir: '' }],
        },
      ),
    );
    expect(result).toBe(null);
  });

  it('requires the rootNamespaces anchor end-to-end: parent-of import resolves only when anchored (#7)', () => {
    // `using MyApp.Core;` is an ancestor of declared `MyApp.Core.Models`.
    // The gate opens ONLY when `MyApp.Core` sits at/above an in-repo root, so
    // `Core/Thing.cs` resolves with roots {MyApp.Core} but not without them.
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Core',
      importedName: 'MyApp.Core',
      targetRaw: 'MyApp.Core',
    };
    const anchored = resolveCsharpImportTarget(
      parsed,
      ctx(
        'Services/OrderService.cs',
        ['Services/OrderService.cs', 'Core/Thing.cs'],
        new Set(['MyApp.Core.Models']),
        {
          rootNamespaces: new Set(['MyApp.Core']),
        },
      ),
    );
    expect(anchored).toBe('Core/Thing.cs');

    const unanchored = resolveCsharpImportTarget(
      parsed,
      ctx(
        'Services/OrderService.cs',
        ['Services/OrderService.cs', 'Core/Thing.cs'],
        new Set(['MyApp.Core.Models']),
      ),
    );
    expect(unanchored).toBe(null);
  });

  it('a sibling import outside the declared namespaces does not resolve even with roots (#7)', () => {
    // `using MyApp.Other;` is neither a child nor an ancestor of the only
    // declared namespace `MyApp.Models`, so the gate stays closed and the
    // otherwise-matchable `Other/Thing.cs` is left unresolved.
    const parsed: ParsedImport = {
      kind: 'namespace',
      localName: 'Other',
      importedName: 'MyApp.Other',
      targetRaw: 'MyApp.Other',
    };
    const result = resolveCsharpImportTarget(
      parsed,
      ctx(
        'Services/OrderService.cs',
        ['Services/OrderService.cs', 'Other/Thing.cs'],
        new Set(['MyApp.Models']),
        {
          rootNamespaces: new Set(['MyApp']),
        },
      ),
    );
    expect(result).toBe(null);
  });
});

describe('importAlignsWithDeclaredNamespaces — declared-namespace gate (#1881)', () => {
  it('matches an exactly-declared namespace', () => {
    expect(importAlignsWithDeclaredNamespaces('MyApp.Models', new Set(['MyApp.Models']))).toBe(
      true,
    );
  });

  it('child-of: import nested under a declared ancestor namespace', () => {
    // `using MyApp.Models.Detail;` when the repo declares `MyApp.Models`.
    expect(
      importAlignsWithDeclaredNamespaces('MyApp.Models.Detail', new Set(['MyApp.Models'])),
    ).toBe(true);
  });

  it('child-of allows a using-static type under a declared namespace (#1)', () => {
    // `using static MyApp.Utils.Logger;` — the parent namespace `MyApp.Utils`
    // is declared, so the type import aligns even though `MyApp.Utils.Logger`
    // itself is not a declared namespace.
    expect(importAlignsWithDeclaredNamespaces('MyApp.Utils.Logger', new Set(['MyApp.Utils']))).toBe(
      true,
    );
  });

  it('child-of stays anchored: a declared BCL root does NOT qualify a BCL using (#1)', () => {
    // A repo that declares `namespace System;` (a shim) must not green-light
    // `using System.Threading.Tasks;` — the import's parent `System.Threading`
    // is NOT declared, so the only match would be a coincidental local
    // `Tasks.cs`. The old "any declared prefix" rule re-opened #1881 here.
    expect(
      importAlignsWithDeclaredNamespaces(
        'System.Threading.Tasks',
        new Set(['System', 'MyApp.Models']),
        new Set(['System', 'MyApp']),
      ),
    ).toBe(false);
  });

  it('parent-of: parent-namespace import resolves against a declared child', () => {
    // `using MyApp;` when the repo declares `MyApp.Models` — must still open
    // the gate (anchored on the in-repo root namespace `MyApp`).
    expect(
      importAlignsWithDeclaredNamespaces('MyApp', new Set(['MyApp.Models']), new Set(['MyApp'])),
    ).toBe(true);
  });

  it('parent-of works without explicit roots via the top-level declared segment', () => {
    expect(importAlignsWithDeclaredNamespaces('MyApp', new Set(['MyApp.Models']))).toBe(true);
  });

  it('parent-of for a multi-segment csproj root (using MyApp; with RootNamespace MyApp.Core)', () => {
    expect(
      importAlignsWithDeclaredNamespaces(
        'MyApp',
        new Set(['MyApp.Core.Models']),
        new Set(['MyApp.Core', 'MyApp']),
      ),
    ).toBe(true);
  });

  it('parent-of stays anchored: a BCL prefix does NOT qualify via a locally-declared sub-namespace (#5)', () => {
    // A file declaring `namespace System.Threading.Tasks.Extensions` must not
    // open the gate for `using System.Threading.Tasks;`.
    const declared = new Set(['System.Threading.Tasks.Extensions', 'MyApp.Models']);
    expect(
      importAlignsWithDeclaredNamespaces(
        'System.Threading.Tasks',
        declared,
        new Set(['MyApp', 'System']),
      ),
    ).toBe(false);
    // Same conclusion without explicit roots (top-level segment fallback).
    expect(importAlignsWithDeclaredNamespaces('System.Threading.Tasks', declared)).toBe(false);
  });

  it('returns false for an unrelated BCL namespace', () => {
    expect(
      importAlignsWithDeclaredNamespaces(
        'System.Linq',
        new Set(['MyApp.Services']),
        new Set(['MyApp']),
      ),
    ).toBe(false);
  });

  it('returns false for an empty or undefined declared set', () => {
    expect(importAlignsWithDeclaredNamespaces('MyApp', new Set())).toBe(false);
    expect(importAlignsWithDeclaredNamespaces('MyApp', undefined)).toBe(false);
  });
});

describe('csharpSuffixFallbackAllowed — fail-open safety valves (#1881)', () => {
  const declared = new Set(['MyApp.Models']);
  const roots = new Set(['MyApp']);

  it('blocks a non-aligned import when evidence is present and complete', () => {
    // Baseline: with complete evidence, a BCL using that aligns with nothing
    // declared in-repo is blocked.
    expect(
      csharpSuffixFallbackAllowed('System.Threading.Tasks', {
        declaredNamespaces: declared,
        rootNamespaces: roots,
        truncated: false,
      }),
    ).toBe(false);
  });

  it('fails OPEN (allows) when no evidence was threaded (#7)', () => {
    // The exact same import the complete-evidence case blocks must be ALLOWED
    // when evidence is undefined — preserving the pre-gate permissive behavior
    // for callers that never ran the scan.
    expect(csharpSuffixFallbackAllowed('System.Threading.Tasks', undefined)).toBe(true);
  });

  it('keeps a clearly-external BCL root BLOCKED even when the scan was truncated (#1881, Codex F1)', () => {
    // A single truncation must NOT silently re-enable BCL→local suffix matches
    // repo-wide: System.* stays gated through truncation when the repo does not
    // declare it. (This reverses the prior blanket-fail-open for external roots.)
    expect(
      csharpSuffixFallbackAllowed('System.Threading.Tasks', {
        declaredNamespaces: declared,
        rootNamespaces: roots,
        truncated: true,
      }),
    ).toBe(false);
  });

  it('fails OPEN for a genuinely local-looking import when the scan was truncated (#6)', () => {
    // Non-external roots still fail open under truncation so an incomplete
    // (capped/unreadable) scan does not silently drop a legitimate in-repo edge.
    expect(
      csharpSuffixFallbackAllowed('MyApp.Internal.Widget', {
        declaredNamespaces: declared,
        rootNamespaces: roots,
        truncated: true,
      }),
    ).toBe(true);
  });

  it('lets an external root fail OPEN through truncation when the repo declares it (escape hatch)', () => {
    // If the repo actually declares the (normally-external) root, the alignment
    // escape hatch allows the import even under truncation.
    expect(
      csharpSuffixFallbackAllowed('System.Threading.Tasks', {
        declaredNamespaces: new Set(['System.Threading']),
        rootNamespaces: new Set(['System']),
        truncated: true,
      }),
    ).toBe(true);
  });
});

describe('csharpScopeResolver.resolveImportTarget — config→ctx adapter wiring (#9)', () => {
  it('threads resolutionConfig.namespaces into the gate so a BCL using is blocked', () => {
    // Exercises the adapter (NOT resolveCsharpImportTarget directly): the
    // resolutionConfig that loadResolutionConfig returns must reach the gate as
    // ctx.namespaces. With a coincidental local `Tasks.cs` present and
    // `System.Threading.Tasks` outside the declared namespaces, the wired
    // evidence blocks the spurious edge.
    const result = csharpScopeResolver.resolveImportTarget(
      'System.Threading.Tasks',
      'Services/OrderService.cs',
      new Set(['Services/OrderService.cs', 'Tasks.cs']),
      {
        csharpConfigs: [],
        namespaces: {
          declaredNamespaces: new Set(['MyApp.Services', 'MyApp.Legacy']),
          rootNamespaces: new Set(['MyApp']),
          truncated: false,
        },
      },
    );
    expect(result).toBe(null);
  });

  it('threads csharpConfigs so a csproj-mapped import resolves through the adapter', () => {
    // The other half of the wiring: csharpConfigs must reach ctx.csharpConfigs
    // so the csproj root-namespace mapping runs.
    const result = csharpScopeResolver.resolveImportTarget(
      'MyApp.Models',
      'Services/OrderService.cs',
      new Set(['Services/OrderService.cs', 'Models/User.cs']),
      {
        csharpConfigs: [{ rootNamespace: 'MyApp', projectDir: '' }],
        namespaces: {
          declaredNamespaces: new Set(['MyApp.Models', 'MyApp.Services']),
          rootNamespaces: new Set(['MyApp']),
          truncated: false,
        },
      },
    );
    expect(result).toBe('Models/User.cs');
  });
});

describe('loadCsharpResolutionConfig — one-pass namespace scan (#1881)', () => {
  async function makeTempRepo(files: Record<string, string>): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'csharp-scan-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content, 'utf-8');
    }
    return root;
  }

  it('collects file-scoped, block, and multiple-per-file namespaces; skips bin/obj; reads csproj root', async () => {
    const root = await makeTempRepo({
      'App.csproj':
        '<Project><PropertyGroup><RootNamespace>MyApp</RootNamespace></PropertyGroup></Project>',
      'Scoped.cs': 'namespace Alpha.Scoped;\npublic class A {}',
      'Block.cs': 'namespace Beta.Block\n{\n    public class B {}\n}',
      'Multi.cs': 'namespace Gamma.One { }\nnamespace Gamma.Two { }',
      'bin/Generated.cs': 'namespace Should.Skip;',
      'obj/Temp.cs': 'namespace Should.AlsoSkip;',
    });
    try {
      const config = await loadCsharpResolutionConfig(root);
      const ns = config.namespaces!;
      expect(ns.truncated).toBe(false);
      expect([...ns.declaredNamespaces!].sort()).toEqual([
        'Alpha.Scoped',
        'Beta.Block',
        'Gamma.One',
        'Gamma.Two',
      ]);
      expect(ns.declaredNamespaces!.has('Should.Skip')).toBe(false);
      expect(ns.declaredNamespaces!.has('Should.AlsoSkip')).toBe(false);
      // csproj RootNamespace + top-level segment of each declared namespace.
      expect(ns.rootNamespaces!.has('MyApp')).toBe(true);
      expect([...ns.rootNamespaces!].sort()).toEqual(['Alpha', 'Beta', 'Gamma', 'MyApp']);
      expect(config.csharpConfigs).toHaveLength(1);
      expect(config.csharpConfigs[0]!.rootNamespace).toBe('MyApp');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps truncated=false for a realistic-depth layout so the gate stays engaged (#1)', async () => {
    // A repo nested ~8 levels deep is well within the production cap
    // (CSHARP_SCAN_MAX_DEPTH=24). Were the cap as low as the old value (5),
    // this layout would trip `truncated` and disable the #1881 gate for the
    // whole repo. Proving truncated===false here pins the gate ON for repos
    // of normal depth.
    const root = await makeTempRepo({
      'App.csproj':
        '<Project><PropertyGroup><RootNamespace>MyApp</RootNamespace></PropertyGroup></Project>',
      'a/b/c/d/e/f/g/h/Deep.cs': 'namespace MyApp.Deep.Feature;',
    });
    try {
      const config = await loadCsharpResolutionConfig(root);
      const ns = config.namespaces!;
      expect(ns.truncated).toBe(false);
      expect(ns.declaredNamespaces!.has('MyApp.Deep.Feature')).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('sets the truncation flag when the depth cap prunes a subtree (#11)', async () => {
    // repoRoot is depth 0; the chain below nests one level past the depth cap
    // (CSHARP_SCAN_MAX_DEPTH=24) so the deepest dir is pruned, its namespace
    // is missed, and the flag trips. Built relative to the real cap — do NOT
    // lower the production cap for the test.
    const deepChain = Array.from({ length: 25 }, (_, i) => `d${i}`).join('/');
    const root = await makeTempRepo({
      'Shallow.cs': 'namespace Shallow.Ns;',
      [`${deepChain}/Deep.cs`]: 'namespace Deep.Ns;',
    });
    try {
      const config = await loadCsharpResolutionConfig(root);
      const ns = config.namespaces!;
      expect(ns.truncated).toBe(true);
      expect(ns.declaredNamespaces!.has('Shallow.Ns')).toBe(true);
      expect(ns.declaredNamespaces!.has('Deep.Ns')).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('streams a large .cs file end-to-end, collecting namespaces past the old size cap (#1881)', async () => {
    // The namespace scan streams each file, so a `.cs` far larger than the old
    // per-file size cap is read end-to-end in constant memory instead of being
    // skipped. A namespace at the START and one at the very END (well past the
    // old cap boundary) must BOTH be collected, and `truncated` must stay false
    // — a big generated file no longer disables the #1881 gate repo-wide.
    const cap = getMaxFileSizeBytes();
    const padLine = '// pad pad pad pad pad pad\n';
    const padding = padLine.repeat(Math.ceil((cap * 3) / padLine.length));
    const huge = `namespace Generated.Head;\n${padding}namespace Generated.Tail { }\n`;
    const root = await makeTempRepo({
      'Hand.cs': 'namespace Hand.Written;',
      'Generated.cs': huge,
    });
    try {
      const config = await loadCsharpResolutionConfig(root);
      const ns = config.namespaces!;
      expect(ns.truncated).toBe(false);
      expect(ns.declaredNamespaces!.has('Hand.Written')).toBe(true);
      expect(ns.declaredNamespaces!.has('Generated.Head')).toBe(true);
      expect(ns.declaredNamespaces!.has('Generated.Tail')).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('collects a Unicode namespace through the streamed scan, not truncated (Codex F3)', async () => {
    // The scanner is now Unicode-aware, so a non-ASCII namespace is captured
    // end-to-end instead of being dropped (which would over-block its imports).
    const root = await makeTempRepo({
      'App.csproj':
        '<Project><PropertyGroup><RootNamespace>MyApp</RootNamespace></PropertyGroup></Project>',
      'Models/Café.cs': 'namespace Café.App;\npublic class Modèle {}',
    });
    try {
      const config = await loadCsharpResolutionConfig(root);
      const ns = config.namespaces!;
      expect(ns.truncated).toBe(false);
      expect(ns.declaredNamespaces!.has('Café.App')).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('marks the scan truncated when a file has an uncaptured namespace form, failing the gate OPEN (Codex F3)', async () => {
    // A namespace split across lines is not captured by the line scanner; the
    // scan must flag truncated so the dropped namespace fails the #1881 gate
    // OPEN rather than over-block an import declared in that file.
    const root = await makeTempRepo({
      'App.csproj':
        '<Project><PropertyGroup><RootNamespace>MyApp</RootNamespace></PropertyGroup></Project>',
      'Weird.cs': 'namespace\n   MyApp.Weird;\npublic class W {}',
    });
    try {
      const config = await loadCsharpResolutionConfig(root);
      const ns = config.namespaces!;
      expect(ns.truncated).toBe(true);
      // A local-looking import under the dropped namespace fails open (and U1's
      // external-root denylist still keeps BCL roots blocked under truncation).
      expect(csharpSuffixFallbackAllowed('MyApp.Weird.Thing', ns)).toBe(true);
      expect(csharpSuffixFallbackAllowed('System.Threading.Tasks', ns)).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('recovers <RootNamespace> past the old read cap via streaming (Codex F4)', async () => {
    // A big leading <ItemGroup> pushes <RootNamespace> past the old 512KB read
    // cap; the streamed scan reads on until it finds the tag, so the correct
    // root is recovered (pre-fix the capped read synthesized the filename 'App').
    const cap = getMaxFileSizeBytes();
    const itemLine = '    <Compile Include="src/Generated/F.cs" />\n';
    const bigItemGroup =
      '  <ItemGroup>\n' +
      itemLine.repeat(Math.ceil((cap * 2) / itemLine.length)) +
      '  </ItemGroup>\n';
    const csproj =
      '<Project Sdk="Microsoft.NET.Sdk">\n' +
      bigItemGroup +
      '  <PropertyGroup><RootNamespace>MyApp</RootNamespace></PropertyGroup>\n' +
      '</Project>\n';
    const root = await makeTempRepo({
      'App.csproj': csproj,
      'Models/User.cs': 'namespace MyApp.Models;\npublic class User {}',
    });
    try {
      const config = await loadCsharpResolutionConfig(root);
      expect(config.csharpConfigs).toHaveLength(1);
      expect(config.csharpConfigs[0]!.rootNamespace).toBe('MyApp');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to the filename root only when <RootNamespace> is genuinely absent (Codex F4 control)', async () => {
    // A genuine read-to-EOF absence still synthesizes the filename root, so a
    // .csproj without RootNamespace is unchanged — the fix only avoids guessing
    // when the tag was unreachable.
    const root = await makeTempRepo({
      'App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
      'Models/User.cs': 'namespace App.Models;\npublic class User {}',
    });
    try {
      const config = await loadCsharpResolutionConfig(root);
      expect(config.csharpConfigs).toHaveLength(1);
      expect(config.csharpConfigs[0]!.rootNamespace).toBe('App');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
