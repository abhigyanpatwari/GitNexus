/**
 * `emitScopeCaptures` for COBOL.
 *
 * Wraps the existing regex tagger (`extractCobolSymbolsWithRegex`) and
 * produces parser-agnostic `CaptureMatch[]` matching the RFC §5.1
 * vocabulary. The central `ScopeExtractor` consumes these captures
 * without knowing whether they came from tree-sitter or regex.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 * The regex tagger is synchronous — no async needed.
 */

import type { Capture, CaptureMatch, Range } from 'gitnexus-shared';
import {
  extractCobolSymbolsWithRegex,
  preprocessCobolSource,
} from '../../cobol/cobol-preprocessor.js';

// ---------------------------------------------------------------------------
// Capture building helpers
// ---------------------------------------------------------------------------

function capture(name: string, range: Range, text: string): Capture {
  return { name, range, text };
}

function rangeOf(startLine: number, startCol: number, endLine: number, endCol: number): Range {
  return { startLine, startCol, endLine, endCol };
}

/**
 * Build a single CaptureMatch from a record of captures.
 * Returns null if the record is empty.
 */
function matchFrom(grouped: Record<string, Capture>): CaptureMatch | null {
  if (Object.keys(grouped).length === 0) return null;
  return Object.freeze(grouped) as CaptureMatch;
}

/**
 * Compute end column for a single-line capture from the source lines array.
 */
function endColFrom(line: string): number {
  return line.length > 0 ? line.length - 1 : 0;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function emitCobolScopeCaptures(
  sourceText: string,
  _filePath: string,
  _cachedTree?: unknown,
): readonly CaptureMatch[] {
  const lines = sourceText.split(/\r?\n/);
  // Preprocess: strip patch markers from columns 1-6
  const cleaned = preprocessCobolSource(sourceText);
  // Run the regex tagger on the preprocessed source
  const extracted = extractCobolSymbolsWithRegex(cleaned, _filePath);

  const out: CaptureMatch[] = [];

  // ── 1. PROGRAM-ID → @scope.module ───────────────────────────────────
  // The primary program name (first PROGRAM-ID encountered)
  if (extracted.programName) {
    const name = extracted.programName;
    const lastLine = lines.length;

    const progDef = extracted.programs.find((p) => p.name.toUpperCase() === name.toUpperCase());
    const startLine = progDef?.startLine ?? 1;
    const endLine = progDef?.endLine ?? lastLine;
    const startCol = 0;
    const endCol = endColFrom(lines[Math.min(endLine, lines.length) - 1] ?? '');

    const progIdLine = findProgramIdLine(cleaned, name);
    // Determine PROGRAM-ID name column: free-format has no fixed column;
    // fixed-format uses column 7 (after 6-char sequence area replaced by preprocessing)
    const isFreeFormat = />>SOURCE\s+(?:FORMAT\s+(?:IS\s+)?)?FREE/i.test(cleaned);
    const nameCol = isFreeFormat ? findProgramIdNameColumn(lines, progIdLine) : 7;
    const nameRange =
      progIdLine !== -1
        ? rangeOf(progIdLine, nameCol, progIdLine, lines[progIdLine - 1]?.length ?? endCol)
        : rangeOf(startLine, startCol, endLine, endCol);

    const grouped: Record<string, Capture> = {
      '@scope.module': capture(
        '@scope.module',
        rangeOf(startLine, startCol, endLine, endCol),
        name,
      ),
      '@declaration.program': capture(
        '@declaration.program',
        rangeOf(startLine, startCol, endLine, endCol),
        name,
      ),
      '@declaration.name': capture('@declaration.name', nameRange, name),
    };

    if (progDef?.procedureUsing && progDef.procedureUsing.length > 0) {
      grouped['@declaration.parameter-count'] = capture(
        '@declaration.parameter-count',
        nameRange,
        String(progDef.procedureUsing.length),
      );
    }

    const m = matchFrom(grouped);
    if (m !== null) out.push(m);
  }

  // ── 2. Nested / additional programs → @scope.module ──────────────
  for (const prog of extracted.programs) {
    if (extracted.programName && prog.name.toUpperCase() === extracted.programName.toUpperCase())
      continue;

    const startLine = prog.startLine;
    const endLine = prog.endLine;
    const startCol = 0;
    const endCol = endColFrom(lines[Math.min(endLine, lines.length) - 1] ?? '');

    const progIdLine = findProgramIdLine(cleaned, prog.name);
    const isFreeFormatNested = />>SOURCE\s+(?:FORMAT\s+(?:IS\s+)?)?FREE/i.test(cleaned);
    const nameColNested = isFreeFormatNested ? findProgramIdNameColumn(lines, progIdLine) : 7;
    const nameRange =
      progIdLine !== -1
        ? rangeOf(progIdLine, nameColNested, progIdLine, lines[progIdLine - 1]?.length ?? endCol)
        : rangeOf(startLine, startCol, endLine, endCol);

    const grouped: Record<string, Capture> = {
      '@scope.module': capture(
        '@scope.module',
        rangeOf(startLine, startCol, endLine, endCol),
        prog.name,
      ),
      '@declaration.program': capture(
        '@declaration.program',
        rangeOf(startLine, startCol, endLine, endCol),
        prog.name,
      ),
      '@declaration.name': capture('@declaration.name', nameRange, prog.name),
    };

    if (prog.procedureUsing && prog.procedureUsing.length > 0) {
      grouped['@declaration.parameter-count'] = capture(
        '@declaration.parameter-count',
        nameRange,
        String(prog.procedureUsing.length),
      );
    }

    const m = matchFrom(grouped);
    if (m !== null) out.push(m);
  }

  // ── 3. PROCEDURE DIVISION sections → @scope.function ─────────────
  for (const section of extracted.sections) {
    const lineIdx = section.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const sectionLine = lines[lineIdx];
    const startCol = 0;
    const endCol = endColFrom(sectionLine);
    const nameRange = rangeOf(section.line, startCol, section.line, endCol);

    const grouped: Record<string, Capture> = {
      '@scope.function': capture('@scope.function', nameRange, section.name),
      '@declaration.function': capture('@declaration.function', nameRange, section.name),
      '@declaration.name': capture('@declaration.name', nameRange, section.name),
    };

    const m = matchFrom(grouped);
    if (m !== null) out.push(m);
  }

  // ── 4. Paragraphs → @scope.function ──────────────────────────────
  for (const para of extracted.paragraphs) {
    const lineIdx = para.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const paraLine = lines[lineIdx];
    const startCol = 0;
    const endCol = endColFrom(paraLine);
    const nameRange = rangeOf(para.line, startCol, para.line, endCol);

    const grouped: Record<string, Capture> = {
      '@scope.function': capture('@scope.function', nameRange, para.name),
      '@declaration.function': capture('@declaration.function', nameRange, para.name),
      '@declaration.name': capture('@declaration.name', nameRange, para.name),
    };

    const m = matchFrom(grouped);
    if (m !== null) out.push(m);
  }

  // ── 5. COPY → @import.statement ──────────────────────────────────
  for (const copy of extracted.copies) {
    const lineIdx = copy.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const copyLine = lines[lineIdx];
    const startCol = 0;
    const endCol = endColFrom(copyLine);
    const stmtRange = rangeOf(copy.line, startCol, copy.line, endCol);

    const grouped: Record<string, Capture> = {
      '@import.statement': capture('@import.statement', stmtRange, copy.target),
      '@import.name': capture('@import.name', stmtRange, copy.target),
    };

    const m = matchFrom(grouped);
    if (m !== null) out.push(m);
  }

  // ── 6. CALL (quoted/referenced) → @reference.call ────────────────
  for (const call of extracted.calls) {
    const lineIdx = call.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const callLine = lines[lineIdx];
    const startCol = 0;
    const endCol = endColFrom(callLine);
    const stmtRange = rangeOf(call.line, startCol, call.line, endCol);

    const grouped: Record<string, Capture> = {
      '@reference.call': capture('@reference.call', stmtRange, call.target),
      '@reference.name': capture('@reference.name', stmtRange, call.target),
    };

    // Arity from CALL USING parameters
    if (call.parameters && call.parameters.length > 0) {
      grouped['@reference.arity'] = capture(
        '@reference.arity',
        stmtRange,
        String(call.parameters.length),
      );
    }

    const m = matchFrom(grouped);
    if (m !== null) out.push(m);
  }

  // ── 7. PERFORM → @reference.call ─────────────────────────────────
  for (const perf of extracted.performs) {
    const lineIdx = perf.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const perfLine = lines[lineIdx];
    const startCol = 0;
    const endCol = endColFrom(perfLine);
    const stmtRange = rangeOf(perf.line, startCol, perf.line, endCol);

    const grouped: Record<string, Capture> = {
      '@reference.call': capture('@reference.call', stmtRange, perf.target),
      '@reference.name': capture('@reference.name', stmtRange, perf.target),
    };

    const m = matchFrom(grouped);
    if (m !== null) out.push(m);
  }

  // ── 8. GO TO → @reference.call ───────────────────────────────────
  for (const gt of extracted.gotos) {
    const lineIdx = gt.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const gtLine = lines[lineIdx];
    const startCol = 0;
    const endCol = endColFrom(gtLine);
    const stmtRange = rangeOf(gt.line, startCol, gt.line, endCol);

    const grouped: Record<string, Capture> = {
      '@reference.call': capture('@reference.call', stmtRange, gt.target),
      '@reference.name': capture('@reference.name', stmtRange, gt.target),
    };

    const m = matchFrom(grouped);
    if (m !== null) out.push(m);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the PROGRAM-ID. line for a given program name in the cleaned source.
 * Returns 1-based line number, or -1 if not found.
 */
function findProgramIdLine(cleanedSource: string, programName: string): number {
  const lines = cleanedSource.split(/\r?\n/);
  const upper = programName.toUpperCase();
  const re = new RegExp(`\\bPROGRAM-ID\\.\\s*${escapeRegex(upper)}\\b`, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1; // 1-based
  }
  return -1;
}

/** Simple regex escape for special chars. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the column position of the program name on the PROGRAM-ID line.
 * Searches for `PROGRAM-ID. name` and returns the column where name starts.
 * Returns 0 as fallback if the line can't be parsed (the range will be
 * from column 0 which is still valid for capture bounds).
 */
function findProgramIdNameColumn(lines: string[], lineNum: number): number {
  if (lineNum < 1 || lineNum > lines.length) return 0;
  const line = lines[lineNum - 1];
  const m = line.match(/\bPROGRAM-ID\.\s+([A-Z0-9][A-Z0-9-]*)/i);
  if (!m || m.index === undefined) return 0;
  // Column = index of start of capture group 1
  const nameStart = m.index + m[0].length - m[1].length;
  return nameStart;
}
