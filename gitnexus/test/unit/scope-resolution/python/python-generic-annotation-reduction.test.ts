/**
 * `interpretPythonTypeBinding` annotation reduction (#2833).
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
 */
import { describe, it, expect } from 'vitest';
import { interpretPythonTypeBinding } from '../../../../src/core/ingestion/languages/python/interpret.js';

/** Minimal annotation capture — the only fields the interpreter reads. */
function annotation(typeText: string): Parameters<typeof interpretPythonTypeBinding>[0] {
  return {
    '@type-binding.name': { text: 'x' },
    '@type-binding.type': { text: typeText },
    '@type-binding.annotation': { text: typeText },
  } as unknown as Parameters<typeof interpretPythonTypeBinding>[0];
}

function reduce(typeText: string): string | null {
  return interpretPythonTypeBinding(annotation(typeText))?.rawTypeName ?? null;
}

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
