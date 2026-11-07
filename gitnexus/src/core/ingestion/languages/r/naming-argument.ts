/**
 * Which argument of an R call names what the call defines or imports.
 *
 * `R_QUERIES` captures every string-valued argument of `setClass`,
 * `setRefClass`, `setGeneric` and `setMethod`, and the scope query captures every
 * identifier- or string-valued argument of `library`, `require` and `source` and
 * every string argument of `setClass`/`setRefClass`. Only one of them is the
 * definition's name or the import's source; the rest are `contains = "VIRTUAL"`,
 * `valueClass = "numeric"`, the class slot of `setMethod("show", "Foo", ...)`,
 * `lib.loc = libO`, and so on. The choice is made here, in code, rather than in the
 * query: a tree-sitter query can only skip an unbounded run of leading
 * comments and named arguments with a repeated sibling group, and that costs
 * time quadratic in the argument count on every call in the file (a single
 * `list(a0 = 0, ...)` with 16000 arguments took 18s). This check is linear: it
 * reads each argument list once and caches the answer.
 *
 * R matches arguments by name first, then positionally. The naming argument is
 * therefore the argument spelled with the call's first formal (`Class = "A"`),
 * or, when no argument anywhere in the list is spelled that way, the first
 * unnamed argument. Comments, commas and other named arguments may precede it,
 * and a `Class = ...` after an unnamed argument takes the formal from it, so
 * `setClass(a = "Q", "B", Class = "A")` names `A` only.
 *
 * A formal may be spelled bare, in backticks or in quotes (`Class`, `` `Class` ``,
 * `"Class"`); all name the same argument. Partial matching of an abbreviated
 * name (`Cl = "A"`) is not modelled.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { CaptureMap } from '../../language-provider.js';

/** The first formal of each call whose first argument names what it defines or imports. */
const NAMING_FORMAL: Readonly<Record<string, string>> = {
  setClass: 'Class',
  setRefClass: 'Class',
  setGeneric: 'name',
  setMethod: 'f',
  library: 'package',
  require: 'package',
  source: 'file',
};

/** An argument's name with one pair of surrounding backticks or quotes removed. */
function argumentNameText(name: SyntaxNode): string {
  const text = name.text;
  if (text.length >= 2) {
    const first = text[0];
    if ((first === '`' || first === '"' || first === "'") && text[text.length - 1] === first) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * Per tree, per (argument list, formal): the id of the unnamed argument that takes
 * the formal, or null when none does. One pass over the argument list answers every
 * later match in that list in constant time. Looking backwards from each match
 * instead is quadratic in the number of preceding comments (sibling lookup is
 * linear in the sibling's position), so the list is read forwards, once.
 */
const namingArgumentIds = new WeakMap<object, Map<string, number | null>>();

function namingUnnamedArgumentId(argumentList: SyntaxNode, formal: string): number | null {
  let perTree = namingArgumentIds.get(argumentList.tree);
  if (perTree === undefined) {
    perTree = new Map();
    namingArgumentIds.set(argumentList.tree, perTree);
  }
  const key = `${argumentList.id}:${formal}`;
  const cached = perTree.get(key);
  if (cached !== undefined) return cached;

  // The first unnamed argument takes the formal, unless an argument anywhere in the
  // list is spelled with it (R matches by name first), which retracts that choice.
  let found: number | null = null;
  for (const child of argumentList.namedChildren) {
    if (child.type !== 'argument') continue; // comment, comma
    const name = child.childForFieldName('name');
    if (name === null) {
      found ??= child.id;
    } else if (argumentNameText(name) === formal) {
      found = null;
      break;
    }
  }
  perTree.set(key, found);
  return found;
}

/**
 * The argument R would match to `target` in a call to a function whose formals are
 * `formals`, in order. R matches named arguments first (a name that spells a formal
 * binds it) and then fills the formals that remain from the unnamed arguments, in
 * order. Partial matching of abbreviated names (`sig =`) is not modelled. Returns
 * null when no argument reaches `target`. Linear in the argument count; meant for
 * the one call a definition hook is looking at, not for every call in a file.
 */
export function getRMatchedArgument(
  argumentList: SyntaxNode,
  formals: readonly string[],
  target: string,
): SyntaxNode | null {
  const unnamed: SyntaxNode[] = [];
  const named = new Set<string>();
  for (const child of argumentList.namedChildren) {
    if (child.type !== 'argument') continue; // comment, comma
    const name = child.childForFieldName('name');
    if (name === null) {
      unnamed.push(child);
      continue;
    }
    const text = argumentNameText(name);
    if (text === target) return child;
    named.add(text);
  }
  const remaining = formals.filter((formal) => !named.has(formal));
  const index = remaining.indexOf(target);
  return index === -1 ? null : (unnamed[index] ?? null);
}

/**
 * True when `argument` (an `argument` node) is the one that names the call's
 * definition, given the call's first `formal`.
 */
export function isRNamingArgument(argument: SyntaxNode, formal: string): boolean {
  const ownName = argument.childForFieldName('name');
  if (ownName !== null) return argumentNameText(ownName) === formal;
  const argumentList = argument.parent;
  if (argumentList === null) return false;
  return namingUnnamedArgumentId(argumentList, formal) === argument.id;
}

/**
 * True when a `R_QUERIES` match captured an argument of one of the calls above
 * that is NOT the naming argument, so the definition it would mint is spurious.
 * Matches of any other shape (R6, functions, slots, calls, imports) are never
 * skipped. The legacy `@import` matches are discarded by the parse worker, so
 * they are not considered here.
 */
export function isRNonNamingArgumentCapture(captureMap: CaptureMap): boolean {
  const fn = captureMap['_fn'];
  if (fn === undefined) return false;
  const formal = NAMING_FORMAL[fn.text];
  if (formal === undefined) return false;

  // Definitions capture the string's content. Slot matches capture a named
  // argument's identifier and are not ours.
  const captured = captureMap['name'];
  if (captured === undefined || captured.type !== 'string_content') return false;
  const argument = captured.parent?.parent;
  if (argument === undefined || argument === null || argument.type !== 'argument') return false;

  return !isRNamingArgument(argument, formal);
}

/** The captures of a raw tree-sitter match, as the scope emitter sees them. */
interface RawCapture {
  readonly name: string;
  readonly node: SyntaxNode;
}

/** Callee captures of the scope query's naming-argument patterns (`r/query.ts`). */
const SCOPE_CALLEE_CAPTURES: ReadonlySet<string> = new Set(['_s4_decl', '_srcfn', '_libfn']);

/**
 * True when a scope-query match captured an argument of `setClass` /
 * `setRefClass` (`@declaration.name`), `library` / `require` or `source`
 * (`@import.source`) that is NOT the naming argument. The scope query captures
 * every such argument; the emitter drops these matches.
 */
export function isRNonNamingScopeMatch(captures: readonly RawCapture[]): boolean {
  const fn = captures.find((c) => SCOPE_CALLEE_CAPTURES.has(c.name));
  if (fn === undefined) return false;
  const formal = NAMING_FORMAL[fn.node.text];
  if (formal === undefined) return false;

  const captured = captures.find(
    (c) => c.name === 'declaration.name' || c.name === 'import.source',
  );
  if (captured === undefined) return false;
  const argument =
    captured.node.type === 'string_content' ? captured.node.parent?.parent : captured.node.parent;
  if (argument === undefined || argument === null || argument.type !== 'argument') return false;

  return !isRNamingArgument(argument, formal);
}
