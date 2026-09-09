/**
 * Normalize bare file-scope Objective-C macro markers before parsing.
 *
 * Headers commonly use macro pairs such as `RCT_EXTERN_C_BEGIN` and
 * `RCT_EXTERN_C_END` around C declarations. tree-sitter-objc does not expand
 * those macros; a bare invocation can put the parser into error recovery and
 * hide every Objective-C declaration that follows it. These markers do not
 * contribute syntax on their own, so we replace only the narrow, generic form
 * with spaces before parsing.
 *
 * This is deliberately not macro expansion or a framework-specific allowlist:
 * a candidate must be a whole, all-caps identifier at file scope. Function-like
 * macros, directives, statements, strings, and comments remain untouched.
 * Replacement preserves UTF-16 length and line endings exactly. Candidates are
 * ASCII-only, so their byte offsets are preserved as well.
 */

interface ScanState {
  inBlockComment: boolean;
  inLineCommentContinuation: boolean;
  inCodeLineContinuation: boolean;
  inPreprocessorDirective: boolean;
  quote: '"' | "'" | undefined;
  braceDepth: number;
  parenDepth: number;
  objcDeclDepth: number;
}

function isPreprocessorWhitespace(code: number): boolean {
  // C preprocessing whitespace includes space, horizontal tab, vertical tab,
  // and form feed. Newlines are split before this scanner sees a line.
  return code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c;
}

function isBareMarkerIdentifier(line: string): boolean {
  let index = 0;
  while (index < line.length && isPreprocessorWhitespace(line.charCodeAt(index))) index++;

  const identifierStart = index;
  const first = line.charCodeAt(index);
  if (!((first >= 0x41 && first <= 0x5a) || first === 0x5f)) return false;

  let hasUppercaseLetter = false;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code >= 0x41 && code <= 0x5a) {
      hasUppercaseLetter = true;
      index++;
      continue;
    }
    if ((code >= 0x30 && code <= 0x39) || code === 0x5f) {
      index++;
      continue;
    }
    break;
  }
  if (index === identifierStart || !hasUppercaseLetter) return false;

  while (index < line.length && isPreprocessorWhitespace(line.charCodeAt(index))) index++;
  return index === line.length;
}

function isIdentifierContinue(line: string, index: number): boolean {
  if (index >= line.length) return false;
  const code = line.charCodeAt(index);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f
  );
}

function leadingObjCDeclKeyword(line: string): 'begin' | 'end' | null {
  let index = 0;
  while (index < line.length) {
    while (index < line.length && isPreprocessorWhitespace(line.charCodeAt(index))) index++;
    if (line.startsWith('//', index)) return null;
    if (line.startsWith('/*', index)) {
      const blockCommentEnd = line.indexOf('*/', index + 2);
      if (blockCommentEnd < 0) return null;
      index = blockCommentEnd + 2;
      continue;
    }
    break;
  }
  if (line.startsWith('@end', index) && !isIdentifierContinue(line, index + 4)) return 'end';
  for (const keyword of ['@interface', '@protocol', '@implementation'] as const) {
    if (line.startsWith(keyword, index) && !isIdentifierContinue(line, index + keyword.length)) {
      return 'begin';
    }
  }
  return null;
}

function hasEscapedLineEnding(line: string): boolean {
  let trailingBackslashes = 0;
  for (let index = line.length - 1; index >= 0 && line.charCodeAt(index) === 0x5c; index--) {
    trailingBackslashes++;
  }
  return trailingBackslashes % 2 === 1;
}

function startsPreprocessorDirective(line: string, state: ScanState): boolean {
  let index = 0;
  let inBlockComment = state.inBlockComment;

  while (index < line.length) {
    if (inBlockComment) {
      const blockCommentEnd = line.indexOf('*/', index);
      if (blockCommentEnd < 0) return false;
      inBlockComment = false;
      index = blockCommentEnd + 2;
      continue;
    }

    while (index < line.length && isPreprocessorWhitespace(line.charCodeAt(index))) index++;
    if (line.startsWith('/*', index)) {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (line.startsWith('//', index)) return false;
    if (line.charCodeAt(index) !== 0x23) return false;

    state.inBlockComment = false;
    return true;
  }

  return false;
}

function scanBalancedDelimiters(code: number, state: ScanState): void {
  if (code === 0x28) state.parenDepth++;
  else if (code === 0x29) state.parenDepth = Math.max(0, state.parenDepth - 1);
  else if (code === 0x7b) state.braceDepth++;
  else if (code === 0x7d) state.braceDepth = Math.max(0, state.braceDepth - 1);
}

function scanLineBody(
  line: string,
  state: ScanState,
  startIndex: number,
  trackDelimiters: boolean,
): void {
  for (let index = startIndex; index < line.length; index++) {
    const code = line.charCodeAt(index);
    const next = line.charCodeAt(index + 1);

    if (state.inBlockComment) {
      if (code === 0x2a && next === 0x2f) {
        state.inBlockComment = false;
        index++;
      }
      continue;
    }

    if (state.quote !== undefined) {
      if (code === 0x5c) {
        index++;
      } else if (line[index] === state.quote) {
        state.quote = undefined;
      }
      continue;
    }

    if (code === 0x2f && next === 0x2f) {
      state.inLineCommentContinuation = hasEscapedLineEnding(line);
      return;
    }
    if (code === 0x2f && next === 0x2a) {
      state.inBlockComment = true;
      index++;
      continue;
    }
    if (code === 0x22 || code === 0x27) {
      state.quote = line[index] as '"' | "'";
      continue;
    }
    // Directive replacement text is tokens, not C scopes. `{` in
    // `#define WRAP {` must not pin braceDepth for later file-scope markers.
    if (trackDelimiters) scanBalancedDelimiters(code, state);
  }
}

function scanDirectiveLine(line: string, state: ScanState): void {
  const continued = hasEscapedLineEnding(line);
  scanLineBody(line, state, 0, false);
  state.inPreprocessorDirective = continued;
  // A quote opened in replacement text does not survive past the directive.
  if (!continued) state.quote = undefined;
}

function scanLine(line: string, state: ScanState): void {
  if (state.inLineCommentContinuation) {
    state.inLineCommentContinuation = hasEscapedLineEnding(line);
    // A `// ... \` splice keeps the next physical line in the comment, but the
    // directive ends unless that line is itself backslash-continued.
    if (state.inPreprocessorDirective) {
      state.inPreprocessorDirective = state.inLineCommentContinuation;
    }
    return;
  }
  if (state.inPreprocessorDirective) {
    scanDirectiveLine(line, state);
    return;
  }
  if (startsPreprocessorDirective(line, state)) {
    // Directives can open a block comment (`#define X /*`) that continues
    // onto the next physical line. Scan comment/quote state only.
    scanDirectiveLine(line, state);
    return;
  }

  if (state.inCodeLineContinuation) {
    scanLineBody(line, state, 0, true);
    if (state.quote !== undefined && !hasEscapedLineEnding(line)) state.quote = undefined;
    state.inCodeLineContinuation =
      !state.inLineCommentContinuation && !state.inBlockComment && hasEscapedLineEnding(line);
    return;
  }

  const keyword = leadingObjCDeclKeyword(line);
  if (keyword === 'begin') state.objcDeclDepth++;
  else if (keyword === 'end') state.objcDeclDepth = Math.max(0, state.objcDeclDepth - 1);

  scanLineBody(line, state, 0, true);

  if (state.quote !== undefined && !hasEscapedLineEnding(line)) state.quote = undefined;
  // Line-comment `\` continuation is not a C splice; it must not suppress
  // the next physical line's file-scope marker test.
  state.inCodeLineContinuation =
    !state.inLineCommentContinuation && !state.inBlockComment && hasEscapedLineEnding(line);
}

/**
 * Elide bare, file-scope macro markers while preserving source positions.
 *
 * `_filePath` is accepted for the LanguageProvider hook signature. The
 * transform is based only on source syntax and deliberately has no framework
 * or repository-specific configuration.
 */
export function preprocessObjectiveCMacroMarkers(source: string, _filePath?: string): string {
  const state: ScanState = {
    inBlockComment: false,
    inLineCommentContinuation: false,
    inCodeLineContinuation: false,
    inPreprocessorDirective: false,
    quote: undefined,
    braceDepth: 0,
    parenDepth: 0,
    objcDeclDepth: 0,
  };
  const segments = source.split(/(\r\n|\n|\r)/);
  let changed = false;

  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index];
    if (
      !state.inBlockComment &&
      !state.inLineCommentContinuation &&
      !state.inCodeLineContinuation &&
      !state.inPreprocessorDirective &&
      state.quote === undefined &&
      state.braceDepth === 0 &&
      state.parenDepth === 0 &&
      state.objcDeclDepth === 0 &&
      isBareMarkerIdentifier(line)
    ) {
      segments[index] = ' '.repeat(line.length);
      changed = true;
      continue;
    }
    scanLine(line, state);
  }

  return changed ? segments.join('') : source;
}
