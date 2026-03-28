/**
 * JCL Parser — Regex single-pass extraction.
 *
 * Extracts JCL constructs from mainframe job streams:
 * - JOB statements (job name, CLASS, MSGCLASS)
 * - EXEC statements (step -> program or proc)
 * - DD statements (dataset references, DISP)
 * - PROC definitions (in-stream and catalogued)
 * - INCLUDE MEMBER= directives
 * - SET symbolic parameters
 * - IF/ELSE/ENDIF conditional execution
 * - JCLLIB ORDER= search paths
 *
 * Pattern follows cobol-preprocessor.ts — regex-only, no tree-sitter.
 */

export interface JclParseResults {
  jobs: Array<{ name: string; line: number; class?: string; msgclass?: string }>;
  steps: Array<{ name: string; jobName: string; program?: string; proc?: string; line: number }>;
  ddStatements: Array<{
    ddName: string;
    stepName: string;
    dataset?: string;
    disp?: string;
    line: number;
  }>;
  procs: Array<{ name: string; line: number; isInStream: boolean }>;
  includes: Array<{ member: string; line: number }>;
  sets: Array<{ variable: string; value: string; line: number }>;
  jcllib: Array<{ order: string[]; line: number }>;
  conditionals: Array<{ type: 'IF' | 'ELSE' | 'ENDIF'; condition?: string; line: number }>;
}

// ── JCL statement patterns ─────────────────────────────────────────────

// JCL continuation: line ends with a non-blank in col 72, next line starts with //
// We handle continuations by joining lines before matching.

/** Match //jobname JOB ... */
const JOB_RE = /^\/\/(\w{1,8})\s+JOB\s+(.*)/i;

/** Match //stepname EXEC PGM=program or //stepname EXEC procname */
const EXEC_RE = /^\/\/(\w{1,8})\s+EXEC\s+(.*)/i;

/** Match //ddname DD ... */
const DD_RE = /^\/\/(\w{1,8})\s+DD\s+(.*)/i;

/** Match // JCLLIB ORDER=(lib1,lib2,...) */
const JCLLIB_RE = /^\/\/\s+JCLLIB\s+ORDER=\(([^)]+)\)/i;

/** Match // IF condition THEN */
const IF_RE = /^\/\/\s+IF\s+(.+)\s+THEN/i;

/** Match // ELSE */
const ELSE_RE = /^\/\/\s+ELSE\b/i;

/** Match // ENDIF */
const ENDIF_RE = /^\/\/\s+ENDIF\b/i;

/** Match // INCLUDE MEMBER=name */
const INCLUDE_RE = /^\/\/\s+INCLUDE\s+MEMBER=(\w+)/i;

/** Match // SET var=value */
const SET_RE = /^\/\/\s+SET\s+(\w+)=(.+)/i;

/** Match // PROC or //name PROC */
const PROC_RE = /^\/\/(\w*)\s+PROC\b/i;

/** Match // PEND */
const PEND_RE = /^\/\/\s+PEND\b/i;

// ── Parameter extractors ───────────────────────────────────────────────

function extractParam(params: string, key: string): string | undefined {
  // Match KEY=VALUE or KEY='VALUE' in JCL parameter string
  const re = new RegExp(`${key}=(?:'([^']*)'|(\\S+?))(?:[,\\s]|$)`, 'i');
  const m = params.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

function extractPgm(params: string): string | undefined {
  return extractParam(params, 'PGM');
}

function extractProc(params: string): string | undefined {
  // If no PGM= keyword, the first positional parameter is the proc name
  if (/PGM=/i.test(params)) return undefined;
  const cleaned = params.replace(/,.*/, '').trim();
  // Proc name is the first token (no = sign)
  if (cleaned && !cleaned.includes('=')) {
    return cleaned.replace(/[,\s].*/s, '').toUpperCase();
  }
  return undefined;
}

function extractDsn(params: string): string | undefined {
  return extractParam(params, 'DSN') ?? extractParam(params, 'DSNAME');
}

function extractDisp(params: string): string | undefined {
  const m = params.match(/DISP=\(?\s*([^),\s]+)/i);
  return m ? m[1] : undefined;
}

/**
 * Parse a JCL file and extract all constructs.
 *
 * @param content - Raw JCL file content
 * @param filePath - Path for diagnostics (not used in extraction)
 * @returns Parsed JCL results
 */
export function parseJcl(content: string, filePath: string): JclParseResults {
  const results: JclParseResults = {
    jobs: [],
    steps: [],
    ddStatements: [],
    procs: [],
    includes: [],
    sets: [],
    jcllib: [],
    conditionals: [],
  };

  const rawLines = content.split(/\r?\n/);
  // Join continuation lines: a line ending with non-blank in col 71 (0-indexed)
  // followed by a line starting with // is a continuation.
  const lines: Array<{ text: string; lineNum: number }> = [];
  let i = 0;
  while (i < rawLines.length) {
    let line = rawLines[i];
    const lineNum = i + 1;

    // JCL continuation: if line is exactly 72+ chars and col 72 is non-blank
    // and the next line starts with //, join them.
    while (
      i + 1 < rawLines.length &&
      line.length >= 72 &&
      line[71] !== ' ' &&
      rawLines[i + 1].startsWith('//')
    ) {
      i++;
      // Continuation text starts after // and leading spaces
      const contText = rawLines[i].substring(2).replace(/^\s+/, ' ');
      // Remove the continuation marker (col 72+) from current line
      line = line.substring(0, 71).trimEnd() + contText;
    }

    lines.push({ text: line, lineNum });
    i++;
  }

  let currentJobName = '';
  let currentStepName = '';
  let inStreamProcName = '';

  for (const { text, lineNum } of lines) {
    // Skip JCL comments (starting with //* )
    if (text.startsWith('//*')) continue;
    // Skip non-JCL lines (don't start with //)
    if (!text.startsWith('//')) continue;

    // PROC definition (in-stream)
    const procMatch = text.match(PROC_RE);
    if (procMatch) {
      const procName = procMatch[1] || inStreamProcName;
      if (procName) {
        results.procs.push({ name: procName.toUpperCase(), line: lineNum, isInStream: true });
      }
      inStreamProcName = procName?.toUpperCase() || '';
      continue;
    }

    // PEND (end of in-stream proc)
    if (PEND_RE.test(text)) {
      inStreamProcName = '';
      continue;
    }

    // JCLLIB ORDER=
    const jcllibMatch = text.match(JCLLIB_RE);
    if (jcllibMatch) {
      const libs = jcllibMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
      results.jcllib.push({ order: libs, line: lineNum });
      continue;
    }

    // IF/ELSE/ENDIF
    const ifMatch = text.match(IF_RE);
    if (ifMatch) {
      results.conditionals.push({ type: 'IF', condition: ifMatch[1].trim(), line: lineNum });
      continue;
    }
    if (ELSE_RE.test(text)) {
      results.conditionals.push({ type: 'ELSE', line: lineNum });
      continue;
    }
    if (ENDIF_RE.test(text)) {
      results.conditionals.push({ type: 'ENDIF', line: lineNum });
      continue;
    }

    // INCLUDE MEMBER=
    const includeMatch = text.match(INCLUDE_RE);
    if (includeMatch) {
      results.includes.push({ member: includeMatch[1].toUpperCase(), line: lineNum });
      continue;
    }

    // SET var=value
    const setMatch = text.match(SET_RE);
    if (setMatch) {
      results.sets.push({
        variable: setMatch[1].toUpperCase(),
        value: setMatch[2].trim().replace(/,\s*$/, ''),
        line: lineNum,
      });
      continue;
    }

    // JOB statement
    const jobMatch = text.match(JOB_RE);
    if (jobMatch) {
      currentJobName = jobMatch[1].toUpperCase();
      const params = jobMatch[2];
      results.jobs.push({
        name: currentJobName,
        line: lineNum,
        class: extractParam(params, 'CLASS'),
        msgclass: extractParam(params, 'MSGCLASS'),
      });
      continue;
    }

    // EXEC statement
    const execMatch = text.match(EXEC_RE);
    if (execMatch) {
      currentStepName = execMatch[1].toUpperCase();
      const params = execMatch[2];
      const pgm = extractPgm(params);
      const proc = pgm ? undefined : extractProc(params);

      results.steps.push({
        name: currentStepName,
        jobName: currentJobName,
        program: pgm?.toUpperCase(),
        proc: proc?.toUpperCase(),
        line: lineNum,
      });
      continue;
    }

    // DD statement
    const ddMatch = text.match(DD_RE);
    if (ddMatch) {
      const ddName = ddMatch[1].toUpperCase();
      const params = ddMatch[2];
      results.ddStatements.push({
        ddName,
        stepName: currentStepName,
        dataset: extractDsn(params)?.toUpperCase(),
        disp: extractDisp(params)?.toUpperCase(),
        line: lineNum,
      });
      continue;
    }
  }

  return results;
}
