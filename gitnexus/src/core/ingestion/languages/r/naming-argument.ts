/**
 * Which argument of an R S4 call names what the call defines.
 *
 * `R_QUERIES` captures every string-valued argument of `setClass`,
 * `setRefClass`, `setGeneric` and `setMethod`. Only one of them is the
 * definition's name; the rest are `contains = "VIRTUAL"`,
 * `valueClass = "numeric"`, the class slot of `setMethod("show", "Foo", ...)`,
 * and so on. The choice is made here, in code, rather than in the
 * query: a tree-sitter query can only skip an unbounded run of leading
 * comments and named arguments with a repeated sibling group, and that costs
 * time quadratic in the argument count on every call in the file (a single
 * `list(a0 = 0, ...)` with 16000 arguments took 18s). This check is linear: it
 * reads each argument list once, up to its first unnamed argument.
 *
 * R matches arguments by name first, then positionally. The naming argument is
 * therefore the argument spelled with the call's first formal (`Class = "A"`),
 * or, when no earlier argument is spelled that way, the first unnamed argument.
 * Comments, commas and other named arguments may precede it.
 *
 * A formal may be spelled bare, in backticks or in quotes (`Class`, `` `Class` ``,
 * `"Class"`); all name the same argument.
 *
 * Known limit (not fixed): a later `Class = ...` does not retract an earlier
 * unnamed argument, so `setClass(a = "Q", "B", Class = "A")` names both `B` and
 * `A`.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { CaptureMap } from '../../language-provider.js';

/** The first formal of each call whose first argument names what it defines. */
const NAMING_FORMAL: Readonly<Record<string, string>> = {
  setClass: 'Class',
  setRefClass: 'Class',
  setGeneric: 'name',
  setMethod: 'f',
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

  let found: number | null = null;
  for (const child of argumentList.namedChildren) {
    if (child.type !== 'argument') continue; // comment, comma
    const name = child.childForFieldName('name');
    if (name === null) {
      found = child.id; // the first unnamed argument takes the formal ...
      break;
    }
    if (argumentNameText(name) === formal) break; // ... unless it is given by name
  }
  perTree.set(key, found);
  return found;
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
