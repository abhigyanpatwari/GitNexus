/**
 * A function-local import → `IMPORTS` edge `reason`, end to end.
 *
 * `def f(): from m import X` and Rust's fn-local `use` are syntactically
 * ordinary imports. Nothing about their kind, target or spelling says they are
 * deferred; only WHERE they sit does. That position fact crosses three modules
 * on its way to `check --cycles` — `scope-extractor.ts` reads it from the scope
 * tree in Pass 3, `finalize-algorithm.ts` carries it onto the `ImportEdge`, and
 * `imports-to-edges.ts` turns it into a reason suffix — and a break anywhere in
 * the chain looks the same from the end: a lazy import counted as a module
 * initialization dependency.
 *
 * **This file exists because the fact cannot be recovered downstream, and the
 * first attempt to try shipped as dead code.** The emitter used to walk up from
 * the scope its edge bucket was keyed by, looking for an enclosing `Function`.
 * That walk never fired: `finalize-algorithm.ts:295` publishes every file's
 * finalized edges as `linkedByScope.set(file.moduleScope, …)`, so the map is
 * keyed by the file's `Module` scope and by nothing else. The unit tests missed
 * it because they hand-built `new Map([['fn', …]])`, a shape the pipeline
 * cannot produce, so they exercised the walk on an input that never occurs.
 *
 * So nothing here is posed except the workspace's file list. Real source text
 * goes through the real provider, the real extractor and the real `finalize`,
 * and the scope tree handed to the emitter is `buildScopeTree` over the scopes
 * the extractor actually produced — including the `Function` the import sits
 * in. Against the old implementation, the `imports` map still keys by the
 * module scope, so every case below comes out untagged and fails.
 */
import { describe, expect, it } from 'vitest';
import {
  buildScopeTree,
  finalize,
  type FinalizeFile,
  type FinalizeHooks,
  type ImportEdge,
  type ParsedFile,
  type ScopeId,
} from 'gitnexus-shared';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { cProvider } from '../../../src/core/ingestion/languages/c-cpp.js';
import { pythonProvider } from '../../../src/core/ingestion/languages/python.js';
import { rustProvider } from '../../../src/core/ingestion/languages/rust.js';
import {
  DEFERRED_IMPORT_REASON_SUFFIX,
  emitImportEdges,
} from '../../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';

const BASE_REASON = 'scope-resolution: import';
const PLAIN = BASE_REASON;
const DEFERRED = `${BASE_REASON}${DEFERRED_IMPORT_REASON_SUFFIX}`;

function extract(provider: LanguageProvider, src: string, filePath: string): ParsedFile {
  const parsed = extractParsedFile(provider, src, filePath);
  if (parsed === undefined) {
    throw new Error(`extractParsedFile returned undefined for ${filePath}:\n${src}`);
  }
  return parsed;
}

/**
 * The whole chain's output for `src`: the `reason` on the single
 * `sourceFile → targetFile` edge, and the finalized `ImportEdge[]` that
 * produced it.
 *
 * The edges are returned as well because a wildcard case cannot be judged from
 * the reason alone. `expandWildcard` returns the ORIGINAL edge untouched when
 * the target contributes no names, and that edge already carries the flags — so
 * a wildcard test that lets expansion no-op passes whether or not expansion
 * preserves anything. `wildcardNames` makes expansion actually happen and the
 * edge list is what proves it did.
 */
function runChain(
  provider: LanguageProvider,
  src: string,
  sourceFile: string,
  targetFile: string,
  targetRaws: readonly string[],
  wildcardNames: readonly string[],
): { readonly reason: string | undefined; readonly edges: readonly ImportEdge[] } {
  const parsed = extract(provider, src, sourceFile);

  const source: FinalizeFile = {
    filePath: parsed.filePath,
    moduleScope: parsed.moduleScope,
    localDefs: parsed.localDefs,
    parsedImports: parsed.parsedImports,
  };
  const target: FinalizeFile = {
    filePath: targetFile,
    moduleScope: `scope:${targetFile}#1:0-9999:0:Module` as ScopeId,
    localDefs: [
      { nodeId: 'def:m.X', filePath: targetFile, type: 'Class', qualifiedName: 'X' },
      { nodeId: 'def:m.Y', filePath: targetFile, type: 'Class', qualifiedName: 'Y' },
    ],
    parsedImports: [],
  };

  const hooks: FinalizeHooks = {
    resolveImportTarget: (targetRaw) => (targetRaws.includes(targetRaw) ? targetFile : null),
    expandsWildcardTo: () => wildcardNames,
    mergeBindings: (existing, incoming) => [...existing, ...incoming],
  };
  const out = finalize({ files: [source, target], workspaceIndex: undefined }, hooks);

  // The REAL scope tree for this file — it contains the Function scope the
  // import sits in. The old emitter had one of these too and still could not
  // see the position, because `out.imports` is keyed by `moduleScope`.
  const scopeTree = buildScopeTree(parsed.scopes);
  const rels: Array<{ reason: string }> = [];
  emitImportEdges(
    { addRelationship: (r: { reason: string }) => rels.push(r) } as never,
    out.imports as never,
    scopeTree as never,
    BASE_REASON,
  );
  expect(rels.length).toBeLessThanOrEqual(1);
  return { reason: rels[0]?.reason, edges: out.imports.get(parsed.moduleScope) ?? [] };
}

/**
 * The `reason` on the single `sourceFile → targetFile` edge that `src`
 * produces, taken through the whole chain.
 */
function reasonFor(
  provider: LanguageProvider,
  src: string,
  sourceFile: string,
  targetFile: string,
  targetRaws: readonly string[],
): string | undefined {
  return runChain(provider, src, sourceFile, targetFile, targetRaws, []).reason;
}

const py = (src: string) => reasonFor(pythonProvider, src, 'pkg/a.py', 'pkg/m.py', ['m']);
const rs = (src: string) =>
  reasonFor(rustProvider, src, 'src/a.rs', 'src/m.rs', ['crate::m::X', 'crate::m']);
/** Rust with a target that really contributes names, so a wildcard expands. */
const rsWildcard = (src: string) =>
  runChain(rustProvider, src, 'src/a.rs', 'src/m.rs', ['crate::m::X', 'crate::m'], ['X', 'Y']);
const c = (src: string) => reasonFor(cProvider, src, 'src/a.c', 'src/m.h', ['m.h']);

describe('Python: a function-local import reaches the IMPORTS reason', () => {
  it('`def f(): from m import X` is deferred', () => {
    // The exact shape `eval/workflow_bench/proposer_sandbox.py` uses under the
    // comment "Kept lazy to avoid a module cycle", and the reason this
    // repository reported that deliberate cycle-break as a cycle.
    expect(py('def loader():\n    from m import X\n    return X\n')).toBe(DEFERRED);
  });

  it('the same import at module level is NOT deferred', () => {
    // The control. Without it, "everything is deferred" would pass too.
    expect(py('from m import X\n')).toBe(PLAIN);
  });

  it('a method body defers as well — the walk passes through the Class', () => {
    expect(py('class C:\n    def load(self):\n        from m import X\n        return X\n')).toBe(
      DEFERRED,
    );
  });

  it('a CLASS body does NOT defer — it executes during initialization', () => {
    // `class C: from m import X` binds `C.X` while the module is still being
    // evaluated, so it really does force an initialization order. Only a
    // `Function` anywhere up the chain defers.
    expect(py('class C:\n    from m import X\n')).toBe(PLAIN);
  });

  it('a module-level `if` body does NOT defer', () => {
    // `if FLAG: from m import X` runs during initialization when the branch is
    // taken. Reading the immediate scope kind rather than walking to a
    // `Function` gets this backwards in one direction or the other.
    expect(py('FLAG = True\nif FLAG:\n    from m import X\n')).toBe(PLAIN);
  });

  it('a nested function defers', () => {
    expect(py('def outer():\n    def inner():\n        from m import X\n        return X\n')).toBe(
      DEFERRED,
    );
  });

  it('a module-level import beside a function-local one wins the pair', () => {
    // Dedup is per `(source, target)` pair, so one real initialization import
    // must carry it — labelling this pair deferred would HIDE a true cycle.
    expect(py('from m import Y\n\ndef loader():\n    from m import X\n    return X\n')).toBe(PLAIN);
  });
});

describe('Rust: a function-local `use` reaches the IMPORTS reason', () => {
  it('`fn f() { use crate::m::X; }` is deferred', () => {
    // Rust also proves the walk has to climb: the provider puts the function
    // body in a `Block` whose parent is the `Function`, so an immediate-scope
    // check would answer `Block` and miss this.
    expect(rs('fn f() {\n    use crate::m::X;\n    let _ = X;\n}\n')).toBe(DEFERRED);
  });

  it('a `use` inside a nested block inside a function is still deferred', () => {
    expect(
      rs('fn f() {\n    if true {\n        use crate::m::X;\n        let _ = X;\n    }\n}\n'),
    ).toBe(DEFERRED);
  });

  it('a top-level `use` is NOT deferred', () => {
    expect(rs('use crate::m::X;\n\nfn f() {\n    let _ = X;\n}\n')).toBe(PLAIN);
  });
});

/**
 * The one kind that is rebuilt rather than carried.
 *
 * `finalize`'s `expandWildcard` does not spread the wildcard edge — it
 * constructs one fresh `wildcard-expanded` edge per exported name, because
 * `localName`, `targetExportedName` and `targetDefId` all differ per name. Every
 * property NOT named in that constructor is therefore dropped, and
 * `runsOnlyWhenCalled` was: the extractor tagged the statement correctly (its
 * walk has no `switch` on kind, so it covers `wildcard` like everything else),
 * finalize put it on the base edge, and expansion then threw it away one line
 * before the graph bridge could read it.
 *
 * Rust is the language that can express this — `fn f() { use m::*; }` is legal.
 * Python cannot: `from x import *` inside a `def` is a SyntaxError.
 *
 * Each case asserts the expansion really happened. Left to itself the helper's
 * target contributes no names, `expandWildcard` returns the original edge
 * untouched, and the assertion on the reason would hold no matter what the
 * expansion path does with the flag.
 */
describe('Rust: a function-local wildcard survives expansion', () => {
  it('`fn f() { use crate::m::*; }` is deferred on every expanded edge', () => {
    const { reason, edges } = rsWildcard('fn f() {\n    use crate::m::*;\n    let _ = X;\n}\n');
    // Two names in, two `wildcard-expanded` edges out — expansion ran.
    expect(edges.map((e) => e.kind)).toStrictEqual(['wildcard-expanded', 'wildcard-expanded']);
    expect(edges.map((e) => e.localName)).toStrictEqual(['X', 'Y']);
    // The flag is on each expanded edge, not merely on a pair that dedup
    // happened to rank from something else.
    expect(edges.map((e) => e.runsOnlyWhenCalled)).toStrictEqual([true, true]);
    expect(reason).toBe(DEFERRED);
  });

  it('a top-level `use crate::m::*;` expands to UNtagged edges', () => {
    const { reason, edges } = rsWildcard('use crate::m::*;\n\nfn f() {\n    let _ = X;\n}\n');
    expect(edges.map((e) => e.kind)).toStrictEqual(['wildcard-expanded', 'wildcard-expanded']);
    expect(edges.map((e) => e.runsOnlyWhenCalled)).toStrictEqual([undefined, undefined]);
    expect(reason).toBe(PLAIN);
  });
});

/**
 * C `#include` is spliced, not executed — so position cannot defer it.
 *
 * The Pass-3 rule is about EXECUTION: an import inside a function body runs
 * when the function is called. A `#include` is a preprocessor directive; the
 * header's text is spliced in before the program starts, wherever the directive
 * sits, and C permits it inside a function body. So an include cycle built from
 * such directives is REAL, and tagging one deferred makes `check --cycles` drop
 * it. A suppressed true cycle is the failure direction that matters — the C
 * provider declares `importsSplicedAtCompileTime` to opt out of the walk.
 *
 * Python rides along in the same test rather than in its own: "nothing is ever
 * tagged" would satisfy the C assertion on its own, and this is the file where
 * that regression is cheapest to catch.
 */
describe('C: a `#include` inside a function body is NOT deferred', () => {
  it('the include stays an initialization dependency while Python defers', () => {
    // `void f(void) { #include "m.h" }` — the directive sits in a `Block`
    // inside a `Function`, the exact shape the position walk marks for every
    // language that executes its imports.
    expect(c('void f(void) {\n#include "m.h"\n}\n')).toBe(PLAIN);
    // Same run, same rule, a language whose imports do execute. Without this,
    // an opt-out that leaked to every provider would still pass above.
    expect(py('def loader():\n    from m import X\n    return X\n')).toBe(DEFERRED);
  });

  it('a top-level `#include` is an initialization dependency too', () => {
    // The control on the control: the opt-out withholds deferral, it does not
    // change what an ordinary include already was.
    expect(c('#include "m.h"\n\nvoid f(void) {}\n')).toBe(PLAIN);
  });
});
