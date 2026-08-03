/**
 * A conditional-compilation directive occupying a whole line.
 *
 * `[^\S\r\n]` (horizontal whitespace) rather than `[ \t]` so NBSP /
 * ideographic-space indentation and a leading BOM are recognized too. Leading
 * whitespace is *not* required: nesting is decided from the scanner's brace
 * depth, not from indentation (a column-0 `#if` inside a class body is exactly
 * the shape that loses its enclosing declaration).
 */
const SWIFT_CONDITIONAL_DIRECTIVE_RE = /^[^\S\r\n]*#(if|elseif|else|endif)\b[^\r\n]*$/;

/**
 * Cheap whole-file precondition, mirroring `stripUeMacros`'s `HAS_UE_HINT`.
 * Derived from the line pattern so the two can never drift apart.
 */
const HAS_CONDITIONAL_DIRECTIVE_HINT = new RegExp(SWIFT_CONDITIONAL_DIRECTIVE_RE.source, 'm');

interface SwiftPreprocessScanState {
  blockCommentDepth: number;
  multilineStringPounds: number | null;
  /** Net `{` minus `}` seen in code position. May go negative on broken source. */
  braceDepth: number;
}

/**
 * An `#if` … `#endif` run. Blanking is decided per group, so a group is either
 * fully blanked or fully preserved — never half-erased.
 */
interface DirectiveGroup {
  braceDepthAtStart: number;
  /** Indices into the alternating `parts` array of this group's directive lines. */
  directiveLines: number[];
  /** Net brace delta of every branch so far — what the parser sees once all survive. */
  totalDelta: number;
  /** False as soon as one branch is not brace-balanced on its own. */
  allBranchesBalanced: boolean;
  currentBranchDelta: number;
}

function hasTripleQuoteAt(line: string, index: number): boolean {
  return line.startsWith('"""', index);
}

/**
 * Length of the multiline terminator at `index`, or 0.
 *
 * A plain `"""` string always closes at `"""`, whatever follows it — an
 * adjacent `#` is the next token, not part of the delimiter. A raw `#"""`
 * string closes at `"""` followed by *at least* its own pound count.
 */
function matchingMultilineCloseLength(line: string, index: number, poundCount: number): number {
  if (!hasTripleQuoteAt(line, index)) return 0;
  if (poundCount === 0) return 3;
  return line.startsWith('#'.repeat(poundCount), index + 3) ? 3 + poundCount : 0;
}

function skipRegularString(line: string, startIndex: number, rawPoundCount: number): number {
  const endPounds = '#'.repeat(rawPoundCount);
  let index = startIndex + (rawPoundCount > 0 ? rawPoundCount + 1 : 1);

  while (index < line.length) {
    if (line[index] === '"') {
      if (rawPoundCount === 0) return index + 1;
      if (line.startsWith(endPounds, index + 1)) return index + 1 + rawPoundCount;
    }
    if (rawPoundCount === 0 && line[index] === '\\') index++;
    index++;
  }

  return line.length;
}

/**
 * Skip an extended regex literal (`#/…/#`), whose body may legally contain
 * `/*` — which would otherwise open a block comment that never closes.
 * `slashIndex` points at the `/` that follows the opening pound run.
 */
function skipExtendedRegexLiteral(line: string, slashIndex: number, poundCount: number): number {
  const closePounds = '#'.repeat(poundCount);
  let index = slashIndex + 1;

  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === '/' && line.startsWith(closePounds, index + 1)) {
      return index + 1 + poundCount;
    }
    index++;
  }

  return line.length;
}

function scanSwiftLine(line: string, state: SwiftPreprocessScanState): void {
  let index = 0;

  while (index < line.length) {
    if (state.blockCommentDepth > 0) {
      if (line.startsWith('/*', index)) {
        state.blockCommentDepth++;
        index += 2;
      } else if (line.startsWith('*/', index)) {
        state.blockCommentDepth--;
        index += 2;
      } else {
        index++;
      }
      continue;
    }

    if (state.multilineStringPounds !== null) {
      const closeLength = matchingMultilineCloseLength(line, index, state.multilineStringPounds);
      if (closeLength > 0) {
        state.multilineStringPounds = null;
        index += closeLength;
        continue;
      }
      // Non-raw multiline strings honour backslash escapes, so `\"""` is string
      // data and not a terminator. Raw strings escape with `\#`, so a bare
      // backslash there is literal.
      index += state.multilineStringPounds === 0 && line[index] === '\\' ? 2 : 1;
      continue;
    }

    if (line.startsWith('//', index)) return;
    if (line.startsWith('/*', index)) {
      state.blockCommentDepth = 1;
      index += 2;
      continue;
    }

    if (line[index] === '#') {
      // Count the pound run exactly once and always advance past it, so a long
      // run of bare `#` stays linear instead of being re-walked per character.
      let poundCount = 1;
      while (line[index + poundCount] === '#') poundCount++;
      const afterPounds = index + poundCount;

      if (hasTripleQuoteAt(line, afterPounds)) {
        state.multilineStringPounds = poundCount;
        index = afterPounds + 3;
      } else if (line[afterPounds] === '"') {
        index = skipRegularString(line, index, poundCount);
      } else if (line[afterPounds] === '/') {
        index = skipExtendedRegexLiteral(line, afterPounds, poundCount);
      } else {
        index = afterPounds;
      }
      continue;
    }

    if (hasTripleQuoteAt(line, index)) {
      state.multilineStringPounds = 0;
      index += 3;
      continue;
    }
    if (line[index] === '"') {
      index = skipRegularString(line, index, 0);
      continue;
    }

    if (line[index] === '{') state.braceDepth++;
    else if (line[index] === '}') state.braceDepth--;
    index++;
  }
}

/**
 * Blank nested Swift conditional-compilation directives before parsing.
 *
 * tree-sitter-swift 0.7.1 does not admit `directive` as a `class_body` child
 * (`vendor/tree-sitter-swift/src/node-types.json`), so error recovery can
 * discard the enclosing declaration. Replacing only the directive text with
 * spaces preserves `.length`, line endings, and every declaration offset.
 *
 * ponytail: delete this file (and the `preprocessSource` wiring in `swift.ts`)
 * once a vendored tree-sitter-swift release includes upstream PR #583 ("Allow
 * #if/#elseif/#else/#endif directives inside type bodies"); see also upstream
 * issue #298 and PR #599. `.github/vendored-grammars.json` has no `"hold"` on
 * swift, so the bump bot will land that release on its own.
 *
 * A directive group is blanked only when **all** of these hold:
 *
 *   - it opens at `braceDepth > 0` — nesting, not indentation, is what the
 *     grammar rejects; top-level directives are valid source-file members and
 *     are left intact
 *   - it is not inside a multiline string literal or a block comment — blanking
 *     a line that carries a block-comment terminator would un-terminate the
 *     comment and swallow the rest of the file, and blanking inside a literal
 *     would rewrite program data
 *   - every branch is brace-balanced. A group that splits a declaration header
 *     (`#if` … `func f() async {` … `#else` … `func f() {` … `#endif`) leaves
 *     one unmatched `{` once both branches survive, which re-parents every
 *     later top-level declaration. Such a group degrades to the pre-fix
 *     behavior instead.
 *
 * Known residuals, all of which degrade to "directive left in place" rather
 * than to corrupted output: string interpolation is not parsed with full Swift
 * expression fidelity, so a nested multiline string inside an interpolation can
 * confuse the scanner; a bare `/…/` regex literal containing `/*` opens a
 * phantom block comment; and a multiline extended regex literal is treated as
 * ending at its first line.
 *
 * Byte length is *not* preserved when a blanked directive line carries
 * non-ASCII trailing text (`  #if os(iOS) // 日本語 🔥` is 23 UTF-16 code units
 * either way, but shrinks from 31 UTF-8 bytes to 23). C++ sidesteps this
 * because UE macro tokens are ASCII-only; a Swift directive line can carry any
 * trailing comment. Per the `LanguageProvider.preprocessSource` contract this is
 * safe only while no consumer slices the original UTF-8 bytes by `startIndex`:
 * node-tree-sitter reports UTF-16 code-unit indices, and every in-process
 * consumer slices the JS string, whose `.length` *is* preserved.
 *
 * Must stay pure and idempotent — see `LanguageProvider.preprocessSource`.
 */
export function preprocessSwiftConditionalDirectives(sourceText: string): string {
  if (!HAS_CONDITIONAL_DIRECTIVE_HINT.test(sourceText)) return sourceText;

  // Alternating [line, terminator, line, terminator, …, line]; joining it back
  // reproduces the input byte for byte, including bare-`\r` endings.
  const parts = sourceText.split(/(\r\n|\n|\r)/);
  const state: SwiftPreprocessScanState = {
    blockCommentDepth: 0,
    multilineStringPounds: null,
    braceDepth: 0,
  };
  const openGroups: DirectiveGroup[] = [];
  let blankedAny = false;

  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index]!;
    const insideLiteralOrComment =
      state.multilineStringPounds !== null || state.blockCommentDepth > 0;
    const match = insideLiteralOrComment ? null : SWIFT_CONDITIONAL_DIRECTIVE_RE.exec(text);

    const braceDepthAtStart = state.braceDepth;
    scanSwiftLine(text, state);
    const braceDelta = state.braceDepth - braceDepthAtStart;

    const openGroup = openGroups[openGroups.length - 1];
    if (match === null) {
      if (openGroup !== undefined) openGroup.currentBranchDelta += braceDelta;
      continue;
    }

    // Directive lines are blanked as a unit, so their own braces (if any) never
    // reach the parser and must not count toward a branch's balance.
    if (match[1] === 'if') {
      openGroups.push({
        braceDepthAtStart,
        directiveLines: [index],
        totalDelta: 0,
        allBranchesBalanced: true,
        currentBranchDelta: 0,
      });
      continue;
    }
    // A `#else`/`#endif` with no open `#if` is malformed source — leave it be.
    if (openGroup === undefined) continue;

    openGroup.directiveLines.push(index);
    openGroup.totalDelta += openGroup.currentBranchDelta;
    openGroup.allBranchesBalanced &&= openGroup.currentBranchDelta === 0;
    openGroup.currentBranchDelta = 0;
    if (match[1] !== 'endif') continue;

    openGroups.pop();
    const parentGroup = openGroups[openGroups.length - 1];
    // Every branch survives preprocessing, so the enclosing branch sees the sum
    // — not one branch's delta.
    if (parentGroup !== undefined) parentGroup.currentBranchDelta += openGroup.totalDelta;

    if (openGroup.braceDepthAtStart > 0 && openGroup.allBranchesBalanced) {
      // Safe to mutate in place: every line of this group has already been
      // scanned, and the decision never reopens.
      for (const line of openGroup.directiveLines) parts[line] = ' '.repeat(parts[line]!.length);
      blankedAny = true;
    }
  }

  return blankedAny ? parts.join('') : sourceText;
}
