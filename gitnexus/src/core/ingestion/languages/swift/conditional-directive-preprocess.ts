const SWIFT_INDENTED_CONDITIONAL_DIRECTIVE_RE = /^[ \t]+#(?:if|elseif|else|endif)\b[^\r\n]*$/;

interface SwiftPreprocessScanState {
  blockCommentDepth: number;
  multilineStringPounds: number | null;
}

function hasTripleQuoteAt(line: string, index: number): boolean {
  return line.startsWith('"""', index);
}

function rawPoundCountBeforeTripleQuote(line: string, index: number): number | null {
  if (line[index] !== '#') return null;

  let poundCount = 0;
  while (line[index + poundCount] === '#') poundCount++;
  return hasTripleQuoteAt(line, index + poundCount) ? poundCount : null;
}

function matchingMultilineCloseLength(line: string, index: number, poundCount: number): number {
  if (!hasTripleQuoteAt(line, index)) return 0;
  if (poundCount === 0) return line[index + 3] === '#' ? 0 : 3;

  const closePounds = '#'.repeat(poundCount);
  return line.startsWith(closePounds, index + 3) && line[index + 3 + poundCount] !== '#'
    ? 3 + poundCount
    : 0;
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
      } else {
        index++;
      }
      continue;
    }

    if (line.startsWith('//', index)) return;
    if (line.startsWith('/*', index)) {
      state.blockCommentDepth = 1;
      index += 2;
      continue;
    }

    const rawMultilinePounds = rawPoundCountBeforeTripleQuote(line, index);
    if (rawMultilinePounds !== null) {
      state.multilineStringPounds = rawMultilinePounds;
      index += rawMultilinePounds + 3;
      continue;
    }
    if (hasTripleQuoteAt(line, index)) {
      state.multilineStringPounds = 0;
      index += 3;
      continue;
    }

    if (line[index] === '#') {
      let rawPoundCount = 0;
      while (line[index + rawPoundCount] === '#') rawPoundCount++;
      if (line[index + rawPoundCount] === '"') {
        index = skipRegularString(line, index, rawPoundCount);
        continue;
      }
    } else if (line[index] === '"') {
      index = skipRegularString(line, index, 0);
      continue;
    }

    index++;
  }
}

function blankDirectiveLine(line: string): string {
  return line.replace(/[^\r\n]/g, ' ');
}

/**
 * Blank indented Swift conditional-compilation directives before parsing.
 *
 * tree-sitter-swift 0.7.1 does not admit these directives inside a class body,
 * so error recovery can discard the enclosing declaration. Replacing only the
 * directive text with spaces preserves source length, line endings, and all
 * declaration offsets. Top-level directives are left intact because they are
 * valid source-file members in the grammar.
 *
 * The scan tracks regular and raw multiline strings, including matching raw
 * string pound counts (`#"""` closes with `"""#`, `##"""` with `"""##`).
 * It also tracks nested block comments so comment text cannot affect string
 * state. Directive-looking lines inside block comments are still blanked: the
 * Swift parser ignores comment interiors, so this remains parse-harmless and
 * preserves the preprocessor's existing behavior. String interpolation is not
 * parsed with full Swift expression fidelity; a nested multiline string inside
 * an interpolation can therefore still confuse this light scanner.
 *
 * An unterminated multiline string conservatively keeps all subsequent lines
 * untouched through EOF. Every line is scanned independently while the small
 * lexical state carries only across line boundaries.
 */
export function preprocessSwiftConditionalDirectives(sourceText: string): string {
  const state: SwiftPreprocessScanState = {
    blockCommentDepth: 0,
    multilineStringPounds: null,
  };
  let output = '';
  let lineStart = 0;

  while (lineStart < sourceText.length) {
    const newlineIndex = sourceText.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? sourceText.length : newlineIndex;
    const line = sourceText.slice(lineStart, lineEnd);
    const lineWithoutCarriageReturn = line.endsWith('\r') ? line.slice(0, -1) : line;
    const insideMultilineString = state.multilineStringPounds !== null;

    output +=
      !insideMultilineString &&
      SWIFT_INDENTED_CONDITIONAL_DIRECTIVE_RE.test(lineWithoutCarriageReturn)
        ? blankDirectiveLine(line)
        : line;
    if (newlineIndex !== -1) output += '\n';

    scanSwiftLine(lineWithoutCarriageReturn, state);
    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  return output;
}
