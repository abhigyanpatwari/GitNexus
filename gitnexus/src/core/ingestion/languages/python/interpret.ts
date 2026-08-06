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
 * Container bases whose SINGLE type argument is the element type.
 *
 * The single source of truth for both the matcher below and the property test
 * that asserts every one of them is also declined as a user generic — the two
 * lists drifting apart is the defect this arrangement exists to make
 * impossible. Order is significant only in that it is the regex alternation
 * order; keep additions grouped with their family.
 */
export const SINGLE_ARG_CONTAINERS: readonly string[] = [
  'list',
  'List',
  'set',
  'Set',
  'tuple',
  'Tuple',
  'Iterable',
  'Iterator',
  'Sequence',
  'Generator',
  'AsyncIterable',
  'AsyncIterator',
];

/** Container bases whose SECOND type argument is the value type. See {@link SINGLE_ARG_CONTAINERS}. */
export const MAPPING_CONTAINERS: readonly string[] = [
  'dict',
  'Dict',
  'Mapping',
  'MutableMapping',
  'OrderedDict',
  'DefaultDict',
];

const QUALIFIER = '(?:[A-Za-z_][A-Za-z0-9_]*\\.)?';

const SINGLE_ARG_CONTAINER_RE = new RegExp(
  `^${QUALIFIER}(?:${SINGLE_ARG_CONTAINERS.join('|')})\\[([^,\\]]+)\\]$`,
);

const MAPPING_CONTAINER_RE = new RegExp(
  `^${QUALIFIER}(?:${MAPPING_CONTAINERS.join('|')})\\[[^,\\]]+,\\s*([^\\]]+)\\]$`,
);

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
  const single = text.match(SINGLE_ARG_CONTAINER_RE);
  if (single !== null) return single[1].trim();
  // dict[K, V] / Dict[K, V] / Mapping[K, V] — strip to value type V.
  // For-loop destructuring of `for k, v in d.items()` binds `v` to
  // `d`; the chain-follow then unwraps the dict annotation to V.
  // Single-key dict `dict[K]` is not legal Python, so two args is the
  // only shape worth handling. Match a top-level K up to the first
  // comma and a V to the closing bracket; nested generics in V (e.g.
  // `dict[str, list[User]]`) are left for a downstream strip pass.
  const dict = text.match(MAPPING_CONTAINER_RE);
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
    if (!isNotAUserGenericBase(base)) return qualified;
  }
  return text;
}

/**
 * Whether a subscripted annotation's base names a Python type-system construct
 * rather than a workspace class — see {@link NOT_A_USER_GENERIC_SPELLINGS}.
 *
 * CASE-FOLDED, and that is the load-bearing part. PEP 585 gave nearly every
 * container two spellings — the builtin/`collections` one and the `typing`
 * alias (`deque` / `typing.Deque`, `frozenset` / `typing.FrozenSet`,
 * `defaultdict` / `typing.DefaultDict`) — which differ ONLY in case. Matching
 * exactly meant each pair had to be listed twice and any half-pair was a silent
 * escape: `deque` was listed, `Deque` was not, so `self.dq: Deque[User]`
 * reduced to `Deque` and bound to a workspace `class Deque` (#2855). Folding
 * case closes that axis by construction instead of by vigilance.
 *
 * The cost is that a workspace class whose name is a case VARIANT of a stdlib
 * construct (`class deque(Generic[T])`) stops reducing. PEP 8 makes such a
 * class vanishingly rare, and the loss is a missing edge — recoverable — where
 * the gain is not minting a confident wrong one.
 */
function isNotAUserGenericBase(base: string): boolean {
  return NOT_A_USER_GENERIC.has(base.toLowerCase());
}

/**
 * Bases a subscripted annotation may carry that are NOT user-defined generics.
 *
 * SCOPE — the standard library, and deliberately nothing else. The names below
 * are the documented Python type-system surface (`typing`'s deprecated PEP 585
 * aliases and its special forms, plus the stdlib classes those aliases point
 * at); that universe is CLOSED and versioned by CPython, so the list is
 * auditable against
 * <https://docs.python.org/3/library/typing.html#deprecated-aliases>.
 *
 * Third-party generics (`Mapped[int]`, `QuerySet[User]`) are NOT listed. That
 * universe is open, so enumerating it only ever chases the last escape, and
 * denying an ordinary name like `Model` would cost real edges in the many
 * projects that legitimately declare one. Those spellings still reduce to their
 * base, and the base still binds through `findClassBindingInScope`'s
 * scope-free single-match fallback — see the follow-up noted on #2855: the
 * structural fix is to prove the base is a class the FILE can see, at
 * resolution time, which this parse-time pass cannot do.
 *
 * Two distinct reasons to decline, both always-correct at this layer:
 *   - CONTAINERS, including ones the two rules above do not own. Reducing
 *     `deque[User]` to `deque` types a receiver as the container and retargets
 *     every call in a for-loop chain, and reducing `dict[str, list[User]]` to
 *     `dict` destroys the value type the dict rule leaves for a downstream pass.
 *   - `typing` SPECIAL FORMS, which are not classes at all. `Callable`,
 *     `Literal`, `Union` reduce to a bare name that binds to a workspace class
 *     of that name if one exists — a fabricated edge.
 *
 * Members are listed ONCE per case-insensitive concept: {@link
 * isNotAUserGenericBase} folds case, so the builtin spelling covers its PEP 585
 * `typing` twin (`deque` covers `Deque`, `frozenset` covers `FrozenSet`).
 * Non-generic ABCs (`Hashable`, `Sized`) are omitted — they cannot be written
 * subscripted, so they never reach this branch.
 *
 * Exported for the property test that asserts the case-fold closure holds
 * behaviourally; nothing else should read it.
 */
export const NOT_A_USER_GENERIC_SPELLINGS: readonly string[] = [
  // ── builtins subscriptable since PEP 585 ──────────────────────────────────
  'list',
  'set',
  'frozenset',
  'tuple',
  'dict',
  'type',
  // ── `collections` ─────────────────────────────────────────────────────────
  'defaultdict',
  'OrderedDict',
  'ChainMap',
  'Counter',
  'deque',
  // ── `collections.abc`, the subscriptable members ──────────────────────────
  'Mapping',
  'MutableMapping',
  'Sequence',
  'MutableSequence',
  'AbstractSet',
  'MutableSet',
  'Collection',
  'Container',
  'Reversible',
  'Iterable',
  'Iterator',
  'Generator',
  'AsyncIterable',
  'AsyncIterator',
  'AsyncGenerator',
  'Awaitable',
  'Coroutine',
  'KeysView',
  'ValuesView',
  'ItemsView',
  'MappingView',
  // ── `contextlib`, and the `typing` aliases to it ──────────────────────────
  'ContextManager',
  'AsyncContextManager',
  'AbstractContextManager',
  'AbstractAsyncContextManager',
  // ── `re`, and the `typing` aliases to it ──────────────────────────────────
  // `Pattern` and `Match` ARE classes, so reducing them is not wrong the way
  // reducing `Callable` is; they are declined because in Python annotations
  // these spellings are overwhelmingly the `re` types, while a workspace class
  // of the same name is a parser's own `Pattern`/`Match` and would be bound
  // with no import evidence whatsoever. Same policy as the receiver-chain
  // resolver's: a missing edge is recoverable, a confident wrong one is not.
  'Pattern',
  'Match',
  // ── I/O streams (`typing.IO` and its two subclasses) ──────────────────────
  'IO',
  'TextIO',
  'BinaryIO',
  // ── stdlib generic classes with ordinary names ────────────────────────────
  // Same policy call as `Pattern`/`Match` above, and the sharpest instance of
  // it: `asyncio.Task[Result]` reduces to `asyncio.Task`, whose dotted-tail
  // fallback then single-matches an unrelated workspace `class Task`.
  'Queue',
  'Task',
  'Future',
  'PathLike',
  // ── `typing` special forms — not classes ──────────────────────────────────
  'Callable',
  'Literal',
  'Annotated',
  'Union',
  'Optional',
  'Final',
  'ClassVar',
  // `typing.Type` is the PEP 585 alias for the builtin `type` listed above, and
  // the case fold already covers it — see the one-entry-per-concept rule.
  'TypeGuard',
  'TypeIs',
  'Unpack',
  'Required',
  'NotRequired',
  'ReadOnly',
  'Concatenate',
  'LiteralString',
  // ── generic machinery: bases and type-parameter declarations ──────────────
  // `Generic[T]`/`Protocol[T]` are written subscripted for real. The three
  // declaration forms are not subscriptable in valid Python, but this
  // interpreter checks no grammar — it reduces whatever text the annotation
  // capture carried — so they are declined defensively.
  'Generic',
  'Protocol',
  'TypeVar',
  'ParamSpec',
  'TypeVarTuple',
];

/** Case-folded lookup index over {@link NOT_A_USER_GENERIC_SPELLINGS}. */
const NOT_A_USER_GENERIC: ReadonlySet<string> = new Set(
  NOT_A_USER_GENERIC_SPELLINGS.map((name) => name.toLowerCase()),
);

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
