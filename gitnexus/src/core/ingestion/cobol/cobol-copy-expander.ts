/**
 * COBOL COPY statement expansion engine.
 *
 * Expands COPY statements by inlining copybook content, applying REPLACING
 * transformations (LEADING, TRAILING, EXACT), and handling nested copies
 * with cycle detection.
 *
 * This is a preprocessing step that runs BEFORE extractCobolSymbolsWithRegex.
 * The caller should run preprocessCobolSource first to clean patch markers.
 *
 * Supported syntax:
 *   COPY CPSESP.
 *   COPY "WORKGRID.CPY".
 *   COPY CPSESP REPLACING LEADING "ESP-" BY "LK-ESP-"
 *                         LEADING "KPSESPL" BY "LK-KPSESPL".
 *   COPY ANAZI REPLACING "ANAZI-KEY" BY "LK-KEY".
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CopyReplacing {
  type: 'LEADING' | 'TRAILING' | 'EXACT';
  from: string;
  to: string;
  isPseudotext?: boolean;
}

export interface CopyResolution {
  copyTarget: string;
  resolvedPath: string | null;
  line: number;
  replacing: CopyReplacing[];
  library?: string;
}

export interface CopyExpansionResult {
  expandedContent: string;
  copyResolutions: CopyResolution[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_DEPTH = 10;

/** COBOL identifier pattern: starts with letter, contains letters, digits, hyphens. */
const RE_COBOL_IDENTIFIER = /\b([A-Z][A-Z0-9-]*)\b/gi;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Strip inline comments (Italian-style `|` comments).
 * Only strips if `|` appears in the code area (col 7+).
 */
function stripInlineComment(line: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '|') {
      return line.substring(0, i);
    }
  }
  return line;
}

/**
 * Check if a line is a COBOL comment (indicator in col 7 is `*` or `/`).
 */
function isCommentLine(line: string): boolean {
  return line.length >= 7 && (line[6] === '*' || line[6] === '/');
}

/**
 * Check if a line is a continuation line (indicator in col 7 is `-`).
 */
function isContinuationLine(line: string): boolean {
  return line.length >= 7 && line[6] === '-';
}

/**
 * Merge continuation lines into their predecessors.
 * Returns an array of logical lines with their original starting line numbers.
 */
function mergeLogicalLines(rawLines: string[]): Array<{ text: string; lineNum: number }> {
  const logical: Array<{ text: string; lineNum: number }> = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];

    // Skip comment lines
    if (isCommentLine(raw)) {
      logical.push({ text: '', lineNum: i + 1 });
      continue;
    }

    // Continuation: merge into previous logical line
    if (isContinuationLine(raw)) {
      if (logical.length > 0) {
        const prev = logical[logical.length - 1];
        const continuation = raw.length > 7 ? raw.substring(7).trimStart() : '';
        prev.text += continuation;
      }
      // Push empty placeholder to preserve line count
      logical.push({ text: '', lineNum: i + 1 });
      continue;
    }

    // Normal line: strip inline comments
    const cleaned = stripInlineComment(raw);
    logical.push({ text: cleaned, lineNum: i + 1 });
  }

  return logical;
}

// ---------------------------------------------------------------------------
// COPY statement parsing
// ---------------------------------------------------------------------------

interface ParsedCopyStatement {
  startLine: number;
  endLine: number;
  target: string;
  replacing: CopyReplacing[];
  library?: string;
}

/**
 * Parse REPLACING clause text into structured replacements.
 *
 * Input examples:
 *   LEADING "ESP-" BY "LK-ESP-" LEADING "KPSESPL" BY "LK-KPSESPL"
 *   "ANAZI-KEY" BY "LK-KEY"
 *   TRAILING "-IN" BY "-OUT"
 *   ==CUST-== BY ==WS-CUST-==
 *   ==OLD-TEXT== BY ====
 */
export function parseReplacingClause(text: string): CopyReplacing[] {
  const replacings: CopyReplacing[] = [];
  if (!text || text.trim().length === 0) return replacings;

  // Tokenize: ==pseudotext==, "quoted strings", or bare words.
  // Pseudotext can contain spaces and single = chars but not ==.
  interface TokenInfo {
    value: string;
    isPseudotext: boolean;
  }
  const tokens: TokenInfo[] = [];
  const tokenRe = /==((?:[^=]|=[^=])*)==|"([^"]*)"|(\S+)/g;
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(text)) !== null) {
    if (tm[1] !== undefined) {
      // Pseudotext: trim leading/trailing whitespace
      tokens.push({ value: tm[1].trim(), isPseudotext: true });
    } else if (tm[2] !== undefined) {
      tokens.push({ value: tm[2], isPseudotext: false });
    } else {
      tokens.push({ value: tm[3], isPseudotext: false });
    }
  }

  // Parse token stream: [LEADING|TRAILING]? <from> BY <to>
  let i = 0;
  while (i < tokens.length) {
    let type: CopyReplacing['type'] = 'EXACT';

    // Check for type modifier (only on non-pseudotext tokens)
    if (!tokens[i].isPseudotext) {
      const upper = tokens[i].value.toUpperCase();
      if (upper === 'LEADING') {
        type = 'LEADING';
        i++;
      } else if (upper === 'TRAILING') {
        type = 'TRAILING';
        i++;
      }
    }

    if (i >= tokens.length) break;
    const fromToken = tokens[i];
    i++;

    // Pseudotext always forces EXACT type
    if (fromToken.isPseudotext) type = 'EXACT';

    // Expect BY keyword
    if (i >= tokens.length) break;
    if (tokens[i].value.toUpperCase() !== 'BY') {
      // Malformed — skip this token and try to resync
      continue;
    }
    i++; // skip BY

    if (i >= tokens.length) break;
    const toToken = tokens[i];
    i++;

    replacings.push({
      type,
      from: fromToken.value,
      to: toToken.value,
      isPseudotext: fromToken.isPseudotext || undefined,
    });
  }

  return replacings;
}

/**
 * Scan logical lines for COPY statements.
 * COPY statements can span multiple lines and terminate with a period.
 */
function parseCopyStatements(
  logicalLines: Array<{ text: string; lineNum: number }>,
): ParsedCopyStatement[] {
  const results: ParsedCopyStatement[] = [];

  let accumulator: string | null = null;
  let startLine = 0;
  let endLine = 0;

  for (let i = 0; i < logicalLines.length; i++) {
    const { text, lineNum } = logicalLines[i];
    if (text.length === 0) continue;

    // Check for COPY keyword start (not inside a string context)
    const copyStart = text.match(/\bCOPY\b/i);

    if (accumulator === null) {
      if (!copyStart) continue;

      // Start accumulating from the COPY keyword onwards
      const copyIdx = copyStart.index!;
      accumulator = text.substring(copyIdx);
      startLine = lineNum;
      endLine = lineNum;
    } else {
      // Continue accumulating
      accumulator += ' ' + text.trim();
      endLine = lineNum;
    }

    // Check if statement terminates (period at end of accumulated text)
    if (accumulator !== null && /\.\s*$/.test(accumulator)) {
      const parsed = parseSingleCopyStatement(accumulator, startLine, endLine);
      if (parsed) {
        results.push(parsed);
      }
      accumulator = null;
    }
  }

  // If there's an unterminated COPY (missing period), try to parse what we have
  if (accumulator !== null) {
    const parsed = parseSingleCopyStatement(accumulator, startLine, endLine);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Parse a single complete COPY statement string.
 *
 * Formats:
 *   COPY target.
 *   COPY "target".
 *   COPY target REPLACING ... .
 */
function parseSingleCopyStatement(
  stmt: string,
  startLine: number,
  endLine: number,
): ParsedCopyStatement | null {
  // Strip terminating period
  const text = stmt.replace(/\.\s*$/, '').trim();

  // Extract target: COPY <target> or COPY "<target>" or COPY '<target>'
  // Optionally followed by IN/OF <library-name> (COBOL-85 standard: IN and OF are synonyms)
  const targetMatch = text.match(
    /^COPY\s+(?:"([^"]+)"|'([^']+)'|([A-Z][A-Z0-9-]*))(?:\s+(?:IN|OF)\s+([A-Z][A-Z0-9-]*))?/i,
  );
  if (!targetMatch) return null;

  const target = targetMatch[1] ?? targetMatch[2] ?? targetMatch[3];
  const library = targetMatch[4] || undefined;

  // Extract REPLACING clause if present
  let replacing: CopyReplacing[] = [];
  const replacingIdx = text.search(/\bREPLACING\b/i);
  if (replacingIdx >= 0) {
    const replacingText = text.substring(replacingIdx + 'REPLACING'.length);
    replacing = parseReplacingClause(replacingText);
  }

  return { startLine, endLine, target, replacing, library };
}

// ---------------------------------------------------------------------------
// REPLACING application
// ---------------------------------------------------------------------------

/**
 * Apply REPLACING transformations to copybook content.
 *
 * LEADING: replace prefix in COBOL identifiers.
 * TRAILING: replace suffix in COBOL identifiers.
 * EXACT: replace exact token matches.
 */
function applyReplacing(content: string, replacings: CopyReplacing[]): string {
  if (replacings.length === 0) return content;

  // First pass: handle EXACT replacements that contain spaces or non-identifier
  // characters (pseudotext). These cannot be handled by identifier-level matching.
  let result = content;
  for (const r of replacings) {
    if (
      r.type === 'EXACT' &&
      (r.isPseudotext || r.from.includes(' ') || !/^[A-Z][A-Z0-9-]*$/i.test(r.from))
    ) {
      const escaped = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      result = result.replace(re, r.to);
    }
  }

  // Second pass: identifier-level replacements (LEADING, TRAILING, single-word EXACT)
  const identifierReplacings = replacings.filter(
    (r) =>
      !(
        r.type === 'EXACT' &&
        (r.isPseudotext || r.from.includes(' ') || !/^[A-Z][A-Z0-9-]*$/i.test(r.from))
      ),
  );
  if (identifierReplacings.length === 0) return result;

  return result.replace(RE_COBOL_IDENTIFIER, (match) => {
    for (const r of identifierReplacings) {
      const upper = match.toUpperCase();
      const from = r.from.toUpperCase();
      const to = r.to.toUpperCase();
      switch (r.type) {
        case 'LEADING':
          if (upper.startsWith(from)) {
            return to + match.substring(from.length);
          }
          break;
        case 'TRAILING':
          if (upper.endsWith(from)) {
            return match.substring(0, match.length - from.length) + to;
          }
          break;
        case 'EXACT':
          if (upper === from) {
            return to;
          }
          break;
      }
    }
    return match;
  });
}

// ---------------------------------------------------------------------------
// Main expansion engine
// ---------------------------------------------------------------------------

/**
 * Expand COBOL COPY statements by inlining copybook content.
 *
 * @param content     - Source COBOL content (after preprocessCobolSource)
 * @param filePath    - Path of the source file (for diagnostics)
 * @param resolveFile - Maps a COPY target name to a filesystem path, or null if not found
 * @param readFile    - Reads file content by path, or null if unreadable
 * @param maxDepth    - Maximum nesting depth for recursive expansion (default: 10)
 * @returns Expanded content and resolution metadata
 */
export function expandCopies(
  content: string,
  filePath: string,
  resolveFile: (name: string) => string | null,
  readFile: (path: string) => string | null,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): CopyExpansionResult {
  const allResolutions: CopyResolution[] = [];
  const warnedCircular = new Set<string>();
  let totalExpansions = 0;
  const MAX_TOTAL_EXPANSIONS = 500;

  const expanded = expandRecursive(content, filePath, 0, new Set<string>());

  return {
    expandedContent: expanded,
    copyResolutions: allResolutions,
  };

  /**
   * Recursively expand COPY statements in content.
   *
   * @param src       - Source content to expand
   * @param srcPath   - Path of the file being expanded (for cycle detection logging)
   * @param depth     - Current recursion depth
   * @param visited   - Set of already-visited copybook paths (cycle detection)
   */
  function expandRecursive(
    src: string,
    srcPath: string,
    depth: number,
    visited: Set<string>,
  ): string {
    const rawLines = src.split(/\r?\n/);
    const logicalLines = mergeLogicalLines(rawLines);
    const copyStatements = parseCopyStatements(logicalLines);

    // No COPY statements — return as-is
    if (copyStatements.length === 0) return src;

    // Process COPY statements in reverse order so line numbers stay valid
    // as we splice content
    const outputLines = [...rawLines];

    for (let ci = copyStatements.length - 1; ci >= 0; ci--) {
      const cs = copyStatements[ci];

      // Resolve the copybook path
      const resolvedPath = resolveFile(cs.target);

      // Record resolution metadata
      allResolutions.push({
        copyTarget: cs.target,
        resolvedPath,
        line: cs.startLine,
        replacing: cs.replacing,
        library: cs.library,
      });

      // Cannot resolve — keep original lines
      if (resolvedPath === null) {
        continue;
      }

      // Cycle detection
      if (visited.has(resolvedPath)) {
        if (!warnedCircular.has(resolvedPath)) {
          warnedCircular.add(resolvedPath);
          console.warn(
            `[cobol-copy-expander] Circular COPY detected: ${cs.target} (${resolvedPath}) ` +
              `includes itself. Skipping expansion.`,
          );
        }
        continue;
      }

      // Max depth exceeded — keep unexpanded
      if (depth >= maxDepth) {
        console.warn(
          `[cobol-copy-expander] Max expansion depth (${maxDepth}) reached for ` +
            `COPY ${cs.target} in ${srcPath}. Skipping expansion.`,
        );
        continue;
      }

      // Guard against exponential breadth amplification (N copybooks each with N COPYs)
      if (++totalExpansions > MAX_TOTAL_EXPANSIONS) {
        if (!warnedCircular.has('__max_total__')) {
          warnedCircular.add('__max_total__');
          console.warn(
            `[cobol-copy-expander] Max total expansions (${MAX_TOTAL_EXPANSIONS}) reached ` +
              `in ${srcPath}. Skipping further expansions.`,
          );
        }
        continue;
      }

      // Read the copybook content
      const copybookContent = readFile(resolvedPath);
      if (copybookContent === null) {
        continue;
      }

      // Apply REPLACING transformations
      const replaced = applyReplacing(copybookContent, cs.replacing);

      // Recurse into the copybook for nested COPYs
      const nestedVisited = new Set(visited);
      nestedVisited.add(resolvedPath);
      const expandedCopybook = expandRecursive(replaced, resolvedPath, depth + 1, nestedVisited);

      // Splice: replace the COPY statement lines with expanded content
      // startLine/endLine are 1-based; convert to 0-based array index
      const expansionLines = expandedCopybook.split('\n');
      const removeCount = cs.endLine - cs.startLine + 1;
      outputLines.splice(cs.startLine - 1, removeCount, ...expansionLines);
    }

    return outputLines.join('\n');
  }
}
