/**
 * `emitScopeCaptures` for Oracle PL/SQL.
 *
 * Wraps the ANTLR fact extractor (`../../plsql/extract.ts`) and emits the
 * parser-agnostic RFC §5.1 vocabulary consumed by the central ScopeExtractor:
 *
 *   package             → @scope.module   + @declaration.program  (→ Module)
 *   procedure/function  → @scope.function + @declaration.function (→ Function)
 *   trigger             → @scope.function + @declaration.function
 *   spec declaration    → @declaration.function (no scope: it has no body)
 *   call (last part)    → @reference.call  (+ @reference.arity)
 *   call qualifier part → @reference.read  (the package name in `pkg.proc`)
 *   END <label>         → @reference.read  (bound to the definition it closes)
 *   @@script / START    → @import.statement / @import.name
 *
 * Every name capture uses the exact written token range, so rename and the
 * source-binding pass can join captures back to source tokens by range.
 */

import type { Capture, CaptureMatch, Range } from 'gitnexus-shared';
import {
  extractPlSqlFacts,
  type PlSqlDefinition,
  type PlSqlFileFacts,
  type PlSqlNameToken,
} from '../../plsql/extract.js';

function capture(name: string, range: Range, text: string): Capture {
  return { name, range, text };
}

export function plsqlTokenRange(token: PlSqlNameToken): Range {
  return {
    startLine: token.line,
    startCol: token.column,
    endLine: token.line,
    endCol: token.column + token.length,
  };
}

export function plsqlNameRange(def: PlSqlDefinition): Range {
  return {
    startLine: def.nameLine,
    startCol: def.nameColumn,
    endLine: def.nameLine,
    endCol: def.nameColumn + def.nameLength,
  };
}

export function plsqlDefinitionRange(def: PlSqlDefinition): Range {
  return {
    startLine: def.startLine,
    startCol: def.startColumn,
    endLine: def.endLine,
    endCol: Math.max(def.endColumn, def.startLine === def.endLine ? def.startColumn + 1 : 0),
  };
}

export const plsqlRangeKey = (r: Range): string =>
  `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;

/** Facts are recomputed per call site of the hook; memoise on the exact source text. */
const factsCache = new Map<string, PlSqlFileFacts>();
const FACTS_CACHE_LIMIT = 64;

export function plsqlFactsFor(sourceText: string): PlSqlFileFacts {
  const cached = factsCache.get(sourceText);
  if (cached) return cached;
  const facts = extractPlSqlFacts(sourceText);
  if (factsCache.size >= FACTS_CACHE_LIMIT) factsCache.delete(factsCache.keys().next().value!);
  factsCache.set(sourceText, facts);
  return facts;
}

export function emitPlSqlScopeCaptures(
  sourceText: string,
  _filePath: string,
  _cachedTree?: unknown,
): readonly CaptureMatch[] {
  const facts = plsqlFactsFor(sourceText);
  const out: CaptureMatch[] = [];

  for (const def of facts.definitions) {
    const range = plsqlDefinitionRange(def);
    const nameRange = plsqlNameRange(def);
    const tag = def.kind === 'package' ? '@declaration.program' : '@declaration.function';
    const required = def.parameters.filter((p) => !p.hasDefault).length;
    const match: Record<string, Capture> = {
      [tag]: capture(tag, range, def.name),
      '@declaration.name': capture('@declaration.name', nameRange, def.name),
      '@declaration.qualified_name': capture(
        '@declaration.qualified_name',
        nameRange,
        [...def.ownerPath, def.name].join('.'),
      ),
    };
    if (def.kind !== 'package' && !def.fromFallback) {
      match['@declaration.parameter-count'] = capture(
        '@declaration.parameter-count',
        nameRange,
        String(def.parameters.length),
      );
      match['@declaration.required-parameter-count'] = capture(
        '@declaration.required-parameter-count',
        nameRange,
        String(required),
      );
    }
    // A spec declaration has no body, so it opens no scope.
    if (!def.isSpec || def.kind === 'package') {
      const scope = def.kind === 'package' ? '@scope.module' : '@scope.function';
      match[scope] = capture(scope, range, def.name);
    }
    out.push(match);
    for (const label of def.endLabels) {
      const r = plsqlTokenRange(label);
      out.push({
        '@reference.read': capture('@reference.read', r, label.name),
        '@reference.name': capture('@reference.name', r, label.name),
      });
    }
  }

  for (const call of facts.calls) {
    call.nameTokens.forEach((token, i) => {
      const r = plsqlTokenRange(token);
      const isCallee = i === call.nameTokens.length - 1;
      const tag = isCallee ? '@reference.call' : '@reference.read';
      out.push({
        [tag]: capture(tag, r, token.name),
        '@reference.name': capture('@reference.name', r, token.name),
        ...(isCallee && call.arity !== undefined
          ? { '@reference.arity': capture('@reference.arity', r, String(call.arity)) }
          : {}),
      });
    });
  }

  for (const include of facts.scriptIncludes) {
    const r: Range = {
      startLine: include.line,
      startCol: include.column,
      endLine: include.line,
      endCol: include.column + include.target.length,
    };
    out.push({
      '@import.statement': capture('@import.statement', r, include.target),
      '@import.name': capture('@import.name', r, include.target),
    });
  }

  return out;
}
