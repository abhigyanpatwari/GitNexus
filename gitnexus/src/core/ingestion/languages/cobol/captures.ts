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
import { preprocessCobolSource } from '../../cobol/cobol-preprocessor.js';
import { cobolSemanticCaptures, readCobolSemanticSource } from './semantic.js';

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
  const facts = readCobolSemanticSource(sourceText, _filePath);
  const extracted = facts.extracted;

  const out: CaptureMatch[] = [];
  const procedurePointers = new Set(
    extracted.dataItems
      .filter((item) => /(?:PROCEDURE|FUNCTION)-POINTER/.test(item.usage?.toUpperCase() ?? ''))
      .map((item) => item.name.toUpperCase()),
  );
  // Fallback for declarations the clause parser missed. Scan CLEANED lines —
  // on raw fixed-format sources the sequence number (cols 1-6) satisfied
  // `\d+` and the LEVEL NUMBER got captured as the name, so the set never
  // contained the real pointer name and the whole feature no-op'd (#2522
  // review, H3). COBOL data names must contain a letter, so `[A-Z]` first
  // rejects level numbers.
  for (const line of cleaned.split(/\r?\n/)) {
    const declaration = line.match(
      /^\s*\d{1,2}\s+([A-Z][A-Z0-9-]*).*\b(?:PROCEDURE|FUNCTION)-POINTER\b/i,
    );
    if (declaration !== null) procedurePointers.add(declaration[1]!.toUpperCase());
  }

  // Exact declaration/reference captures share the provider's semantic source
  // facts with ordinary resolution and rename; callable-value facts remain below.
  out.push(...cobolSemanticCaptures(facts));
  for (const copy of extracted.copies) {
    const stmtRange = rangeOf(copy.line, 0, copy.line, lines[copy.line - 1]?.length ?? 0);
    out.push({
      '@import.statement': capture('@import.statement', stmtRange, copy.target),
      '@import.name': capture('@import.name', stmtRange, copy.target),
    });
  }

  // ── 9. Procedure-pointer value flow ────────────────────────────────
  // ISO COBOL exposes callable values through USAGE PROCEDURE-POINTER,
  // SET ... TO ENTRY, and dynamic CALL data-items. The regex provider emits
  // the same normalized facts as AST-backed providers so shared ingestion
  // remains language-agnostic.
  for (const program of extracted.programs) {
    for (let index = 0; index < (program.procedureUsing?.length ?? 0); index++) {
      const parameter = program.procedureUsing![index]!;
      const ownerRange = rangeOf(program.startLine, 0, program.endLine, 0);
      out.push({
        '@callable-flow.formal': capture('@callable-flow.formal', ownerRange, program.name),
        '@callable-flow.owner': capture('@callable-flow.owner', ownerRange, program.name),
        '@callable-flow.binding': capture(
          '@callable-flow.binding',
          rangeOf(program.startLine, 0, program.startLine, parameter.length),
          parameter,
        ),
        '@callable-flow.parameter-index': capture(
          '@callable-flow.parameter-index',
          ownerRange,
          String(index),
        ),
        '@callable-flow.passing-mode': capture(
          '@callable-flow.passing-mode',
          ownerRange,
          'reference',
        ),
      });
    }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    // Comment lines must not seed flows — a commented-out SET produced a
    // live seed and a false CALLS edge from dead code (#2522 review, M1).
    // Fixed format marks comments with '*'/'/' in indicator column 7; free
    // format uses '*>' (also valid inline, so strip the tail).
    if (line[6] === '*' || line[6] === '/') continue;
    const code = line.split('*>')[0]!;
    const lineNumber = index + 1;
    const lineRange = rangeOf(lineNumber, 0, lineNumber, endColFrom(line));
    const entry = code.match(
      /\bSET\s+([A-Z0-9][A-Z0-9-]*)\s+TO\s+ENTRY\s+(?:"([^"]+)"|'([^']+)')/i,
    );
    if (entry !== null) {
      const destination = entry[1]!;
      const target = entry[2] ?? entry[3]!;
      if (procedurePointers.has(destination.toUpperCase())) {
        out.push({
          '@callable-flow.seed': capture('@callable-flow.seed', lineRange, line),
          '@callable-flow.destination': capture(
            '@callable-flow.destination',
            lineRange,
            destination,
          ),
          '@callable-flow.target': capture('@callable-flow.target', lineRange, target),
          '@callable-flow.target-name': capture('@callable-flow.target-name', lineRange, target),
        });
      }
      continue;
    }
    const copy = code.match(/\bSET\s+([A-Z0-9][A-Z0-9-]*)\s+TO\s+([A-Z0-9][A-Z0-9-]*)\b/i);
    if (
      copy !== null &&
      procedurePointers.has(copy[1]!.toUpperCase()) &&
      procedurePointers.has(copy[2]!.toUpperCase())
    ) {
      out.push({
        '@callable-flow.copy': capture('@callable-flow.copy', lineRange, line),
        '@callable-flow.destination': capture('@callable-flow.destination', lineRange, copy[1]!),
        '@callable-flow.source': capture('@callable-flow.source', lineRange, copy[2]!),
      });
    }
  }

  for (const call of extracted.calls) {
    const line = lines[call.line - 1] ?? '';
    const lineRange = rangeOf(call.line, 0, call.line, endColFrom(line));
    for (let index = 0; index < (call.parameters?.length ?? 0); index++) {
      const parameter = call.parameters![index]!;
      out.push({
        '@callable-flow.argument': capture('@callable-flow.argument', lineRange, line),
        '@callable-flow.source': capture('@callable-flow.source', lineRange, parameter),
        '@callable-flow.parameter-index': capture(
          '@callable-flow.parameter-index',
          lineRange,
          String(index),
        ),
        ...(!call.isQuoted && procedurePointers.has(call.target.toUpperCase())
          ? {}
          : {
              '@callable-flow.direct-callee-name': capture(
                '@callable-flow.direct-callee-name',
                lineRange,
                call.target,
              ),
            }),
      });
    }
    if (!call.isQuoted && procedurePointers.has(call.target.toUpperCase())) {
      out.push({
        '@callable-flow.invoke': capture('@callable-flow.invoke', lineRange, line),
        '@callable-flow.callee': capture('@callable-flow.callee', lineRange, call.target),
        '@callable-flow.invocation-kind': capture(
          '@callable-flow.invocation-kind',
          lineRange,
          'indirect',
        ),
        '@callable-flow.arity': capture(
          '@callable-flow.arity',
          lineRange,
          String(call.parameters?.length ?? 0),
        ),
      });
    }
  }

  return out;
}
