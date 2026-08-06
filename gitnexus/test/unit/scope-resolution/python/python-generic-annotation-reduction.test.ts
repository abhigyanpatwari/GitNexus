/**
 * `interpretPythonTypeBinding` annotation reduction (#2833, #2855).
 *
 * Python spells type application with SQUARE brackets, so the reduction that
 * makes `Repo[User]` usable as a receiver type shares its syntax with three
 * other things that must NOT be reduced the same way:
 *
 *   - a CONTAINER, which reduces to its ELEMENT (`list[User]` -> `User`), never
 *     to its base — reducing to `list` would type a receiver as the container
 *     and retarget every call in a for-loop chain;
 *   - a container shape the container rules decline, notably a nested value
 *     (`dict[str, list[User]]`): the dict rule's value group cannot span a
 *     nested `]`, so it falls through, and the annotation must survive INTACT
 *     for the downstream strip pass rather than collapsing to `dict`;
 *   - a `typing` SPECIAL FORM (`Callable`, `Literal`, `Annotated`, `Union`),
 *     which is not a class at all. Reducing one yields a bare `Callable` or
 *     `Literal`, which binds to a workspace class of that name if the codebase
 *     declares one — a fabricated edge, and those names are ordinary enough to
 *     collide for real.
 *
 * Every row below was measured against the implementation; the three groups
 * exist because the first cut of #2833 reduced by fallthrough alone and got the
 * last two wrong.
 *
 * ── The #2855 lesson ──────────────────────────────────────────────────────
 * The first cut of that guard was a hand-written deny set checked by EXACT
 * match, and the tests asserted members OF THAT SET — tautological with respect
 * to omissions, so every name nobody thought of escaped silently. `Deque` was
 * the proof: its lowercase twin `deque` was listed, `Deque` was not, and
 * `self.dq: Deque[User]` reduced to `Deque` and bound to a workspace
 * `class Deque`.
 *
 * The tests below are therefore written so that an OMISSION fails, not just a
 * regression on a name someone already remembered. Each derives its inputs from
 * something other than the deny set's own membership:
 *   - `PEP_585_TYPING_ALIASES` comes from the CPython documentation, not the
 *     implementation;
 *   - the case-fold closure derives spellings mechanically from every listed
 *     name, so a half-listed pair fails;
 *   - the container coverage derives from the two container-matcher name
 *     arrays, so adding a container without declining it fails.
 */
import { describe, it, expect } from 'vitest';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  interpretPythonTypeBinding,
  NOT_A_USER_GENERIC_SPELLINGS,
  SINGLE_ARG_CONTAINERS,
  MAPPING_CONTAINERS,
} from '../../../../src/core/ingestion/languages/python/interpret.js';

const ZERO_RANGE = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 } as const;
const cap = (name: string, text: string): Capture => ({ name, text, range: ZERO_RANGE });

/** Minimal annotation capture — the only fields the interpreter reads. */
function annotation(typeText: string): CaptureMatch {
  return {
    '@type-binding.name': cap('@type-binding.name', 'x'),
    '@type-binding.type': cap('@type-binding.type', typeText),
    '@type-binding.annotation': cap('@type-binding.annotation', typeText),
  };
}

function reduce(typeText: string): string | null {
  return interpretPythonTypeBinding(annotation(typeText))?.rawTypeName ?? null;
}

/**
 * A subscripted shape BOTH container rules decline: the single-arg rule's
 * element group cannot span a comma, and the mapping rule's value group cannot
 * span the nested `]`. So every name reaches the last-resort user-generic
 * branch, and the only thing that can stop it collapsing to the bare base is
 * being declined as a non-user-generic. One probe, uniform across every name,
 * whatever that name's real arity.
 */
const probe = (base: string): string | null => reduce(`${base}[str, list[User]]`);

/** The names from `names` that the last-resort branch collapsed to a bare base. */
const collapsing = (names: readonly string[]): readonly string[] =>
  names.filter((name) => probe(name) === name);

const capitalize = (name: string): string =>
  name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

describe('Python annotation reduction (#2833)', () => {
  it('reduces a user-defined generic to the declaration its base names', () => {
    expect({
      simple: reduce('Repo[User]'),
      qualified: reduce('mod.Repo[User]'),
      multiArg: reduce('Handler[Req, Res]'),
      nullable: reduce('Optional[Repo[User]]'),
      unionNullable: reduce('Repo[User] | None'),
    }).toEqual({
      simple: 'Repo',
      qualified: 'mod.Repo',
      multiArg: 'Handler',
      nullable: 'Repo',
      unionNullable: 'Repo',
    });
  });

  it('still reduces a container to its ELEMENT, never to its base', () => {
    expect({
      list: reduce('list[User]'),
      List: reduce('List[User]'),
      sequence: reduce('Sequence[User]'),
      dict: reduce('dict[str, User]'),
    }).toEqual({ list: 'User', List: 'User', sequence: 'User', dict: 'User' });
  });

  // The regression the deny set exists for. Without it these collapse to the
  // CONTAINER name, destroying the value type the dict rule deliberately leaves
  // for a downstream pass.
  it('leaves a container shape its own rules declined completely intact', () => {
    expect({
      nestedValue: reduce('dict[str, list[User]]'),
      nestedGenericValue: reduce('Dict[str, Repo[User]]'),
      variadicTuple: reduce('tuple[int, ...]'),
    }).toEqual({
      nestedValue: 'dict[str, list[User]]',
      nestedGenericValue: 'Dict[str, Repo[User]]',
      variadicTuple: 'tuple[int, ...]',
    });
  });

  // Reducing these would bind a receiver to a workspace class that merely
  // shares a name with a typing construct — a fabricated edge, and strictly
  // worse than the missing edge #2833 set out to fix.
  it('never reduces a typing special form to its base name', () => {
    expect({
      callable: reduce('Callable[[int], User]'),
      literal: reduce('Literal["a"]'),
      annotated: reduce('Annotated[int, Field()]'),
      union: reduce('Union[A, B]'),
    }).toEqual({
      callable: 'Callable[[int], User]',
      literal: 'Literal["a"]',
      annotated: 'Annotated[int, Field()]',
      union: 'Union[A, B]',
    });
  });

  it('leaves an unsubscripted or malformed annotation alone', () => {
    expect({ plain: reduce('User'), empty: reduce('Repo[]') }).toEqual({
      plain: 'User',
      empty: 'Repo[]',
    });
  });
});

describe('Python annotation reduction — non-user-generic bases (#2855)', () => {
  // The sharpest escape, and the reason the closure test below exists: this is
  // not a judgement call about an exotic name, it is an INTERNAL INCONSISTENCY.
  // `deque` was declined; its own `typing` alias was not. End to end: with a
  // workspace `class Deque`, `self.dq: Deque[User]` followed by
  // `self.dq.appendleft(x)` emitted a fabricated `Deque.appendleft` edge.
  it('declines a `typing` alias whose lowercase twin is already declined', () => {
    expect({ builtinSpelling: reduce('deque[User]'), typingAlias: reduce('Deque[User]') }).toEqual({
      builtinSpelling: 'deque[User]',
      typingAlias: 'Deque[User]',
    });
  });

  /**
   * The `typing` deprecated aliases to `builtins` and `collections`, from
   * <https://docs.python.org/3/library/typing.html#deprecated-aliases> — an
   * EXTERNAL source of truth, which is what makes this test able to fail on a
   * name the implementation forgot. Listed here because `capitalize` cannot
   * derive the multi-word spellings (`frozenset` -> `FrozenSet`) that the
   * mechanical closure below approximates.
   */
  const PEP_585_TYPING_ALIASES: readonly string[] = [
    'List',
    'Set',
    'FrozenSet',
    'Tuple',
    'Dict',
    'Type',
    'DefaultDict',
    'OrderedDict',
    'ChainMap',
    'Counter',
    'Deque',
    'Pattern',
    'Match',
    'ContextManager',
    'AsyncContextManager',
  ];

  it('declines every documented PEP 585 `typing` alias', () => {
    expect(collapsing(PEP_585_TYPING_ALIASES)).toEqual([]);
  });

  /**
   * The property that makes the whole bug class mechanical. PEP 585 gave nearly
   * every container two spellings differing ONLY in case, so a deny set matched
   * exactly had to carry both and any half-pair was a silent escape. Deriving
   * the spellings from every listed name means a half-pair cannot survive
   * review — which is exactly how `Deque` would have been caught for free.
   *
   * `capitalize` is a deliberately over-inclusive approximation of the `typing`
   * alias spelling: it yields `Deque` from `deque` (the case that mattered) and
   * `Frozenset` from `frozenset` (not the real alias, but declining it is
   * harmless and the real `FrozenSet` is pinned by the table above).
   */
  it('declines every case spelling of every non-user-generic it lists', () => {
    const spellings = NOT_A_USER_GENERIC_SPELLINGS.flatMap((name) => [
      name,
      name.toLowerCase(),
      capitalize(name),
    ]);
    expect(collapsing([...new Set(spellings)])).toEqual([]);
  });

  /**
   * The other direction: a container the matchers OWN must also be declined as
   * a user generic, because a shape those matchers decline (a nested value)
   * falls through to the last-resort branch. Derived from the matcher's own
   * name arrays, so adding a container to the matcher without declining it
   * fails here rather than silently destroying its element type.
   */
  it('declines every container its own matchers name', () => {
    expect(collapsing([...SINGLE_ARG_CONTAINERS, ...MAPPING_CONTAINERS])).toEqual([]);
  });

  // The families measured escaping in the #2855 review, one representative row
  // per family, asserted end to end rather than through the deny set.
  it('leaves the stdlib type-system surface intact', () => {
    expect({
      collectionsView: reduce('KeysView[User]'),
      mappingView: reduce('MappingView[User]'),
      contextManager: reduce('ContextManager[User]'),
      genericBase: reduce('Generic[T]'),
      protocolBase: reduce('Protocol[T]'),
      narrowingForm: reduce('TypeIs[User]'),
      typedDictQualifier: reduce('ReadOnly[int]'),
      paramSpecForm: reduce('Concatenate[int, P]'),
      qualifiedRePattern: reduce('re.Pattern[str]'),
      ioStream: reduce('BinaryIO[str]'),
      stdlibQueue: reduce('Queue[User]'),
      qualifiedAsyncioTask: reduce('asyncio.Task[User]'),
    }).toEqual({
      collectionsView: 'KeysView[User]',
      mappingView: 'MappingView[User]',
      contextManager: 'ContextManager[User]',
      genericBase: 'Generic[T]',
      protocolBase: 'Protocol[T]',
      narrowingForm: 'TypeIs[User]',
      typedDictQualifier: 'ReadOnly[int]',
      paramSpecForm: 'Concatenate[int, P]',
      qualifiedRePattern: 're.Pattern[str]',
      ioStream: 'BinaryIO[str]',
      stdlibQueue: 'Queue[User]',
      qualifiedAsyncioTask: 'asyncio.Task[User]',
    });
  });

  /**
   * The deliberate BOUNDARY of the deny set, pinned so it is a decision rather
   * than an oversight. Third-party generics keep reducing: that universe is
   * open, enumerating it only ever chases the last escape, and declining an
   * ordinary name like `Model` would cost real edges in the many projects that
   * declare one. These reductions are also semantically CORRECT — the base does
   * name the declaration. What is not correct is the resolution-side binding of
   * that base by `findClassBindingInScope`'s scope-free single-match fallback,
   * which is where the follow-up to #2855 belongs.
   */
  it('still reduces a third-party generic, by design', () => {
    expect({
      sqlalchemy: reduce('Mapped[int]'),
      django: reduce('QuerySet[User]'),
      ordinaryName: reduce('Model[User]'),
    }).toEqual({ sqlalchemy: 'Mapped', django: 'QuerySet', ordinaryName: 'Model' });
  });
});
