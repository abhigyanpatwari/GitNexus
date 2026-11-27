/**
 * Calls written inside macro arguments (#1388).
 *
 * tree-sitter-rust leaves the inside of a macro invocation as an unparsed
 * `token_tree`, so `println!("{}", helper())` has no `call_expression` for the
 * scope query to match. The arguments are parsed a second time, on their own,
 * as Rust expressions.
 *
 * No macro is expanded, so only plain expression syntax counts. Left alone:
 *  - `{ … }` invocations, which conventionally hold items or a DSL;
 *  - an argument list with any syntax error (`target: "x", …`);
 *  - macros that never evaluate their arguments (`stringify!`, `cfg!`);
 *  - the pattern half of `matches!` and friends.
 */

import type { Capture } from 'gitnexus-shared';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { getRustParser } from './query.js';

const UNEVALUATED_MACROS: ReadonlySet<string> = new Set([
  'cfg',
  'parse_quote',
  'parse_quote_spanned',
  'quote',
  'quote_spanned',
  'stringify',
]);

/** Macros whose first argument is a value and whose second is a pattern. */
const PATTERN_MACROS: ReadonlySet<string> = new Set([
  'assert_matches',
  'debug_assert_matches',
  'matches',
]);

export interface RustMacroArguments {
  /** Root of the separately parsed arguments. */
  readonly root: SyntaxNode;
  /** Where the parsed text starts, in the coordinates of the invocation. */
  readonly origin: { readonly row: number; readonly column: number };
}

/** The arguments of `invocation` as expressions, or `null` when they are not. */
export function parseRustMacroArguments(invocation: SyntaxNode): RustMacroArguments | null {
  const macro = invocation.childForFieldName('macro');
  const name = (macro?.childForFieldName('name') ?? macro)?.text;
  if (name === undefined || UNEVALUATED_MACROS.has(name)) return null;

  const tokens = invocation.namedChildren.find((child) => child.type === 'token_tree');
  if (tokens === undefined || tokens.firstChild?.type === '{') return null;
  // A call or struct literal needs its own delimiters, so a flat argument list
  // such as `("{}", total)` is not worth a parse.
  if (!tokens.namedChildren.some((child) => child.type === 'token_tree')) return null;

  let text = tokens.text;
  const origin = { row: tokens.startPosition.row, column: tokens.startPosition.column };
  if (PATTERN_MACROS.has(name)) {
    const comma = tokens.children.find((child) => child.type === ',');
    if (comma === undefined) return null;
    text = text.slice(1, comma.startIndex - tokens.startIndex);
    origin.column += 1;
  }

  const source = `${text};`;
  const root = parseSourceSafe(getRustParser(), source, undefined, {
    bufferSize: getTreeSitterBufferSize(source),
  }).rootNode;
  return root.hasError ? null : { root, origin };
}

/** `Some(_)` and `Foo::Bar(..)` parse as calls but are patterns a macro matches on. */
export function isRustPatternCall(call: SyntaxNode): boolean {
  const args = call.childForFieldName('arguments');
  if (args === null) return false;
  const isMethod = call.childForFieldName('function')?.type === 'field_expression';
  return args.namedChildren.some(
    // `items.drain(..)` is a real call; a free `Variant(..)` is a rest pattern.
    (arg) => arg.text === '_' || (!isMethod && arg.text === '..'),
  );
}

/** The leftmost name of a receiver expression: `item` in `item.owner.save()`. */
export function rustReceiverRoot(receiver: SyntaxNode): string {
  let node = receiver;
  while (node.firstNamedChild !== null) node = node.firstNamedChild;
  return node.text;
}

/** Move a capture from parsed-argument coordinates back to the invocation's. */
export function offsetRustCapture(
  capture: Capture,
  { row, column }: RustMacroArguments['origin'],
): Capture {
  const { startLine, startCol, endLine, endCol } = capture.range;
  return {
    ...capture,
    range: {
      startLine: startLine + row,
      // Only the first parsed line is shifted sideways.
      startCol: startLine === 1 ? startCol + column : startCol,
      endLine: endLine + row,
      endCol: endLine === 1 ? endCol + column : endCol,
    },
  };
}
