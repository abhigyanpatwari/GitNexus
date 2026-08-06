/**
 * Capture-match → semantic-shape interpreters.
 *
 * Two pure functions, both consumed by the central scope extractor:
 *
 *   - `interpretPythonImport`     → `ParsedImport`
 *   - `interpretPythonTypeBinding` → `ParsedTypeBinding`
 *
 * The matches arrive pre-decomposed by `emitPythonScopeCaptures`
 * (one imported name per match; synthesized `self`/`cls` markers
 * already attached) so these functions are straight-line tag readers.
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

// ─── interpretImport ──────────────────────────────────────────────────────

export function interpretPythonImport(captures: CaptureMatch): ParsedImport | null {
  // Markers attached by `splitImportStatement` (import-decomposer.ts):
  //   `@import.kind`  : 'plain' | 'aliased' | 'from' | 'from-alias' | 'wildcard' | 'dynamic'
  //   `@import.name`  : the imported symbol name (or module name for plain imports)
  //   `@import.alias` : the local alias name (for `as` forms)
  //   `@import.source`: the module path (always present except for `dynamic`)
  const kindCap = captures['@import.kind'];
  const nameCap = captures['@import.name'];
  const aliasCap = captures['@import.alias'];
  const sourceCap = captures['@import.source'];

  const kind = kindCap?.text;
  if (kind === undefined) return null;

  switch (kind) {
    case 'plain': {
      // `import numpy`
      if (sourceCap === undefined) return null;
      return {
        kind: 'namespace',
        localName: sourceCap.text.split('.')[0]!, // `import a.b.c` exposes `a`
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'aliased': {
      // `import numpy as np`
      if (sourceCap === undefined || aliasCap === undefined) return null;
      return {
        kind: 'namespace',
        localName: aliasCap.text,
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'from': {
      // `from m import x`
      if (sourceCap === undefined || nameCap === undefined) return null;
      return {
        kind: 'named',
        localName: nameCap.text,
        importedName: nameCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'from-alias': {
      // `from m import x as y`
      if (sourceCap === undefined || nameCap === undefined || aliasCap === undefined) return null;
      return {
        kind: 'alias',
        localName: aliasCap.text,
        importedName: nameCap.text,
        alias: aliasCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'wildcard': {
      // `from m import *`
      if (sourceCap === undefined) return null;
      return { kind: 'wildcard', targetRaw: sourceCap.text };
    }
    case 'dynamic': {
      // `importlib.import_module(...)` — preserved for diagnostics.
      return {
        kind: 'dynamic-unresolved',
        localName: '',
        targetRaw: sourceCap?.text ?? null,
      };
    }
    default:
      return null;
  }
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

export function interpretPythonTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  // Synthesized `self` / `cls` captures carry `@type-binding.name` and
  // `@type-binding.type` directly — same shape as parameter annotations,
  // source differs.
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  // Strip surrounding quotes for PEP 484 forward references:
  // `def f(x: "User")`.  Then unwrap nullable unions — `User | None`,
  // `None | User`, `Optional[User]` — to the concrete class name so
  // receiver-typed resolution treats nullable receivers identically to
  // non-nullable ones.  Finally strip single-arg generic wrappers so
  // `list[User]` / `Iterable[User]` behave like `User` for iterable
  // for-loop chain propagation.
  const rawType = stripGeneric(stripNullable(stripForwardRefQuotes(typeCap.text.trim())));

  // Order matters: more specific anchor captures take precedence. `self`
  // and `cls` are synthesized with their own marker captures; the SCM
  // anchor topic captures (`@type-binding.parameter`,
  // `@type-binding.annotation`, `@type-binding.constructor`) distinguish
  // the variable-annotation and constructor-inferred forms from the
  // classic parameter annotation.
  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  // `cls` is a self-like receiver; share the source label so downstream
  // `Registry.lookup` Step 2 treats them identically.
  else if (captures['@type-binding.cls'] !== undefined) source = 'self';
  // Before the instance-field arm, not after it: `self.x = Outer()` (#2807)
  // carries BOTH markers, and its type is inferred from the CONSTRUCTOR CALL —
  // the weakest of the three tiers — so a class that also annotates the field
  // keeps the annotation. Testing constructor first is what lets the
  // instance-field arm below stay flat; the two orders agree on every input,
  // since they differ only where both markers are present and both then say
  // 'constructor-inferred'.
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.instance-field'] !== undefined)
    source =
      captures['@type-binding.parameter'] !== undefined ? 'parameter-annotation' : 'annotation';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.alias'] !== undefined) source = 'assignment-inferred';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

function stripForwardRefQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Unwrap a single-arg generic collection wrapper — `list[User]`,
 * `set[User]`, `Iterable[User]`, `Sequence[User]`, `Iterator[User]`,
 * `Generator[User, ...]` — to its element type.
 *
 * Point: for-loop and cross-file chain propagation need the element
 * type, not the container. Multi-arg generics (`dict[str, User]`,
 * `Callable[[int], User]`) are left alone — the element semantics
 * aren't unambiguous and the scope-chain fallback handles them at
 * resolution time.
 */
function stripGeneric(text: string): string {
  const single = text.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:list|List|set|Set|tuple|Tuple|Iterable|Iterator|Sequence|Generator|AsyncIterable|AsyncIterator)\[([^,\]]+)\]$/,
  );
  if (single !== null) return single[1].trim();
  // dict[K, V] / Dict[K, V] / Mapping[K, V] — strip to value type V.
  // For-loop destructuring of `for k, v in d.items()` binds `v` to
  // `d`; the chain-follow then unwraps the dict annotation to V.
  // Single-key dict `dict[K]` is not legal Python, so two args is the
  // only shape worth handling. Match a top-level K up to the first
  // comma and a V to the closing bracket; nested generics in V (e.g.
  // `dict[str, list[User]]`) are left for a downstream strip pass.
  const dict = text.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:dict|Dict|Mapping|MutableMapping|OrderedDict|DefaultDict)\[[^,\]]+,\s*([^\]]+)\]$/,
  );
  if (dict !== null) return dict[1].trim();

  // A subscripted type the two allow-lists above did NOT claim is a
  // user-defined GENERIC, not a container: `Repo[User]`, `Handler[Req, Res]`.
  // Its base names one declaration — `Repo[User]` and `Repo[Order]` are the
  // same `class Repo(Generic[T])` — so reduce to that base, exactly as Java's
  // and Swift's interpreters already do for their `<…>` spelling (#2833).
  //
  // Guarded by a DENY set rather than reached by fallthrough, because "the two
  // rules above did not match" is NOT the same as "not a container". Two
  // measured counterexamples, both of which this branch got wrong before the
  // guard existed:
  //   - `dict[str, list[User]]` — the dict rule's value group cannot span a
  //     nested `]`, so it declines and the shape falls through. Reducing it to
  //     `dict` destroys the value type the dict rule explicitly leaves "for a
  //     downstream strip pass"; the annotation must survive intact instead.
  //   - `Callable[[int], User]`, `Literal["a"]`, `Annotated[int, F()]`,
  //     `Union[A, B]`, `tuple[int, ...]` — typing SPECIAL FORMS, not classes.
  //     Reducing them yields a bare `Callable`/`Literal`/`Union`, which binds
  //     to a workspace class of that name if one exists — a fabricated edge,
  //     and those names are ordinary enough for a real codebase to declare.
  // Anything named here keeps its as-written text and resolves as it did
  // before #2833.
  //
  // Only reached for genuine annotations: every Python `@type-binding.type`
  // capture is a `(type)`, `(identifier)`, `(attribute)` or `(dotted_name)`
  // node, so a subscripted VALUE expression (`arr[0]`) never arrives here.
  //
  // The as-written spelling is not lost — `scope-extractor` keeps it on
  // `TypeRef.declaredSpelling` whenever it differs from the reduced name,
  // which is what the receiver fold's index step reads.
  const userGeneric = text.match(/^((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*)\[.+\]$/s);
  if (userGeneric !== null) {
    const qualified = userGeneric[1].trim();
    const base = qualified.slice(qualified.lastIndexOf('.') + 1);
    if (!NOT_A_USER_GENERIC.has(base)) return qualified;
  }
  return text;
}

/**
 * Bases a subscripted annotation may carry that are NOT user-defined generics:
 * the containers the two allow-lists above already own (whose nested-value
 * shapes legitimately fall through), plus the `typing` special forms, which are
 * not classes at all. Reducing any of these to its base name would either
 * discard a value type or fabricate an edge to a same-named workspace class.
 */
const NOT_A_USER_GENERIC: ReadonlySet<string> = new Set([
  // containers owned by the single-arg and dict rules above
  'list',
  'List',
  'set',
  'Set',
  'frozenset',
  'FrozenSet',
  'tuple',
  'Tuple',
  'dict',
  'Dict',
  'Mapping',
  'MutableMapping',
  'OrderedDict',
  'DefaultDict',
  'defaultdict',
  'deque',
  'Counter',
  'ChainMap',
  'Iterable',
  'Iterator',
  'Sequence',
  'MutableSequence',
  'MutableSet',
  'AbstractSet',
  'Collection',
  'Container',
  'Reversible',
  'Generator',
  'AsyncIterable',
  'AsyncIterator',
  'AsyncGenerator',
  'Awaitable',
  'Coroutine',
  // typing special forms — not classes
  'Callable',
  'Literal',
  'Annotated',
  'Union',
  'Optional',
  'Final',
  'ClassVar',
  'Type',
  'type',
  'TypeGuard',
  'Unpack',
  'Required',
  'NotRequired',
]);

/**
 * Unwrap nullable type annotations so downstream resolution treats
 * `User | None`, `None | User`, and `Optional[User]` identically to
 * `User`. A missing/unknown variant returns the input unchanged.
 *
 * This is a syntactic strip, not a semantic parse — it handles the
 * canonical PEP-604 and `typing.Optional` shapes that cover the
 * overwhelming majority of real-world Python annotations and punts on
 * exotic unions (e.g. `User | Error`, which is ambiguous and should not
 * auto-bind to one arm).
 */
function stripNullable(text: string): string {
  // `Optional[X]` / `typing.Optional[X]` / `t.Optional[X]`
  const optMatch = text.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?Optional\[(.+)\]$/);
  if (optMatch !== null) return optMatch[1].trim();

  // Binary union forms. A three-arm or larger union (`User | None | Error`)
  // is ambiguous for single-receiver inference, so we leave it alone.
  const parts = text.split('|').map((p) => p.trim());
  if (parts.length !== 2) return text;
  if (parts[0] === 'None') return parts[1];
  if (parts[1] === 'None') return parts[0];
  return text;
}
