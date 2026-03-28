/**
 * COBOL source pre-processing and regex-based symbol extraction.
 *
 * DESIGN DECISION — Why regex instead of a full parser (ANTLR4, tree-sitter):
 *
 * 1. Performance: Regex processes ~1ms/file vs 50-200ms/file for ANTLR4/tree-sitter.
 *    On EPAGHE (14k COBOL files), this is ~14 seconds vs 12-47 minutes.
 *
 * 2. Reliability: tree-sitter-cobol@0.0.1's external scanner hangs indefinitely
 *    on ~5% of production files (no timeout possible). ANTLR4's proleap-cobol-parser
 *    is a Java project — using it from Node.js requires Java subprocesses or
 *    extracting .g4 grammars and generating JS/TS targets (significant effort).
 *
 * 3. Dialect compatibility: GnuCOBOL with Italian comments, patch markers in
 *    cols 1-6 (mzADD, estero, etc.), and vendor extensions. Formal grammars
 *    target COBOL-85 and would need dialect modifications.
 *
 * 4. Industry precedent: ctags, GitHub code navigation, and Sourcegraph all use
 *    regex-based extraction for code indexing. Full parsing is only needed for
 *    compilation or semantic analysis, not symbol extraction.
 *
 * 5. Determinism: Every regex pattern is tested with canonical COBOL input
 *    (see test/unit/cobol-preprocessor.test.ts). Same input always produces
 *    same output — no grammar ambiguity or parser state issues.
 *
 * This module provides:
 * 1. preprocessCobolSource() — cleans patch markers (kept for potential future use)
 * 2. extractCobolSymbolsWithRegex() — single-pass state machine COBOL extraction
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CobolRegexResults {
  programName: string | null;
  /** All programs in this file with line-range boundaries for per-program scoping. */
  programs: Array<{
    name: string;
    startLine: number;
    endLine: number;
    nestingDepth: number;
    procedureUsing?: string[];
    isCommon?: boolean;
  }>;
  paragraphs: Array<{ name: string; line: number }>;
  sections: Array<{ name: string; line: number }>;
  performs: Array<{ caller: string | null; target: string; thruTarget?: string; line: number }>;
  calls: Array<{
    target: string;
    line: number;
    isQuoted: boolean;
    parameters?: string[];
    returning?: string;
  }>;
  copies: Array<{ target: string; line: number }>;
  dataItems: Array<{
    name: string;
    level: number;
    line: number;
    pic?: string;
    usage?: string;
    occurs?: number;
    dependingOn?: string;
    redefines?: string;
    values?: string[];
    isExternal?: boolean;
    isGlobal?: boolean;
    section: 'working-storage' | 'linkage' | 'file' | 'local-storage' | 'screen' | 'unknown';
  }>;
  fileDeclarations: Array<{
    selectName: string;
    assignTo: string;
    organization?: string;
    access?: string;
    recordKey?: string;
    alternateKeys?: string[];
    fileStatus?: string;
    isOptional?: boolean;
    line: number;
  }>;
  fdEntries: Array<{
    fdName: string;
    recordName?: string;
    line: number;
  }>;
  programMetadata: {
    author?: string;
    dateWritten?: string;
    dateCompiled?: string;
    installation?: string;
  };

  // Phase 2: EXEC blocks
  execSqlBlocks: Array<{
    line: number;
    tables: string[];
    cursors: string[];
    hostVariables: string[];
    operation:
      | 'SELECT'
      | 'INSERT'
      | 'UPDATE'
      | 'DELETE'
      | 'DECLARE'
      | 'OPEN'
      | 'CLOSE'
      | 'FETCH'
      | 'OTHER';
    includeMember?: string;
  }>;
  execCicsBlocks: Array<{
    line: number;
    command: string;
    mapName?: string;
    programName?: string;
    programIsLiteral?: boolean;
    transId?: string;
    fileName?: string;
    fileIsLiteral?: boolean;
    queueName?: string;
    labelName?: string;
    intoField?: string;
    fromField?: string;
  }>;

  // Phase 3: Linkage + Data Flow
  procedureUsing: string[];
  entryPoints: Array<{
    name: string;
    parameters: string[];
    line: number;
  }>;
  moves: Array<{
    from: string;
    targets: string[];
    line: number;
    caller: string | null;
    corresponding: boolean;
  }>;

  // Phase 4: Additional structural features
  gotos: Array<{ caller: string | null; target: string; line: number }>;
  sorts: Array<{ sortFile: string; usingFiles: string[]; givingFiles: string[]; line: number }>;
  searches: Array<{ target: string; line: number }>;
  cancels: Array<{ target: string; line: number; isQuoted: boolean }>;

  // Phase 2.1: EXEC DLI (IMS/DB)
  execDliBlocks: Array<{
    line: number;
    verb: string;
    pcbNumber?: number;
    segmentName?: string;
    intoField?: string;
    fromField?: string;
    psbName?: string;
  }>;

  // Phase 2.2: DECLARATIVES
  declaratives: Array<{
    sectionName: string;
    target: string; // file-name or INPUT/OUTPUT/I-O/EXTEND
    line: number;
  }>;

  // Phase 2.3: SET statement
  sets: Array<{
    targets: string[];
    form: 'to-true' | 'to-value' | 'up-by' | 'down-by';
    value?: string;
    line: number;
    caller: string | null;
  }>;

  // Phase 2.4: INSPECT
  inspects: Array<{
    inspectedField: string;
    counters: string[];
    form: 'tallying' | 'replacing' | 'converting' | 'tallying-replacing';
    line: number;
    caller: string | null;
  }>;

  // Phase 4.1: INITIALIZE
  initializes: Array<{ target: string; line: number; caller: string | null }>;
}

// ---------------------------------------------------------------------------
// Preserved exactly: preprocessCobolSource
// ---------------------------------------------------------------------------

/**
 * Normalize COBOL source for regex-based extraction.
 *
 * The COBOL fixed-format sequence number area (columns 1-6) is semantically
 * irrelevant to parsing — compilers and tools always ignore it.  This
 * function replaces ANY non-space content in columns 1-6 with spaces
 * so that position-sensitive regexes (paragraph/section detection, data-item
 * anchors, etc.) work identically whether the file carries numeric sequence
 * numbers (000100), alphabetic patch markers (mzADD, estero, #patch), or
 * the COBOL default of all spaces.
 *
 * Preserves exact line count for position mapping.
 */
export function preprocessCobolSource(content: string): string {
  // Skip preprocessing for free-format COBOL — cols 1-6 are program text, not sequence area
  // Check first 10 lines (consistent with extractCobolSymbolsWithRegex detection threshold)
  const firstLines = content.split('\n', 10).join('\n');
  if (/>>SOURCE\s+(?:FORMAT\s+(?:IS\s+)?)?FREE/i.test(firstLines)) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 7) continue;
    const seq = line.substring(0, 6);
    // Replace any non-space content in the sequence area with spaces.
    // This covers numeric sequence numbers (000100), alphabetic patch markers
    // (mzADD, estero), '#'-prefixed markers, and all other col 1-6 content.
    if (/\S/.test(seq)) {
      lines[i] = '      ' + line.substring(6);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Preserved exactly: EXCLUDED_PARA_NAMES
// ---------------------------------------------------------------------------

// COBOL calling-convention keywords to filter from USING parameter lists
const USING_KEYWORDS = new Set([
  'BY',
  'VALUE',
  'REFERENCE',
  'CONTENT',
  'ADDRESS',
  'OF',
  'RETURNING',
]);

// CALL ... USING keyword filter (extends USING_KEYWORDS for CALL-specific forms)
const CALL_USING_FILTER = new Set([
  'BY',
  'REFERENCE',
  'CONTENT',
  'VALUE',
  'ADDRESS',
  'OF',
  'LENGTH',
  'OMITTED',
]);

const EXCLUDED_PARA_NAMES = new Set([
  'DECLARATIVES',
  'END',
  'PROCEDURE',
  'IDENTIFICATION',
  'ENVIRONMENT',
  'DATA',
  'WORKING-STORAGE',
  'LINKAGE',
  'FILE',
  'LOCAL-STORAGE',
  'COMMUNICATION',
  'REPORT',
  'SCREEN',
  'INPUT-OUTPUT',
  'CONFIGURATION',
  // COBOL verbs that appear alone on a line with period (false-positive in free-format)
  'GOBACK',
  'STOP',
  'EXIT',
  'CONTINUE',
  'DISPLAY',
  'ACCEPT',
  'WRITE',
  'READ',
  'REWRITE',
  'DELETE',
  'OPEN',
  'CLOSE',
  'RETURN',
  'RELEASE',
  'SORT',
  'MERGE',
]);

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

type Division = 'identification' | 'environment' | 'data' | 'procedure' | null;

type DataSection = 'working-storage' | 'linkage' | 'file' | 'local-storage' | 'screen' | 'unknown';

type EnvironmentSection = 'input-output' | 'configuration' | null;

// ---------------------------------------------------------------------------
// Regex constants (compiled once, reused across calls)
// ---------------------------------------------------------------------------

const RE_DIVISION = /\b(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION\b/i;
const RE_SECTION =
  /\b(WORKING-STORAGE|LINKAGE|FILE|LOCAL-STORAGE|SCREEN|INPUT-OUTPUT|CONFIGURATION)\s+SECTION\b/i;

// IDENTIFICATION DIVISION
const RE_PROGRAM_ID = /\bPROGRAM-ID\.\s*([A-Z][A-Z0-9-]*)(?:\s+IS\s+COMMON)?/i;
const RE_END_PROGRAM = /\bEND\s+PROGRAM\s+([A-Z][A-Z0-9-]*)\s*\./i;
const RE_AUTHOR = /^\s+AUTHOR\.\s*(.+)/i;
const RE_DATE_WRITTEN = /^\s+DATE-WRITTEN\.\s*(.+)/i;
const RE_DATE_COMPILED = /^\s+DATE-COMPILED\.\s*(.+)/i;
const RE_INSTALLATION = /^\s+INSTALLATION\.\s*(.+)/i;

// ENVIRONMENT DIVISION — SELECT
const RE_SELECT_START = /\bSELECT\s+(?:OPTIONAL\s+)?([A-Z][A-Z0-9-]+)/i;

// DATA DIVISION
// ^\s* (not ^\s+) to support both fixed-format (indented) and free-format (trimmed)
const RE_FD = /^\s*(?:FD|SD|RD)\s+([A-Z][A-Z0-9-]+)/i;
const RE_DATA_ITEM = /^\s*(\d{1,2})\s+([A-Z][A-Z0-9-]+)\s*(.*)/i;
const RE_ANONYMOUS_REDEFINES = /^\s*(\d{1,2})\s+REDEFINES\s+([A-Z][A-Z0-9-]+)/i;
const RE_88_LEVEL = /^\s*88\s+([A-Z][A-Z0-9-]+)\s+VALUES?\s+(?:ARE\s+)?(.+)/i;

// PROCEDURE DIVISION
// These patterns support both fixed-format (7 leading spaces) and free-format (any indentation)
const RE_PROC_SECTION = /^\s*([A-Z][A-Z0-9-]+)\s+SECTION(?:\s+\d+)?\.\s*$/i;
const RE_PROC_PARAGRAPH = /^\s*([A-Z][A-Z0-9-]+)\.\s*$/i;
const RE_PERFORM = /\bPERFORM\s+([A-Z][A-Z0-9-]+)(?:\s+(?:THRU|THROUGH)\s+([A-Z][A-Z0-9-]+))?/gi;

// ALL DIVISIONS
// Both double-quoted ("PROG") and single-quoted ('PROG') targets are valid COBOL.
// Use separate alternation groups so quotes must match (prevents "PROG' false-matches).
const RE_CALL = /\bCALL\s+(?:"([^"]+)"|'([^']+)')/gi;
// Dynamic CALL via data item (no quotes): CALL WS-PROGRAM-NAME
const RE_CALL_DYNAMIC = /(?<![A-Z0-9-])\bCALL\s+([A-Z][A-Z0-9-]+)(?=\s|\.|$)/gi;
const RE_COPY_UNQUOTED = /\bCOPY\s+([A-Z][A-Z0-9-]+)(?:\s|\.)/i;
const RE_COPY_QUOTED = /\bCOPY\s+(?:"([^"]+)"|'([^']+)')(?:\s|\.)/i;

// EXEC blocks
const RE_EXEC_SQL_START = /\bEXEC\s+SQL\b/i;
const RE_EXEC_CICS_START = /\bEXEC\s+CICS\b/i;
const RE_END_EXEC = /\bEND-EXEC\b/i;

// GO TO — control flow transfer (same graph semantics as PERFORM)
// GO TO — captures first target; GO TO p1 p2 p3 DEPENDING ON x handled below
const RE_GOTO =
  /\bGO\s+TO\s+([A-Z][A-Z0-9-]+(?:\s+[A-Z][A-Z0-9-]+)*?)(?:\s+DEPENDING\s+ON\s+[A-Z][A-Z0-9-]+)?(?:\s*\.|$)/i;

// SORT/MERGE file references
const RE_SORT = /\bSORT\s+([A-Z][A-Z0-9-]+)/i;
const RE_MERGE = /\bMERGE\s+([A-Z][A-Z0-9-]+)/i;

// SEARCH — table access
const RE_SEARCH = /\bSEARCH\s+(?:ALL\s+)?([A-Z][A-Z0-9-]+)/i;

// CANCEL — program lifecycle
const RE_CANCEL = /\bCANCEL\s+(?:"([^"]+)"|'([^']+)')/gi;
const RE_CANCEL_DYNAMIC = /(?<![A-Z0-9-])\bCANCEL\s+([A-Z][A-Z0-9-]+)(?=\s|\.|$)/gi;

// Level 66 RENAMES
const RE_66_LEVEL = /^\s*66\s+([A-Z][A-Z0-9-]+)\s+RENAMES\s+([A-Z][A-Z0-9-]+)/i;

// DECLARATIVES boundary and USE AFTER EXCEPTION
const RE_DECLARATIVES_START = /^\s*DECLARATIVES\s*\.\s*$/i;
const RE_DECLARATIVES_END = /^\s*END\s+DECLARATIVES\s*\.\s*$/i;
const RE_USE_AFTER =
  /\bUSE\s+(?:AFTER\s+)?(?:STANDARD\s+)?(?:EXCEPTION|ERROR)\s+ON\s+([A-Z][A-Z0-9-]+|INPUT|OUTPUT|I-O|EXTEND)\b/i;

// SET statement (condition, index)
const RE_SET_TO_TRUE = /\bSET\s+((?:[A-Z][A-Z0-9-]+(?:\s+OF\s+[A-Z][A-Z0-9-]+)?\s+)+)TO\s+TRUE\b/i;
const RE_SET_INDEX =
  /\bSET\s+((?:[A-Z][A-Z0-9-]+\s+)+)(TO|UP\s+BY|DOWN\s+BY)\s+(\d+|[A-Z][A-Z0-9-]+)/i;

// INITIALIZE statement — data reset (captures targets before REPLACING/WITH clause)
const RE_INITIALIZE = /\bINITIALIZE\s+([\s\S]*?)(?=\bREPLACING\b|\bWITH\b|\.\s*$|$)/i;
const INITIALIZE_CLAUSE_KEYWORDS = new Set([
  'REPLACING',
  'WITH',
  'ALL',
  'ALPHABETIC',
  'ALPHANUMERIC',
  'NUMERIC',
  'NATIONAL',
  'DBCS',
  'EGCS',
  'FILLER',
]);

// EXEC DLI (IMS/DB)
const RE_EXEC_DLI_START = /\bEXEC\s+DLI\b/i;

// PROCEDURE DIVISION USING
const RE_PROC_USING = /\bPROCEDURE\s+DIVISION\s+USING\s+([\s\S]*?)(?:\.|$)/i;

// ENTRY point
const RE_ENTRY = /\bENTRY\s+(?:"([^"]+)"|'([^']+)')(?:\s+USING\s+([\s\S]*?))?(?:\.|$)/i;

// MOVE statement — captures everything after TO for multi-target extraction
const RE_MOVE = /\bMOVE\s+((?:CORRESPONDING|CORR)\s+)?([A-Z][A-Z0-9-]+)\s+TO\s+(.+)/i;
const MOVE_SKIP = new Set([
  'SPACES',
  'ZEROS',
  'ZEROES',
  'LOW-VALUES',
  'LOW-VALUE',
  'HIGH-VALUES',
  'HIGH-VALUE',
  'QUOTES',
  'QUOTE',
  'ALL',
]);

/**
 * Parse the text after "MOVE ... TO" into an array of target variable names.
 * Handles: multiple targets, OF/IN qualifiers, subscripts, trailing periods.
 * MOVE CORRESPONDING is always single-target per COBOL standard.
 */
function extractMoveTargets(afterTo: string): string[] {
  // Strip trailing period and everything after it
  const text = afterTo.replace(/\..*$/, '').trim();
  if (!text) return [];

  // Remove subscript/reference-modification parenthesized suffixes
  const noSubscripts = text.replace(/\([^)]*\)/g, '');
  const tokens = noSubscripts.split(/\s+/).filter((t) => t.length > 0);

  const targets: string[] = [];
  const QUAL_KEYWORDS = new Set(['OF', 'IN']);
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (QUAL_KEYWORDS.has(token.toUpperCase())) {
      skipNext = true;
      continue;
    }
    if (/^[A-Z][A-Z0-9-]+$/i.test(token) && !MOVE_SKIP.has(token.toUpperCase())) {
      targets.push(token);
    }
  }
  return targets;
}

// PERFORM: keywords that may follow PERFORM but are NOT paragraph/section names.
// Inline PERFORM loops (UNTIL, VARYING) and inline test clauses (WITH TEST,
// FOREVER) must not be stored as perform-target false positives.
const PERFORM_KEYWORD_SKIP = new Set(['UNTIL', 'VARYING', 'WITH', 'TEST', 'FOREVER']);

// SORT/MERGE clause keywords that should not be captured as file names
const SORT_CLAUSE_NOISE = new Set([
  'ON',
  'ASCENDING',
  'DESCENDING',
  'KEY',
  'WITH',
  'DUPLICATES',
  'IN',
  'ORDER',
  'COLLATING',
  'SEQUENCE',
  'IS',
  'THROUGH',
  'THRU',
  'INPUT',
  'OUTPUT',
  'PROCEDURE',
  'USING',
  'GIVING',
]);

// COBOL statement verbs used as boundary detectors across accumulators.
// Shared by: callAccum flush trigger, inspectAccum flush trigger, and USING lookahead.
// Note: CALL is intentionally excluded — it's handled by the callAccum state machine.
// Including CALL here would cause the flush trigger to consume the new CALL line
// without re-detecting it as a CALL start.
const COBOL_STATEMENT_VERBS = [
  'GO\\s+TO',
  'PERFORM',
  'MOVE',
  'DISPLAY',
  'ACCEPT',
  'INSPECT',
  'SEARCH',
  'SORT',
  'MERGE',
  'IF',
  'EVALUATE',
  'SET',
  'INITIALIZE',
  'STOP',
  'EXIT',
  'GOBACK',
  'CONTINUE',
  'READ',
  'WRITE',
  'REWRITE',
  'DELETE',
  'OPEN',
  'CLOSE',
  'START',
  'CANCEL',
  'COMPUTE',
  'ADD',
  'SUBTRACT',
  'MULTIPLY',
  'DIVIDE',
  'STRING',
  'UNSTRING',
];

/** Regex matching start of any COBOL statement verb (for accumulator flush triggers). */
const RE_STATEMENT_VERB_START = new RegExp(`^(?:${COBOL_STATEMENT_VERBS.join('|')})(?:\\s|$)`, 'i');

/** Lookahead alternation for USING parameter extraction (stops before statement verbs).
 *  Includes CALL (excluded from COBOL_STATEMENT_VERBS to avoid callAccum conflicts). */
const USING_VERB_LOOKAHEAD = [...COBOL_STATEMENT_VERBS, 'CALL']
  .filter((v) => v !== 'GO\\s+TO') // GO TO handled separately with \bGO\s+TO\b
  .map((v) => `\\b${v}(?=\\s|$)`)
  .join('|');
const RE_USING_PARAMS = new RegExp(
  `\\bUSING\\s+([\\s\\S]*?)(?=\\bRETURNING\\b|\\bON\\s+(?:EXCEPTION|OVERFLOW)\\b|\\bNOT\\s+ON\\b|\\bEND-CALL\\b|\\bGO\\s+TO\\b|${USING_VERB_LOOKAHEAD}|\\.\\s*$|$)`,
  'i',
);

// ---------------------------------------------------------------------------
// Private helper: strip Italian inline comments (| and everything after)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Private helper: parse data item trailing clauses (PIC, USAGE, etc.)
// ---------------------------------------------------------------------------

function parseDataItemClauses(rest: string): {
  pic?: string;
  usage?: string;
  redefines?: string;
  occurs?: number;
  dependingOn?: string;
  value?: string;
  isExternal?: boolean;
  isGlobal?: boolean;
} {
  const result: {
    pic?: string;
    usage?: string;
    redefines?: string;
    occurs?: number;
    dependingOn?: string;
    value?: string;
    isExternal?: boolean;
    isGlobal?: boolean;
  } = {};

  // Strip trailing period for easier parsing
  const text = rest.replace(/\.\s*$/, '');

  // PIC / PICTURE [IS] <picture-string>
  const picMatch = text.match(/\bPIC(?:TURE)?\s+(?:IS\s+)?(\S+)/i);
  if (picMatch) {
    result.pic = picMatch[1];
  }

  // USAGE [IS] <usage-type> — including non-standard COMP-6, COMP-X etc.
  const usageMatch = text.match(
    /\bUSAGE\s+(?:IS\s+)?(COMP(?:UTATIONAL)?(?:-[0-9X])?|BINARY|PACKED-DECIMAL|DISPLAY|INDEX|POINTER|NATIONAL)\b/i,
  );
  if (usageMatch) {
    result.usage = usageMatch[1].toUpperCase();
  } else {
    // Standalone COMP variants without USAGE keyword
    const compMatch = text.match(/\b(COMP(?:UTATIONAL)?(?:-[0-9X])?|BINARY|PACKED-DECIMAL)\b/i);
    if (compMatch) {
      result.usage = compMatch[1].toUpperCase();
    }
  }

  // REDEFINES <name>
  const redefMatch = text.match(/\bREDEFINES\s+([A-Z][A-Z0-9-]+)/i);
  if (redefMatch) {
    result.redefines = redefMatch[1];
  }

  // OCCURS <n> [TO <m>] [TIMES] [DEPENDING ON <field>]
  const occursMatch = text.match(
    /\bOCCURS\s+(\d+)(?:\s+TO\s+(\d+))?\s*(?:TIMES\s*)?(?:DEPENDING\s+ON\s+([A-Z][A-Z0-9-]+(?:\s*\([^)]*\))?))?/i,
  );
  if (occursMatch) {
    result.occurs = parseInt(occursMatch[1], 10);
    if (occursMatch[3]) {
      // Strip any subscript from DEPENDING ON field
      result.dependingOn = occursMatch[3].replace(/\s*\([^)]*\)/, '').trim();
    }
  }

  // IS EXTERNAL / IS GLOBAL
  result.isExternal = /\bIS\s+EXTERNAL\b/i.test(text) || undefined;
  result.isGlobal = /\bIS\s+GLOBAL\b/i.test(text) || undefined;

  // VALUE [IS] literal/constant
  if (!result.value) {
    const valueIdx = text.search(/\bVALUE\b/i);
    if (valueIdx >= 0) {
      const afterValue = text
        .substring(valueIdx + 5)
        .replace(/^\s+IS\s+/i, '')
        .trimStart();
      // Try quoted: "..." or '...' (with optional type prefix X, N, G, B)
      const quotedMatch = afterValue.match(/^([XNGB])?(?:"([^"]*)"|'([^']*)')/i);
      if (quotedMatch) {
        const prefix = quotedMatch[1] ? quotedMatch[1].toUpperCase() : '';
        result.value = prefix
          ? `${prefix}'${quotedMatch[2] ?? quotedMatch[3]}'`
          : (quotedMatch[2] ?? quotedMatch[3]);
      } else {
        // Try ALL "..." or ALL '...'
        const allMatch = afterValue.match(/^ALL\s+(?:"([^"]*)"|'([^']*)')/i);
        if (allMatch) {
          result.value = `ALL '${allMatch[1] ?? allMatch[2]}'`;
        } else {
          // Try numeric (including negative, decimal)
          const numMatch = afterValue.match(/^(-?\d+\.?\d*)/);
          if (numMatch) {
            result.value = numMatch[1];
          } else {
            // Try figurative constant or identifier
            const identMatch = afterValue.match(/^([A-Z][A-Z0-9-]*)/i);
            if (identMatch) result.value = identMatch[1].toUpperCase();
          }
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private helper: parse 88-level condition values
// ---------------------------------------------------------------------------

function parseConditionValues(valuesStr: string): string[] {
  // Strip trailing period
  const text = valuesStr.replace(/\.\s*$/, '').trim();
  const values: string[] = [];

  // Match quoted strings: "O" "Y" "I"
  const quotedRe = /(?:"([^"]*)"|'([^']*)')/g;
  let qm: RegExpExecArray | null;
  let hasQuoted = false;
  while ((qm = quotedRe.exec(text)) !== null) {
    values.push(qm[1] ?? qm[2]);
    hasQuoted = true;
  }
  if (hasQuoted) return values;

  // No quotes — split on whitespace, filtering out THRU/THROUGH keywords
  // Handle: 11 12 16 17 21   or   1 THRU 5
  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === 'THRU' || upper === 'THROUGH') {
      // Keep THRU ranges as combined value: prev THRU next is already captured
      // by having both sides in the array
      continue;
    }
    if (token.length > 0) {
      values.push(token);
    }
  }

  return values;
}

// ---------------------------------------------------------------------------
// Private helper: parse accumulated multi-line SELECT statement
// ---------------------------------------------------------------------------

interface FileDeclaration {
  selectName: string;
  assignTo: string;
  organization?: string;
  access?: string;
  recordKey?: string;
  alternateKeys?: string[];
  fileStatus?: string;
  isOptional?: boolean;
  line: number;
}

function parseSelectStatement(stmt: string, startLine: number): FileDeclaration | null {
  // Normalize whitespace
  const text = stmt.replace(/\s+/g, ' ').trim();

  const nameMatch = text.match(/^SELECT\s+(?:OPTIONAL\s+)?([A-Z][A-Z0-9-]+)/i);
  if (!nameMatch) return null;

  const result: FileDeclaration = {
    selectName: nameMatch[1],
    assignTo: '',
    line: startLine,
  };

  const assignMatch = text.match(/\bASSIGN\s+(?:TO\s+)?("([^"]+)"|([A-Z][A-Z0-9-]*))/i);
  if (assignMatch) {
    result.assignTo = assignMatch[2] || assignMatch[3] || '';
  }

  const orgMatch = text.match(
    /\bORGANIZATION\s+(?:IS\s+)?(SEQUENTIAL|INDEXED|RELATIVE|LINE\s+SEQUENTIAL)/i,
  );
  if (orgMatch) {
    result.organization = orgMatch[1].toUpperCase();
  }

  const accessMatch = text.match(/\bACCESS\s+(?:MODE\s+)?(?:IS\s+)?(SEQUENTIAL|RANDOM|DYNAMIC)/i);
  if (accessMatch) {
    result.access = accessMatch[1].toUpperCase();
  }

  const keyMatch = text.match(/\bRECORD\s+KEY\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)/i);
  if (keyMatch) {
    result.recordKey = keyMatch[1];
  }

  // ALTERNATE RECORD KEY
  const altKeyMatches = text.matchAll(/\bALTERNATE\s+RECORD\s+KEY\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)/gi);
  const alternateKeys: string[] = [];
  for (const m of altKeyMatches) alternateKeys.push(m[1]);
  if (alternateKeys.length > 0) result.alternateKeys = alternateKeys;

  // FILE STATUS IS / STATUS IS
  const statusMatch = text.match(/\b(?:FILE\s+)?STATUS\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)/i);
  if (statusMatch) {
    result.fileStatus = statusMatch[1];
  }

  // SELECT OPTIONAL flag
  result.isOptional = /^SELECT\s+OPTIONAL\b/i.test(text) || undefined;

  return result;
}

// ---------------------------------------------------------------------------
// Private helper: parse EXEC SQL block
// ---------------------------------------------------------------------------

type SqlOperation =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'DECLARE'
  | 'OPEN'
  | 'CLOSE'
  | 'FETCH'
  | 'OTHER';

function parseExecSqlBlock(
  block: string,
  line: number,
): CobolRegexResults['execSqlBlocks'][number] {
  // Strip EXEC SQL ... END-EXEC wrapper
  const body = block
    .replace(/\bEXEC\s+SQL\b/i, '')
    .replace(/\bEND-EXEC\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Determine operation from first SQL keyword
  const firstWord = body.split(/\s+/)[0]?.toUpperCase() || '';
  const OP_MAP: Record<string, SqlOperation> = {
    SELECT: 'SELECT',
    INSERT: 'INSERT',
    UPDATE: 'UPDATE',
    DELETE: 'DELETE',
    DECLARE: 'DECLARE',
    OPEN: 'OPEN',
    CLOSE: 'CLOSE',
    FETCH: 'FETCH',
    INCLUDE: 'OTHER', // we handle INCLUDE specially below
  };
  const operation: SqlOperation = OP_MAP[firstWord] || 'OTHER';

  // EXEC SQL INCLUDE — extract member name for IMPORTS edge
  let includeMember: string | undefined;
  if (firstWord === 'INCLUDE') {
    const includeMatch = body.match(/^INCLUDE\s+(?:'([^']+)'|"([^"]+)"|([A-Z][A-Z0-9_-]+))/i);
    if (includeMatch) {
      includeMember = includeMatch[1] ?? includeMatch[2] ?? includeMatch[3];
    }
  }

  // Extract table names from FROM, INTO (INSERT), UPDATE, DELETE FROM, JOIN
  const tables: string[] = [];
  const tablePatterns = [
    /\bFROM\s+([A-Z][A-Z0-9_]+)/gi,
    /\bINSERT\s+INTO\s+([A-Z][A-Z0-9_]+)/gi,
    /\bUPDATE\s+([A-Z][A-Z0-9_]+)/gi,
    /\bJOIN\s+([A-Z][A-Z0-9_]+)/gi,
  ];
  for (const re of tablePatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const name = m[1].toUpperCase();
      // Skip host variables and SQL keywords
      if (!name.startsWith(':') && !tables.includes(name)) {
        tables.push(name);
      }
    }
  }

  // Extract cursor names from DECLARE ... CURSOR
  const cursors: string[] = [];
  const cursorRe = /\bDECLARE\s+([A-Z][A-Z0-9_-]+)\s+CURSOR\b/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cursorRe.exec(body)) !== null) {
    cursors.push(cm[1]);
  }

  // Extract host variables: :VARIABLE-NAME (strip the colon)
  const hostVariables: string[] = [];
  const hostRe = /:([A-Z][A-Z0-9-]+)/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hostRe.exec(body)) !== null) {
    const name = hm[1];
    if (!hostVariables.includes(name)) {
      hostVariables.push(name);
    }
  }

  return { line, tables, cursors, hostVariables, operation, includeMember };
}

// ---------------------------------------------------------------------------
// Private helper: parse EXEC CICS block
// ---------------------------------------------------------------------------

function parseExecCicsBlock(
  block: string,
  line: number,
): CobolRegexResults['execCicsBlocks'][number] {
  // Strip EXEC CICS ... END-EXEC wrapper
  const body = block
    .replace(/\bEXEC\s+CICS\b/i, '')
    .replace(/\bEND-EXEC\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Command: first keyword(s) — handle two-word commands like SEND MAP, RECEIVE MAP
  const twoWordCommands = [
    'SEND MAP',
    'RECEIVE MAP',
    'SEND TEXT',
    'SEND CONTROL',
    'READ NEXT',
    'READ PREV',
    'WRITEQ TS',
    'WRITEQ TD',
    'READQ TS',
    'READQ TD',
    'DELETEQ TS',
    'DELETEQ TD',
    'HANDLE ABEND',
    'HANDLE AID',
    'HANDLE CONDITION',
    'START TRANSID',
  ];
  let command = '';
  const upperBody = body.toUpperCase();
  for (const twoWord of twoWordCommands) {
    if (upperBody.startsWith(twoWord)) {
      command = twoWord;
      break;
    }
  }
  if (!command) {
    command = body.split(/\s+/)[0]?.toUpperCase() || '';
  }

  const result: CobolRegexResults['execCicsBlocks'][number] = { line, command };

  // MAP name: MAP('name') or MAP("name") or MAP(IDENTIFIER)
  const mapMatch = body.match(/\bMAP\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i);
  if (mapMatch) result.mapName = mapMatch[1] ?? mapMatch[2];

  // PROGRAM name: PROGRAM('name') or PROGRAM("name") or PROGRAM(VARIABLE)
  const progMatch = body.match(/\bPROGRAM\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i);
  if (progMatch) {
    result.programName = progMatch[1] ?? progMatch[2];
    result.programIsLiteral = !!progMatch[1];
  }

  // TRANSID: TRANSID('name') or TRANSID("name") or TRANSID(VARIABLE)
  const transMatch = body.match(/\bTRANSID\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i);
  if (transMatch) result.transId = transMatch[1] ?? transMatch[2];

  // FILE/DATASET: FILE('name') or DATASET('name') or FILE(VARIABLE)
  // Used in CICS READ, WRITE, REWRITE, DELETE, STARTBR, READNEXT, READPREV, ENDBR
  const fileMatch = body.match(
    /\b(?:FILE|DATASET)\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i,
  );
  if (fileMatch) {
    result.fileName = fileMatch[1] ?? fileMatch[2];
    result.fileIsLiteral = !!fileMatch[1];
  }

  // QUEUE: QUEUE('name') — used in WRITEQ/READQ TS/TD
  const queueMatch = body.match(/\bQUEUE\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i);
  if (queueMatch) result.queueName = queueMatch[1] ?? queueMatch[2];

  // HANDLE ABEND LABEL(paragraph-name) — error handler target
  const labelMatch = body.match(/\bLABEL\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
  if (labelMatch) result.labelName = labelMatch[1];

  // INTO(data-area) — data target (READ INTO, RECEIVE INTO, RETRIEVE INTO, READQ INTO)
  const intoMatch = body.match(/\bINTO\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
  if (intoMatch) result.intoField = intoMatch[1];

  // FROM(data-area) — data source (WRITE FROM, SEND FROM, WRITEQ FROM, START FROM)
  const fromMatch = body.match(/\bFROM\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
  if (fromMatch) result.fromField = fromMatch[1];

  return result;
}

// ---------------------------------------------------------------------------
// Private helper: parse EXEC DLI block (IMS/DB)
// ---------------------------------------------------------------------------

function parseExecDliBlock(
  block: string,
  line: number,
): CobolRegexResults['execDliBlocks'][number] {
  const body = block
    .replace(/\bEXEC\s+DLI\b/i, '')
    .replace(/\bEND-EXEC\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const verb = body.split(/\s+/)[0]?.toUpperCase() || '';
  const result: CobolRegexResults['execDliBlocks'][number] = { line, verb };

  const pcbMatch = body.match(/\bUSING\s+PCB\s*\(\s*(\d+)\s*\)/i);
  if (pcbMatch) result.pcbNumber = parseInt(pcbMatch[1], 10);

  const segMatch = body.match(/\bSEGMENT\s*\(\s*([A-Z][A-Z0-9-]*)\s*\)/i);
  if (segMatch) result.segmentName = segMatch[1];

  const intoMatch = body.match(/\bINTO\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
  if (intoMatch) result.intoField = intoMatch[1];

  const fromMatch = body.match(/\bFROM\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
  if (fromMatch) result.fromField = fromMatch[1];

  const psbMatch = body.match(/\bPSB\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
  if (psbMatch) result.psbName = psbMatch[1];

  return result;
}

// ---------------------------------------------------------------------------
// Main extraction: single-pass state machine
// ---------------------------------------------------------------------------

/**
 * Extract COBOL symbols using a single-pass state machine.
 * Extracts program name, paragraphs, sections, CALL, PERFORM, COPY,
 * data items, file declarations, FD entries, and program metadata.
 */
export function extractCobolSymbolsWithRegex(
  content: string,
  _filePath: string,
): CobolRegexResults {
  const rawLines = content.split(/\r?\n/);

  const result: CobolRegexResults = {
    programName: null,
    programs: [],
    paragraphs: [],
    sections: [],
    performs: [],
    calls: [],
    copies: [],
    dataItems: [],
    fileDeclarations: [],
    fdEntries: [],
    programMetadata: {},
    execSqlBlocks: [],
    execCicsBlocks: [],
    procedureUsing: [],
    entryPoints: [],
    moves: [],
    gotos: [],
    sorts: [],
    searches: [],
    cancels: [],
    execDliBlocks: [],
    declaratives: [],
    sets: [],
    inspects: [],
    initializes: [],
  };

  // --- State ---
  let currentDivision: Division = null;
  let currentDataSection: DataSection = 'unknown';
  let currentEnvSection: EnvironmentSection = null;
  let currentParagraph: string | null = null;

  // Program boundary stack for nested PROGRAM-ID / END PROGRAM tracking
  const programBoundaryStack: Array<{
    name: string;
    startLine: number;
    procedureUsing?: string[];
    isCommon?: boolean;
  }> = [];

  // SELECT accumulator (multi-line)
  let selectAccum: string | null = null;
  let selectStartLine = 0;

  // PROCEDURE DIVISION USING on next line
  let pendingProcUsing = false;

  // SORT/MERGE accumulator (multi-line SORT ... USING ... GIVING ...)
  let sortAccum: string | null = null;
  let sortStartLine = 0;

  // EXEC block accumulator (multi-line EXEC SQL / EXEC CICS / EXEC DLI)
  let execAccum: { type: 'sql' | 'cics' | 'dli'; lines: string; startLine: number } | null = null;

  // DECLARATIVES state
  let inDeclaratives = false;

  // INSPECT accumulator (multi-line)
  let inspectAccum: string | null = null;
  let inspectStartLine = 0;

  // CALL accumulator (multi-line CALL ... USING on separate lines)
  let callAccum: string | null = null;
  let callAccumLine = 0;

  // FD tracking: after seeing FD, the next 01-level data item is its record
  let pendingFdName: string | null = null;
  let pendingFdLine = 0;

  // Continuation line buffer
  let pendingLine: string | null = null;
  let pendingLineNumber = 0;

  // --- Detect source format: free vs fixed ---
  // GnuCOBOL uses >>SOURCE FREE directive, typically in first 5 lines
  let isFreeFormat = false;
  for (let i = 0; i < Math.min(rawLines.length, 10); i++) {
    if (/>>SOURCE\s+(?:FORMAT\s+(?:IS\s+)?)?FREE/i.test(rawLines[i])) {
      isFreeFormat = true;
      break;
    }
  }

  // --- Process each raw line ---
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];

    if (isFreeFormat) {
      // FREE FORMAT: no column-position rules
      // Skip >>SOURCE directive lines
      if (/^[ \t]*>>/.test(raw)) continue;
      // Skip free-format comment lines (*> at start of content)
      const trimmed = raw.trimStart();
      if (trimmed.startsWith('*>') || trimmed.length === 0) continue;
      // Strip inline *> comments (quote-aware)
      let commentIdx = -1;
      let ffInQuote: string | null = null;
      for (let ci = 0; ci < raw.length - 1; ci++) {
        const c = raw[ci];
        if (ffInQuote) {
          if (c === ffInQuote) ffInQuote = null;
        } else if (c === '"' || c === "'") {
          ffInQuote = c;
        } else if (c === '*' && raw[ci + 1] === '>') {
          commentIdx = ci;
          break;
        }
      }
      const line = commentIdx >= 0 ? raw.substring(0, commentIdx) : raw;
      // Free-format lines are logical lines (no continuation indicator)
      const lineNum = i + 1;
      processLogicalLine(line.trim(), lineNum);
      continue;
    }

    // FIXED FORMAT: column-position-based processing

    // Skip lines too short to have indicator area
    if (raw.length < 7) {
      // If there's a pending continuation, flush it
      if (pendingLine !== null) {
        processLogicalLine(pendingLine, pendingLineNumber);
        pendingLine = null;
      }
      continue;
    }

    const indicator = raw[6];

    // Comment line: indicator is '*' or '/'
    if (indicator === '*' || indicator === '/') {
      continue;
    }

    // Continuation line: indicator is '-'
    if (indicator === '-') {
      if (pendingLine !== null) {
        const continuation = raw.substring(7).trimStart();
        // Handle literal continuation: if continuation starts with a quote,
        // remove the trailing quote from the predecessor and skip the opening quote
        if (continuation.length > 0 && (continuation[0] === '"' || continuation[0] === "'")) {
          const quoteChar = continuation[0];
          const lastQuoteIdx = pendingLine.lastIndexOf(quoteChar);
          if (lastQuoteIdx >= 0) {
            pendingLine = pendingLine.substring(0, lastQuoteIdx) + continuation.substring(1);
          } else {
            pendingLine += continuation;
          }
        } else {
          pendingLine += continuation;
        }
      }
      continue;
    }

    // Normal line — flush any pending continuation first
    if (pendingLine !== null) {
      processLogicalLine(pendingLine, pendingLineNumber);
      pendingLine = null;
    }

    // Strip inline Italian comments, then use area A+B (from col 7 onwards,
    // but keep full line for indentation-sensitive paragraph/section detection)
    const cleaned = stripInlineComment(raw);

    // Buffer as new pending logical line
    pendingLine = cleaned;
    pendingLineNumber = i + 1; // 1-indexed (consistent with free-format)
  }

  // Flush final pending line
  if (pendingLine !== null) {
    processLogicalLine(pendingLine, pendingLineNumber);
  }

  // Flush any pending SELECT
  flushSelect();

  // Flush any pending SORT/MERGE accumulator (truncated file without trailing period)
  flushSort();

  // Flush any pending INSPECT accumulator (truncated file without trailing period)
  flushInspect();

  // Flush any pending CALL accumulator (truncated file without trailing period)
  flushCallAccum();

  // Flush any pending EXEC block (truncated file without END-EXEC)
  if (execAccum !== null) {
    if (execAccum.type === 'sql') {
      result.execSqlBlocks.push(parseExecSqlBlock(execAccum.lines, execAccum.startLine));
    } else if (execAccum.type === 'cics') {
      result.execCicsBlocks.push(parseExecCicsBlock(execAccum.lines, execAccum.startLine));
    } else if (execAccum.type === 'dli') {
      result.execDliBlocks.push(parseExecDliBlock(execAccum.lines, execAccum.startLine));
    }
    execAccum = null;
  }

  // If we saw an FD but never found its record, emit it without a record name
  if (pendingFdName !== null) {
    result.fdEntries.push({ fdName: pendingFdName, line: pendingFdLine });
    pendingFdName = null;
  }

  // Finalize any remaining programs on the boundary stack (e.g., single-program
  // files without END PROGRAM, or outermost programs in nested files)
  while (programBoundaryStack.length > 0) {
    const topProgram = programBoundaryStack.pop()!;
    result.programs.push({
      name: topProgram.name,
      startLine: topProgram.startLine,
      endLine: rawLines.length,
      nestingDepth: programBoundaryStack.length,
      procedureUsing: topProgram.procedureUsing,
      isCommon: topProgram.isCommon,
    });
  }
  // Sort by startLine so outer programs come first
  if (result.programs.length > 1) {
    result.programs.sort((a, b) => a.startLine - b.startLine);
  }

  return result;

  // =========================================================================
  // Inner function: process one logical line (after continuation merging)
  // =========================================================================
  function processLogicalLine(line: string, lineNum: number): void {
    // --- EXEC block accumulation (spans any division) ---
    if (execAccum !== null) {
      execAccum.lines += ' ' + line;
      if (RE_END_EXEC.test(line)) {
        if (execAccum.type === 'sql') {
          result.execSqlBlocks.push(parseExecSqlBlock(execAccum.lines, execAccum.startLine));
        } else if (execAccum.type === 'cics') {
          result.execCicsBlocks.push(parseExecCicsBlock(execAccum.lines, execAccum.startLine));
        } else if (execAccum.type === 'dli') {
          result.execDliBlocks.push(parseExecDliBlock(execAccum.lines, execAccum.startLine));
        }
        execAccum = null;
      }
      return; // While accumulating, skip normal processing
    }

    // Check for EXEC SQL / EXEC CICS start
    // Flush any pending CALL accumulator before entering EXEC block
    if (RE_EXEC_SQL_START.test(line)) {
      flushCallAccum();
      execAccum = { type: 'sql', lines: line, startLine: lineNum };
      // If END-EXEC is on the same line, finalize immediately
      if (RE_END_EXEC.test(line)) {
        result.execSqlBlocks.push(parseExecSqlBlock(execAccum.lines, execAccum.startLine));
        execAccum = null;
      }
      return;
    }
    if (RE_EXEC_CICS_START.test(line)) {
      flushCallAccum();
      execAccum = { type: 'cics', lines: line, startLine: lineNum };
      if (RE_END_EXEC.test(line)) {
        result.execCicsBlocks.push(parseExecCicsBlock(execAccum.lines, execAccum.startLine));
        execAccum = null;
      }
      return;
    }
    if (RE_EXEC_DLI_START.test(line)) {
      flushCallAccum();
      execAccum = { type: 'dli', lines: line, startLine: lineNum };
      if (RE_END_EXEC.test(line)) {
        result.execDliBlocks.push(parseExecDliBlock(execAccum.lines, execAccum.startLine));
        execAccum = null;
      }
      return;
    }

    // --- END PROGRAM boundary detection ---
    const endProgramMatch = line.match(RE_END_PROGRAM);
    if (endProgramMatch) {
      // Flush any pending accumulators at program boundary
      flushCallAccum();
      flushSort();
      flushInspect();
      const topProgram = programBoundaryStack.pop();
      if (topProgram) {
        result.programs.push({
          name: topProgram.name,
          startLine: topProgram.startLine,
          endLine: lineNum,
          nestingDepth: programBoundaryStack.length,
          procedureUsing: topProgram.procedureUsing,
          isCommon: topProgram.isCommon,
        });
      }
      return;
    }

    // DECLARATIVES boundary detection
    if (RE_DECLARATIVES_START.test(line)) {
      inDeclaratives = true;
      return;
    }
    if (RE_DECLARATIVES_END.test(line)) {
      inDeclaratives = false;
      return;
    }

    // Detect PROGRAM-ID regardless of current division state (handles sibling
    // programs after END PROGRAM where IDENTIFICATION DIVISION header is omitted)
    if (currentDivision !== 'identification') {
      const pgmIdMatch = line.match(RE_PROGRAM_ID);
      if (pgmIdMatch) {
        flushCallAccum();
        flushSort();
        flushInspect();
        extractIdentification(line, lineNum);
        return;
      }
    }

    // --- Division transitions ---
    const divMatch = line.match(RE_DIVISION);
    if (divMatch) {
      // Flush any pending accumulators on division boundary
      flushSelect();
      flushCallAccum();
      flushSort();
      flushInspect();

      const divName = divMatch[1].toUpperCase();
      switch (divName) {
        case 'IDENTIFICATION':
          currentDivision = 'identification';
          break;
        case 'ENVIRONMENT':
          currentDivision = 'environment';
          currentEnvSection = null;
          break;
        case 'DATA':
          currentDivision = 'data';
          currentDataSection = 'unknown';
          break;
        case 'PROCEDURE': {
          currentDivision = 'procedure';
          currentParagraph = null;
          const procUsingMatch = line.match(RE_PROC_USING);
          if (procUsingMatch) {
            const params = procUsingMatch[1]
              .split(/\bRETURNING\b/i)[0]
              .trim()
              .split(/\s+/)
              .filter((s) => s.length > 0 && !USING_KEYWORDS.has(s.toUpperCase()));
            result.procedureUsing = params;
            // Store per-program on the boundary stack
            const topProg = programBoundaryStack[programBoundaryStack.length - 1];
            if (topProg) topProg.procedureUsing = params;
            pendingProcUsing = false;
          } else {
            // USING may be on the next line — flag for extractProcedure to pick up
            // Only set if the line is NOT period-terminated (period = no USING clause)
            pendingProcUsing = !/\.\s*$/.test(line);
          }
          break;
        }
      }
      return;
    }

    // --- Section transitions ---
    const secMatch = line.match(RE_SECTION);
    if (secMatch) {
      flushSelect();

      const secName = secMatch[1].toUpperCase();
      switch (secName) {
        case 'WORKING-STORAGE':
          currentDivision = 'data';
          currentDataSection = 'working-storage';
          break;
        case 'LINKAGE':
          currentDivision = 'data';
          currentDataSection = 'linkage';
          break;
        case 'FILE':
          currentDivision = 'data';
          currentDataSection = 'file';
          break;
        case 'LOCAL-STORAGE':
          currentDivision = 'data';
          currentDataSection = 'local-storage';
          break;
        case 'SCREEN':
          currentDivision = 'data';
          currentDataSection = 'screen';
          break;
        case 'INPUT-OUTPUT':
          currentDivision = 'environment';
          currentEnvSection = 'input-output';
          break;
        case 'CONFIGURATION':
          currentDivision = 'environment';
          currentEnvSection = 'configuration';
          break;
      }
      return;
    }

    // --- COPY (all divisions) ---
    const copyQMatch = line.match(RE_COPY_QUOTED);
    if (copyQMatch) {
      result.copies.push({ target: copyQMatch[1] ?? copyQMatch[2], line: lineNum });
    } else {
      const copyUMatch = line.match(RE_COPY_UNQUOTED);
      if (copyUMatch) {
        result.copies.push({ target: copyUMatch[1], line: lineNum });
      }
    }

    // --- CALL (all divisions, typically procedure) ---
    // Multi-line CALL accumulator: accumulate CALL statement until period or END-CALL.
    // Continuation lines (not the start line) are consumed entirely — return after flush
    // to prevent false paragraph detection on lines like "WS-ADDR." or "WS-CUST-CODE."
    if (callAccum !== null) {
      // Check if this continuation line starts a new COBOL statement (not a USING parameter).
      // Use (?:\s|$) instead of \b to prevent matching hyphenated identifiers like MOVE-COUNT.
      // Only use RE_PROC_PARAGRAPH as flush trigger when in Area A (≤7 leading spaces, fixed-format).
      // In free-format, never use RE_PROC_PARAGRAPH (can't distinguish parameters from paragraphs).
      const trimmedLine = line.trimStart();
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      const isAreaAParagraph =
        RE_PROC_PARAGRAPH.test(line) && (!isFreeFormat ? leadingSpaces <= 7 : false);
      if (
        RE_STATEMENT_VERB_START.test(trimmedLine) ||
        RE_PROC_SECTION.test(line) ||
        isAreaAParagraph
      ) {
        flushCallAccum(); // Flush CALL without this line's content
        // Fall through to process this line normally
      } else {
        callAccum += ' ' + line;
        if (/\.\s*$/.test(callAccum) || /\bEND-CALL\b/i.test(callAccum)) {
          flushCallAccum();
        }
        return; // continuation line consumed by CALL accumulator
      }
    } else if (
      currentDivision === 'procedure' &&
      /(?<![A-Z0-9-])\bCALL\s+(?:"[^"]+"|'[^']+'|[A-Z][A-Z0-9-]+)/i.test(line)
    ) {
      // Check if this is a complete single-line CALL (ends with period or END-CALL)
      if (/\.\s*$/.test(line) || /\bEND-CALL\b/i.test(line)) {
        // Single-line CALL — extract immediately via flushCallAccum
        callAccum = line;
        callAccumLine = lineNum;
        flushCallAccum();
      } else {
        // Multi-line CALL — start accumulating
        callAccum = line;
        callAccumLine = lineNum;
        return; // prevent CALL start line from feeding sortAccum/inspectAccum
      }
    }

    // --- Division-specific extraction ---
    switch (currentDivision) {
      case 'identification':
        extractIdentification(line, lineNum);
        break;
      case 'environment':
        extractEnvironment(line, lineNum);
        break;
      case 'data':
        extractData(line, lineNum);
        break;
      case 'procedure':
        extractProcedure(line, lineNum);
        break;
    }
  }

  // =========================================================================
  // IDENTIFICATION DIVISION extraction
  // =========================================================================
  function extractIdentification(line: string, lineNum: number): void {
    const m = line.match(RE_PROGRAM_ID);
    if (m) {
      if (result.programName === null) {
        result.programName = m[1];
      }

      // Reset state machine for new program (nested or sibling)
      currentDivision = 'identification';
      currentDataSection = 'unknown';
      currentEnvSection = null;
      currentParagraph = null;

      // Detect COMMON attribute
      const isCommon = /\bIS\s+COMMON\b/i.test(line);

      // Push program boundary for line-range tracking
      programBoundaryStack.push({
        name: m[1],
        startLine: lineNum,
        isCommon: isCommon || undefined,
      });
      return;
    }

    const authorMatch = line.match(RE_AUTHOR);
    if (authorMatch) {
      result.programMetadata.author = authorMatch[1].replace(/\.\s*$/, '').trim();
      return;
    }

    const dateMatch = line.match(RE_DATE_WRITTEN);
    if (dateMatch) {
      result.programMetadata.dateWritten = dateMatch[1].replace(/\.\s*$/, '').trim();
      return;
    }

    const compMatch = line.match(RE_DATE_COMPILED);
    if (compMatch) {
      result.programMetadata.dateCompiled = compMatch[1].replace(/\.\s*$/, '').trim();
      return;
    }
    const instMatch = line.match(RE_INSTALLATION);
    if (instMatch) {
      result.programMetadata.installation = instMatch[1].replace(/\.\s*$/, '').trim();
    }
  }

  // =========================================================================
  // ENVIRONMENT DIVISION extraction
  // =========================================================================
  function extractEnvironment(line: string, lineNum: number): void {
    if (currentEnvSection !== 'input-output') return;

    // Check for new SELECT statement
    const selMatch = line.match(RE_SELECT_START);
    if (selMatch) {
      // Flush any previous SELECT
      flushSelect();
      selectAccum = line.trim();
      selectStartLine = lineNum;
    } else if (selectAccum !== null) {
      // Accumulate continuation of current SELECT
      selectAccum += ' ' + line.trim();
    }

    // Check if current SELECT is terminated (ends with period)
    if (selectAccum !== null && /\.\s*$/.test(selectAccum)) {
      flushSelect();
    }
  }

  function flushSelect(): void {
    if (selectAccum === null) return;
    const decl = parseSelectStatement(selectAccum, selectStartLine);
    if (decl) {
      result.fileDeclarations.push(decl);
    }
    selectAccum = null;
  }

  function flushSort(): void {
    if (sortAccum === null) return;
    const fullSort = sortAccum;
    const smatch = fullSort.match(RE_SORT) || fullSort.match(RE_MERGE);
    if (smatch) {
      const upper = fullSort.toUpperCase();
      const usingIdx = upper.search(/\bUSING\s/);
      const givingIdx = upper.search(/\bGIVING\s/);
      const usingFiles: string[] = [];
      const givingFiles: string[] = [];
      if (usingIdx >= 0) {
        const afterUsing = fullSort.substring(usingIdx + 6);
        const gIdx = afterUsing.toUpperCase().search(/\bGIVING\b/);
        const usingText = gIdx >= 0 ? afterUsing.substring(0, gIdx) : afterUsing;
        usingFiles.push(
          ...usingText
            .trim()
            .split(/\s+/)
            .map((f) => f.replace(/\.$/, ''))
            .filter((f) => /^[A-Z][A-Z0-9-]+$/i.test(f) && !SORT_CLAUSE_NOISE.has(f.toUpperCase())),
        );
      }
      if (givingIdx >= 0) {
        const givingText = fullSort.substring(givingIdx + 7);
        givingFiles.push(
          ...givingText
            .trim()
            .split(/\s+/)
            .map((f) => f.replace(/\.$/, ''))
            .filter((f) => /^[A-Z][A-Z0-9-]+$/i.test(f) && !SORT_CLAUSE_NOISE.has(f.toUpperCase())),
        );
      }
      // INPUT PROCEDURE IS / OUTPUT PROCEDURE IS → control-flow targets (like PERFORM)
      // Supports optional THRU/THROUGH range: INPUT PROCEDURE IS proc-start THRU proc-end
      const inputProcMatch = fullSort.match(
        /\bINPUT\s+PROCEDURE\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)(?:\s+(?:THRU|THROUGH)\s+([A-Z][A-Z0-9-]+))?/i,
      );
      const outputProcMatch = fullSort.match(
        /\bOUTPUT\s+PROCEDURE\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)(?:\s+(?:THRU|THROUGH)\s+([A-Z][A-Z0-9-]+))?/i,
      );
      if (inputProcMatch) {
        result.performs.push({
          caller: currentParagraph,
          target: inputProcMatch[1],
          thruTarget: inputProcMatch[2] || undefined,
          line: sortStartLine,
        });
      }
      if (outputProcMatch) {
        result.performs.push({
          caller: currentParagraph,
          target: outputProcMatch[1],
          thruTarget: outputProcMatch[2] || undefined,
          line: sortStartLine,
        });
      }
      result.sorts.push({ sortFile: smatch[1], usingFiles, givingFiles, line: sortStartLine });
    }
    sortAccum = null;
  }

  function flushInspect(): void {
    if (inspectAccum === null) return;
    const text = inspectAccum;
    const fieldMatch = text.match(/\bINSPECT\s+([A-Z][A-Z0-9-]+)/i);
    if (!fieldMatch) {
      inspectAccum = null;
      return;
    }

    const counters: string[] = [];
    const tallySection = text.match(
      /\bTALLYING\b([\s\S]+?)(?:\bREPLACING\b|\bCONVERTING\b|\.\s*$)/i,
    );
    if (tallySection) {
      const counterRe = /([A-Z][A-Z0-9-]+)\s+FOR\b/gi;
      let cm: RegExpExecArray | null;
      while ((cm = counterRe.exec(tallySection[1])) !== null) {
        counters.push(cm[1]);
      }
    }

    const hasTallying = /\bTALLYING\b/i.test(text);
    const hasReplacing = /\bREPLACING\b/i.test(text);
    const hasConverting = /\bCONVERTING\b/i.test(text);
    const form = hasConverting
      ? ('converting' as const)
      : hasTallying && hasReplacing
        ? ('tallying-replacing' as const)
        : hasTallying
          ? ('tallying' as const)
          : ('replacing' as const);

    result.inspects.push({
      inspectedField: fieldMatch[1],
      counters,
      form,
      line: inspectStartLine,
      caller: currentParagraph,
    });
    inspectAccum = null;
  }

  /**
   * Flush accumulated multi-line CALL statement. Re-extracts CALL target
   * and USING parameters from the full accumulated text.
   */
  function flushCallAccum(): void {
    if (callAccum === null) return;
    const text = callAccum;

    // Extract quoted CALLs from the full statement
    for (const callMatch of text.matchAll(RE_CALL)) {
      const callTarget = callMatch[1] ?? callMatch[2];
      const afterCall = text.substring(callMatch.index! + callMatch[0].length);
      const usingMatch = afterCall.match(RE_USING_PARAMS);
      const parameters = usingMatch
        ? usingMatch[1]
            .split(/\bRETURNING\b/i)[0]
            .trim()
            .split(/\s+/)
            .filter(
              (s) =>
                s.length > 0 &&
                !CALL_USING_FILTER.has(s.toUpperCase()) &&
                /^[A-Z][A-Z0-9-]+$/i.test(s),
            )
        : undefined;
      const retMatch = afterCall.match(/\bRETURNING\s+([A-Z][A-Z0-9-]+)/i);
      const returning = retMatch ? retMatch[1] : undefined;
      result.calls.push({
        target: callTarget,
        line: callAccumLine,
        isQuoted: true,
        parameters,
        returning,
      });
    }

    // Extract dynamic CALLs from the full statement
    for (const dynCallMatch of text.matchAll(RE_CALL_DYNAMIC)) {
      const afterDynCall = text.substring(dynCallMatch.index! + dynCallMatch[0].length);
      const dynUsingMatch = afterDynCall.match(RE_USING_PARAMS);
      const dynParameters = dynUsingMatch
        ? dynUsingMatch[1]
            .split(/\bRETURNING\b/i)[0]
            .trim()
            .split(/\s+/)
            .filter(
              (s) =>
                s.length > 0 &&
                !CALL_USING_FILTER.has(s.toUpperCase()) &&
                /^[A-Z][A-Z0-9-]+$/i.test(s),
            )
        : undefined;
      const dynRetMatch = afterDynCall.match(/\bRETURNING\s+([A-Z][A-Z0-9-]+)/i);
      const dynReturning = dynRetMatch ? dynRetMatch[1] : undefined;
      result.calls.push({
        target: dynCallMatch[1],
        line: callAccumLine,
        isQuoted: false,
        parameters: dynParameters,
        returning: dynReturning,
      });
    }

    // Extract CANCELs from within the CALL block (common in ON EXCEPTION handlers)
    for (const cancelMatch of text.matchAll(RE_CANCEL)) {
      result.cancels.push({
        target: cancelMatch[1] ?? cancelMatch[2],
        line: callAccumLine,
        isQuoted: true,
      });
    }
    for (const dynCancelMatch of text.matchAll(RE_CANCEL_DYNAMIC)) {
      result.cancels.push({ target: dynCancelMatch[1], line: callAccumLine, isQuoted: false });
    }

    callAccum = null;
  }

  // =========================================================================
  // DATA DIVISION extraction
  // =========================================================================
  function extractData(line: string, lineNum: number): void {
    // FD entry
    const fdMatch = line.match(RE_FD);
    if (fdMatch) {
      // Flush any previous FD without a record
      if (pendingFdName !== null) {
        result.fdEntries.push({ fdName: pendingFdName, line: pendingFdLine });
      }
      pendingFdName = fdMatch[1];
      pendingFdLine = lineNum;
      return;
    }

    // 88-level condition names
    const lv88Match = line.match(RE_88_LEVEL);
    if (lv88Match) {
      const name = lv88Match[1];
      const values = parseConditionValues(lv88Match[2]);
      result.dataItems.push({
        name,
        level: 88,
        line: lineNum,
        values,
        section: currentDataSection,
      });
      return;
    }

    // Level 66 RENAMES
    const lv66Match = line.match(RE_66_LEVEL);
    if (lv66Match) {
      result.dataItems.push({
        name: lv66Match[1],
        level: 66,
        line: lineNum,
        redefines: lv66Match[2], // RENAMES target stored as redefines
        section: currentDataSection,
      });
      return;
    }

    // Anonymous REDEFINES (no name, e.g. "01 REDEFINES WK-PERIVAL.")
    const anonRedefMatch = line.match(RE_ANONYMOUS_REDEFINES);
    if (anonRedefMatch) {
      // Check it's truly anonymous: the second capture is not a valid data name
      // followed by more clauses — it's the REDEFINES target directly after level
      const level = parseInt(anonRedefMatch[1], 10);
      // Only skip if this is genuinely "NN REDEFINES target" with no name between
      // We detect this by checking the full data item regex does NOT match
      // (because RE_DATA_ITEM expects a name before any clauses)
      const dataMatch = line.match(RE_DATA_ITEM);
      if (!dataMatch || dataMatch[2].toUpperCase() === 'REDEFINES') {
        // Truly anonymous — skip, no node
        return;
      }
    }

    // Standard data items: level 01-49, 66, 77
    const dataMatch = line.match(RE_DATA_ITEM);
    if (dataMatch) {
      const level = parseInt(dataMatch[1], 10);
      const name = dataMatch[2];
      const rest = dataMatch[3] || '';

      // Skip FILLER
      if (name.toUpperCase() === 'FILLER') return;

      // Valid levels: 01-49, 66, 77
      if ((level >= 1 && level <= 49) || level === 66 || level === 77) {
        const clauses = parseDataItemClauses(rest);

        const item: CobolRegexResults['dataItems'][number] = {
          name,
          level,
          line: lineNum,
          section: currentDataSection,
        };
        if (clauses.pic) item.pic = clauses.pic;
        if (clauses.usage) item.usage = clauses.usage;
        if (clauses.occurs !== undefined) item.occurs = clauses.occurs;
        if (clauses.dependingOn) item.dependingOn = clauses.dependingOn;
        if (clauses.redefines) item.redefines = clauses.redefines;
        if (clauses.value) item.values = [clauses.value];
        if (clauses.isExternal) item.isExternal = true;
        if (clauses.isGlobal) item.isGlobal = true;

        result.dataItems.push(item);

        // If there's a pending FD and this is a 01-level, it's the FD's record
        if (pendingFdName !== null && level === 1) {
          result.fdEntries.push({
            fdName: pendingFdName,
            recordName: name,
            line: pendingFdLine,
          });
          pendingFdName = null;
        }
      }
    }
  }

  // =========================================================================
  // PROCEDURE DIVISION extraction
  // =========================================================================
  function extractProcedure(line: string, lineNum: number): void {
    // USE AFTER EXCEPTION in DECLARATIVES
    if (inDeclaratives) {
      const useMatch = line.match(RE_USE_AFTER);
      if (useMatch) {
        // Find the most recent section name
        const lastSection = result.sections[result.sections.length - 1];
        if (lastSection) {
          result.declaratives.push({
            sectionName: lastSection.name,
            target: useMatch[1],
            line: lineNum,
          });
        }
        return;
      }
    }

    // Handle PROCEDURE DIVISION USING on a continuation line
    if (pendingProcUsing) {
      const usingMatch = line.match(/\bUSING\s+([\s\S]*?)(?:\.|$)/i);
      if (usingMatch) {
        const params = usingMatch[1]
          .split(/\bRETURNING\b/i)[0]
          .trim()
          .split(/\s+/)
          .filter((s) => s.length > 0 && !USING_KEYWORDS.has(s.toUpperCase()));
        result.procedureUsing = params;
        const topProg = programBoundaryStack[programBoundaryStack.length - 1];
        if (topProg) topProg.procedureUsing = params;
      }
      pendingProcUsing = false;
      if (usingMatch) return; // consumed the USING line
    }

    // Section header
    const secMatch = line.match(RE_PROC_SECTION);
    if (secMatch) {
      const name = secMatch[1];
      if (
        !EXCLUDED_PARA_NAMES.has(name.toUpperCase()) &&
        !name.toUpperCase().includes('DIVISION')
      ) {
        result.sections.push({ name, line: lineNum });
        // Don't set currentParagraph to section name — sections are Namespaces,
        // not Functions. Setting it here would cause PERFORMs to be attributed
        // to the section instead of the containing paragraph.
      }
      return;
    }

    // Paragraph header
    const paraMatch = line.match(RE_PROC_PARAGRAPH);
    if (paraMatch) {
      const name = paraMatch[1];
      // In fixed-format, paragraphs must start in Area A (col 8-11, max 7 leading spaces).
      // Reject deeply-indented lines (Area B, 8+ spaces) to prevent false paragraphs from
      // data items or CALL USING parameters on continuation lines.
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (!isFreeFormat && leadingSpaces > 7) return; // Area B — not a paragraph
      if (
        !EXCLUDED_PARA_NAMES.has(name.toUpperCase()) &&
        !name.toUpperCase().startsWith('END-') &&
        name.toUpperCase() !== 'DIVISION' &&
        name.toUpperCase() !== 'SECTION'
      ) {
        result.paragraphs.push({ name, line: lineNum });
        currentParagraph = name;
      }
      return;
    }

    // PERFORM (global — captures multiple PERFORMs on the same logical line)
    for (const perfMatch of line.matchAll(RE_PERFORM)) {
      const target = perfMatch[1];
      // Skip COBOL inline-perform keywords that are not paragraph names
      if (!PERFORM_KEYWORD_SKIP.has(target.toUpperCase())) {
        // Also check for "PERFORM identifier TIMES" — the identifier is a
        // data item count, not a paragraph name (fundamental regex ambiguity).
        const matchEnd = perfMatch.index! + perfMatch[0].length;
        const afterTarget = line.substring(matchEnd).trim();
        if (!/^TIMES\b/i.test(afterTarget)) {
          result.performs.push({
            caller: currentParagraph,
            target,
            thruTarget: perfMatch[2] || undefined,
            line: lineNum,
          });
        }
      }
    }

    // ENTRY point
    const entryMatch = line.match(RE_ENTRY);
    if (entryMatch) {
      const entryName = entryMatch[1] ?? entryMatch[2];
      const usingClause = entryMatch[3];
      if (entryName) {
        result.entryPoints.push({
          name: entryName,
          parameters: usingClause
            ? usingClause
                .trim()
                .split(/\s+/)
                .filter((s) => s.length > 0 && !USING_KEYWORDS.has(s.toUpperCase()))
            : [],
          line: lineNum,
        });
      }
    }

    // MOVE statement (skip literals and figurative constants)
    const moveMatch = line.match(RE_MOVE);
    if (moveMatch) {
      const from = moveMatch[2].toUpperCase();
      if (!MOVE_SKIP.has(from)) {
        const isCorresponding = !!moveMatch[1];
        // MOVE CORRESPONDING is always single-target per COBOL standard
        const targets = isCorresponding
          ? [moveMatch[3].replace(/\..*$/, '').trim().split(/\s+/)[0]].filter((t) =>
              /^[A-Z][A-Z0-9-]+$/i.test(t),
            )
          : extractMoveTargets(moveMatch[3]);

        if (targets.length > 0) {
          result.moves.push({
            from: moveMatch[2],
            targets,
            line: lineNum,
            caller: currentParagraph,
            corresponding: isCorresponding,
          });
        }
      }
    }

    // GO TO — control flow transfer (handles GO TO p1 p2 p3 DEPENDING ON x)
    const gotoMatch = line.match(RE_GOTO);
    if (gotoMatch) {
      const targets = gotoMatch[1]
        .trim()
        .split(/\s+/)
        .filter((t) => /^[A-Z][A-Z0-9-]+$/i.test(t));
      for (const target of targets) {
        result.gotos.push({ caller: currentParagraph, target, line: lineNum });
      }
    }

    // SORT / MERGE file references (multi-line: accumulate until period)
    if (sortAccum !== null) {
      // Continue accumulating SORT/MERGE statement
      sortAccum += ' ' + line;
      if (!/\.\s*$/.test(sortAccum)) return; // still accumulating — skip other extractors
      // Period found — flush, then re-check line for a new SORT/MERGE after the period
      flushSort();
      // After flushing, fall through to check if this line also starts a new SORT/MERGE
    }
    const sortMatch = line.match(RE_SORT) || line.match(RE_MERGE);
    if (sortMatch && sortAccum === null) {
      sortAccum = line;
      sortStartLine = lineNum;
      if (!/\.\s*$/.test(sortAccum)) return; // multi-line — wait for period
      flushSort();
    }

    // INSPECT — multi-line accumulator (like SORT)
    // If a real paragraph/section header or statement verb arrives during accumulation,
    // flush the INSPECT as-is and process the line normally.
    if (inspectAccum !== null) {
      const inspTrimmed = line.trimStart();
      const inspLeading = line.match(/^(\s*)/)?.[1].length ?? 0;
      const inspIsAreaAPara =
        RE_PROC_PARAGRAPH.test(line) && (!isFreeFormat ? inspLeading <= 7 : false);
      if (
        RE_PROC_SECTION.test(line) ||
        inspIsAreaAPara ||
        RE_STATEMENT_VERB_START.test(inspTrimmed) ||
        /^CALL(?:\s|$)/i.test(inspTrimmed)
      ) {
        flushInspect();
        // Fall through to process this line normally
      } else {
        inspectAccum += ' ' + line;
        if (/\.\s*$/.test(inspectAccum)) {
          flushInspect();
        } else {
          return;
        }
      }
    }
    const inspectMatch = line.match(/\bINSPECT\s+([A-Z][A-Z0-9-]+)/i);
    if (inspectMatch && inspectAccum === null) {
      inspectAccum = line;
      inspectStartLine = lineNum;
      if (!/\.\s*$/.test(inspectAccum)) return;
      flushInspect();
    }

    // SEARCH — table access
    const searchMatch = line.match(RE_SEARCH);
    if (searchMatch) {
      result.searches.push({ target: searchMatch[1], line: lineNum });
    }

    // CANCEL — program lifecycle (global matchAll captures multiple CANCELs on same line)
    for (const cancelMatch of line.matchAll(RE_CANCEL)) {
      result.cancels.push({
        target: cancelMatch[1] ?? cancelMatch[2],
        line: lineNum,
        isQuoted: true,
      });
    }
    // Dynamic CANCEL — RE_CANCEL_DYNAMIC cannot match quoted targets, no dedup guard needed
    for (const dynCancelMatch of line.matchAll(RE_CANCEL_DYNAMIC)) {
      result.cancels.push({ target: dynCancelMatch[1], line: lineNum, isQuoted: false });
    }

    // SET statement (condition, index)
    const setTrueMatch = line.match(RE_SET_TO_TRUE);
    if (setTrueMatch) {
      const targets = setTrueMatch[1]
        .trim()
        .split(/\s+/)
        .filter((t) => /^[A-Z][A-Z0-9-]+$/i.test(t) && t.toUpperCase() !== 'OF');
      if (targets.length > 0) {
        result.sets.push({ targets, form: 'to-true', line: lineNum, caller: currentParagraph });
      }
    } else {
      const setIdxMatch = line.match(RE_SET_INDEX);
      if (setIdxMatch) {
        const targets = setIdxMatch[1]
          .trim()
          .split(/\s+/)
          .filter((t) => /^[A-Z][A-Z0-9-]+$/i.test(t));
        const mode = setIdxMatch[2].toUpperCase();
        const form =
          mode === 'TO'
            ? ('to-value' as const)
            : mode.startsWith('UP')
              ? ('up-by' as const)
              : ('down-by' as const);
        result.sets.push({
          targets,
          form,
          value: setIdxMatch[3],
          line: lineNum,
          caller: currentParagraph,
        });
      }
    }

    // INITIALIZE — data reset (multi-target: INITIALIZE WS-A WS-B WS-C.)
    const initMatch = line.match(RE_INITIALIZE);
    if (initMatch) {
      const targets = initMatch[1]
        .trim()
        .split(/\s+/)
        .filter(
          (t) => /^[A-Z][A-Z0-9-]+$/i.test(t) && !INITIALIZE_CLAUSE_KEYWORDS.has(t.toUpperCase()),
        );
      for (const target of targets) {
        result.initializes.push({ target, line: lineNum, caller: currentParagraph });
      }
    }
  }
}
