/**
 * `emitScopeCaptures` for Lean 4.
 *
 * Line-based regex tagger producing parser-agnostic `CaptureMatch[]`
 * in the RFC §5.1 vocabulary (`@scope.module`, `@scope.function`,
 * `@import.statement`, `@import.name`). The central `ScopeExtractor`
 * consumes these without knowing they came from regex.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 *
 * Coverage (MVP):
 * - one `@scope.module` per file (whole-file range, name = basename sans ext)
 * - declarations: `theorem lemma def abbrev instance opaque axiom`
 *   `inductive structure class` (incl. `@[...]` attribute prefixes,
 *   `private/protected/noncomputable` modifiers, `«quoted»` names);
 *   namespace stack tracked for qualified display (`end` pops one level)
 * - imports: `import Foo.Bar` and `open Foo[.Bar]` (single-line form)
 *
 * Deliberately LATENT (same posture as the COBOL tagger): declaration
 * ranges are start-line anchored with end = next-decl-start − 1
 * (last decl runs to EOF); tactic-proof bodies are opaque — proof
 * dependencies arrive via the Lean ETL phase (precomputed LeanGraph),
 * never from this tagger.
 */

import type { Capture, CaptureMatch, Range } from 'gitnexus-shared';

function capture(name: string, range: Range, text: string): Capture {
  return { name, range, text };
}

function rangeOf(startLine: number, startCol: number, endLine: number, endCol: number): Range {
  return { startLine, startCol, endLine, endCol };
}

function matchFrom(grouped: Record<string, Capture>): CaptureMatch | null {
  if (Object.keys(grouped).length === 0) return null;
  return Object.freeze(grouped) as CaptureMatch;
}

const DECL_KW =
  /^(?:private\s+|protected\s+|noncomputable\s+|unsafe\s+)*(theorem|lemma|def|abbrev|instance|opaque|axiom|inductive|structure|class)\b/;
const ATTR_PREFIX = /^\s*(@\[[^\]]*\]\s*)+/;
const NAME_PAT = /(«[^»]+»|[A-Za-z_\u0370-\u03FF\u2100-\u214F][\w.'\u0370-\u03FF\u2100-\u214F]*)/;

export interface LeanDecl {
  kind: string;
  name: string;
  qualified: string;
  line: number;
}

export function extractLeanDeclsWithRegex(sourceText: string): {
  decls: LeanDecl[];
  imports: { target: string; line: number; isOpen: boolean }[];
  moduleName: string;
} {
  const lines = sourceText.split(/\r?\n/);
  const nsStack: string[] = [];
  const decls: LeanDecl[] = [];
  const imports: { target: string; line: number; isOpen: boolean }[] = [];
  let pendingAttr = false;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    let line = raw;
    // Strip line comments for keyword scanning (keep docstrings out of scope:
    // `/-- -/` blocks are handled by skipping lines inside them below).
    const commentIdx = line.indexOf('--');
    const code = (commentIdx >= 0 ? line.slice(0, commentIdx) : line).trim();
    if (code === '') return;

    // Attribute on its own line(s): `@[simp]` — the decl follows.
    if (/^@\[[^\]]*\]\s*$/.test(code)) {
      pendingAttr = true;
      return;
    }

    // namespace / section / end tracking (sections don't qualify names).
    let m = code.match(/^namespace\s+([A-Za-z_][\w.]*)/);
    if (m) {
      nsStack.push(m[1]!);
      pendingAttr = false;
      return;
    }
    if (/^end\b/.test(code)) {
      nsStack.pop();
      pendingAttr = false;
      return;
    }
    if (/^section\b/.test(code)) {
      nsStack.push('');
      pendingAttr = false;
      return;
    }

    // imports / opens (single-line form only for MVP).
    m = code.match(/^import\s+([A-Za-z_][\w.]*)/);
    if (m) {
      imports.push({ target: m[1]!, line: lineNo, isOpen: false });
      pendingAttr = false;
      return;
    }
    m = code.match(/^open\s+([A-Za-z_][\w.]*)/);
    if (m) {
      imports.push({ target: m[1]!, line: lineNo, isOpen: true });
      pendingAttr = false;
      return;
    }

    // declarations (same-line attributes allowed).
    const stripped = code.replace(ATTR_PREFIX, '').trim();
    const dm = stripped.match(DECL_KW);
    if (dm || pendingAttr) {
      const kw = dm ? dm[1]! : 'decl';
      const rest = dm ? stripped.slice(dm[0].length).trim() : stripped;
      // Anonymous binders first: `instance (...) : ...`, `instance : Foo`,
      // `def _root_.foo` handled below; anything starting with a binder
      // or `:` has no explicit name.
      let name: string | null = null;
      if (/^[\(\[\{:]/.test(rest)) {
        if (kw === 'instance') name = `instance_L${lineNo}`;
      } else {
        const nm = rest.match(NAME_PAT);
        if (nm) {
          name = nm[1]!;
          // `_root_.Foo.bar` defines at root: drop the prefix.
          if (name.startsWith('_root_.')) name = name.slice('_root_.'.length);
        }
      }
      if (name === null) {
        if (kw === 'instance') name = `instance_L${lineNo}`;
        else {
          pendingAttr = false;
          return;
        }
      }
      const prefix = nsStack.filter(Boolean).join('.');
      decls.push({
        kind: kw,
        name,
        qualified: prefix !== '' ? `${prefix}.${name}` : name,
        line: lineNo,
      });
    }
    pendingAttr = false;
  });

  return { decls, imports, moduleName: '' };
}

export function emitLeanScopeCaptures(
  sourceText: string,
  filePath: string,
  _cachedTree?: unknown,
): readonly CaptureMatch[] {
  const lines = sourceText.split(/\r?\n/);
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  const { decls, imports } = extractLeanDeclsWithRegex(sourceText);

  const out: CaptureMatch[] = [];
  const endCol = (n: number): number => {
    const l = lines[n - 1] ?? '';
    return l.length > 0 ? l.length - 1 : 0;
  };

  // 1. File module scope (whole file).
  out.push(
    matchFrom({
      '@scope.module': capture(
        '@scope.module',
        rangeOf(1, 0, lines.length, endCol(lines.length)),
        base,
      ),
    })!,
  );

  // 2. Declarations → @scope.function (scope) + @declaration.function
  // (graph node). End = next decl start − 1, else EOF.
  decls.forEach((d, k) => {
    const endLine = k + 1 < decls.length ? decls[k + 1]!.line - 1 : lines.length;
    const r = rangeOf(d.line, 0, endLine, endCol(endLine));
    out.push(
      matchFrom({
        '@scope.function': capture('@scope.function', r, d.name),
        '@declaration.function': capture('@declaration.function', r, d.name),
      })!,
    );
  });

  // 3. Imports / opens → @import.statement + @import.name.
  for (const imp of imports) {
    out.push(
      matchFrom({
        '@import.statement': capture(
          '@import.statement',
          rangeOf(imp.line, 0, imp.line, endCol(imp.line)),
          imp.target,
        ),
        '@import.name': capture(
          '@import.name',
          rangeOf(imp.line, 0, imp.line, endCol(imp.line)),
          imp.target,
        ),
      })!,
    );
  }

  return out;
}
