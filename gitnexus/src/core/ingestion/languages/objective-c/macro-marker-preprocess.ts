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
  inPreprocessorDirective: boolean;
  quote: '"' | "'" | undefined;
  braceDepth: number;
}

function isAsciiHorizontalWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

function isBareMarkerIdentifier(line: string): boolean {
  let index = 0;
  while (index < line.length && isAsciiHorizontalWhitespace(line.charCodeAt(index))) index++;

  const identifierStart = index;
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

  while (index < line.length && isAsciiHorizontalWhitespace(line.charCodeAt(index))) index++;
  return index === line.length;
}

function hasEscapedLineEnding(line: string): boolean {
  let trailingBackslashes = 0;
  for (let index = line.length - 1; index >= 0 && line.charCodeAt(index) === 0x5c; index--) {
    trailingBackslashes++;
  }
  return trailingBackslashes % 2 === 1;
}

function startsPreprocessorDirective(line: string): boolean {
  let index = 0;
  while (index < line.length && isAsciiHorizontalWhitespace(line.charCodeAt(index))) index++;
  return line.charCodeAt(index) === 0x23;
}

function scanLine(line: string, state: ScanState): void {
  if (state.inLineCommentContinuation) {
    state.inLineCommentContinuation = hasEscapedLineEnding(line);
    return;
  }
  if (state.inPreprocessorDirective) {
    state.inPreprocessorDirective = hasEscapedLineEnding(line);
    return;
  }
  if (startsPreprocessorDirective(line)) {
    state.inPreprocessorDirective = hasEscapedLineEnding(line);
    return;
  }

  for (let index = 0; index < line.length; index++) {
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
    if (code === 0x7b) state.braceDepth++;
    else if (code === 0x7d) state.braceDepth = Math.max(0, state.braceDepth - 1);
  }

  if (state.quote !== undefined && !hasEscapedLineEnding(line)) state.quote = undefined;
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
    inPreprocessorDirective: false,
    quote: undefined,
    braceDepth: 0,
  };
  const segments = source.split(/(\r\n|\n|\r)/);
  let changed = false;

  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index];
    if (
      !state.inBlockComment &&
      !state.inLineCommentContinuation &&
      !state.inPreprocessorDirective &&
      state.quote === undefined &&
      state.braceDepth === 0 &&
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
