/**
 * An R definition is made by assignment: `<-`, `<<-` or `=`. A binary expression with any
 * other operator that merely has a `function(...)`, `R6Class(...)` or `Type$new()` operand
 * (`x + R6Class(...)`, `x == function() 1`, `if (x == Foo$new())`) declares nothing.
 *
 * Every R pattern that anchors on a `binary_operator` carries the operator constraint, and
 * every AST predicate that recognises an assignment shape checks it too. Each negative case is
 * paired with the assignment spelling of the same source, so a pattern that stopped matching
 * could not pass.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { SupportedLanguages } from 'gitnexus-shared';
import { R_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { R_SCOPE_QUERY } from '../../src/core/ingestion/languages/r/query.js';
import { RFieldExtractor } from '../../src/core/ingestion/field-extractors/r.js';
import { rMethodExtractor } from '../../src/core/ingestion/method-extractors/r.js';
import { getRTopLevelPropertyOwnerName } from '../../src/core/ingestion/field-extractors/r.js';
import { getRTopLevelMethodOwnerName } from '../../src/core/ingestion/method-extractors/r.js';
import { buildTypeEnv } from '../../src/core/ingestion/type-env.js';
import { typeConfig } from '../../src/core/ingestion/type-extractors/r.js';
import type { FieldExtractorContext } from '../../src/core/ingestion/field-types.js';
import type { MethodExtractorContext } from '../../src/core/ingestion/method-types.js';

const language = R as Parameters<Parser['setLanguage']>[0];
const parser = new Parser();
parser.setLanguage(language);
const definitionQuery = new Parser.Query(language, R_QUERIES);
const scopeQuery = new Parser.Query(language, R_SCOPE_QUERY);
const parse = (source: string) => parser.parse(source, undefined, { bufferSize: 1 << 24 });

/** The captures that make a definition, a declaration or a class scope, as `capture:text`. */
function captured(query: Parser.Query, source: string): string[] {
  const out: string[] = [];
  for (const match of query.matches(parse(source).rootNode)) {
    for (const c of match.captures) {
      if (/^(definition|declaration|scope\.class|type-binding|reference\.inherits)/.test(c.name)) {
        out.push(`${c.name}:${c.node.text.split('\n')[0].slice(0, 30)}`);
      }
    }
  }
  return out;
}

const R6_SOURCE = (op: string) =>
  `x ${op} R6Class("A", inherit = Base, public = list(f = function() 1, v = 1))`;
const FN_SOURCE = (op: string) => `x ${op} function() 1`;
const NEW_SOURCE = (op: string) => `x ${op} Foo$new()`;

describe('R queries: only an assignment declares a definition', () => {
  it.each(['<-', '=', '<<-'])('R6Class with %s defines class, method, field and scope', (op) => {
    const defs = captured(definitionQuery, R6_SOURCE(op));
    expect(defs.some((c) => c.startsWith('definition.class:'))).toBe(true);
    expect(defs.some((c) => c.startsWith('definition.method:'))).toBe(true);
    expect(defs.some((c) => c.startsWith('definition.property:'))).toBe(true);
    const scopes = captured(scopeQuery, R6_SOURCE(op));
    expect(scopes.some((c) => c.startsWith('scope.class:'))).toBe(true);
    expect(scopes.some((c) => c.startsWith('declaration.class:'))).toBe(true);
    expect(scopes.some((c) => c.startsWith('declaration.method:'))).toBe(true);
    expect(scopes.some((c) => c.startsWith('reference.inherits:'))).toBe(true);
  });

  it.each(['+', '==', '->', '%in%', '|>', ':='])('R6Class with %s defines nothing', (op) => {
    expect(captured(definitionQuery, R6_SOURCE(op))).toEqual([]);
    expect(captured(scopeQuery, R6_SOURCE(op))).toEqual([]);
  });

  it.each(['<-', '=', '<<-'])('function with %s is a function definition', (op) => {
    expect(captured(definitionQuery, FN_SOURCE(op))).toEqual([
      `definition.function:x ${op} function() 1`,
    ]);
    expect(captured(scopeQuery, FN_SOURCE(op))).toContain(
      `declaration.function:x ${op} function() 1`,
    );
  });

  it.each(['+', '==', '->', '%in%', ':='])('function with %s is not a definition', (op) => {
    expect(captured(definitionQuery, FN_SOURCE(op))).toEqual([]);
    expect(captured(scopeQuery, FN_SOURCE(op)).filter((c) => c.startsWith('declaration'))).toEqual(
      [],
    );
  });

  it.each(['<-', '=', '<<-'])('Type$new() with %s is a constructor type binding', (op) => {
    expect(captured(scopeQuery, NEW_SOURCE(op)).some((c) => c.startsWith('type-binding'))).toBe(
      true,
    );
  });

  it.each(['+', '==', '->'])('Type$new() with %s binds no type', (op) => {
    expect(captured(scopeQuery, NEW_SOURCE(op)).some((c) => c.startsWith('type-binding'))).toBe(
      false,
    );
  });

  it('constrains the operator in every binary_operator pattern of both queries', () => {
    for (const [label, text] of [
      ['R_QUERIES', R_QUERIES],
      ['R_SCOPE_QUERY', R_SCOPE_QUERY],
    ] as const) {
      // A pattern head `(binary_operator` followed by a newline; `(binary_operator)` is a bare
      // alternative in a value list, not an anchor.
      const patterns = text.split(/^\(binary_operator\n/m).slice(1);
      expect(patterns.length, label).toBeGreaterThan(0);
      for (const body of patterns) {
        expect(body.split('\n\n')[0], `${label}: ${body.slice(0, 60)}`).toContain(
          'operator: ["<-" "<<-" "="]',
        );
      }
    }
  });
});

describe('R extractors: only an assignment declares a class', () => {
  const fieldContext = {
    filePath: 'a.R',
    language: SupportedLanguages.R,
  } as unknown as FieldExtractorContext;
  const methodContext = {
    filePath: 'a.R',
    language: SupportedLanguages.R,
  } as unknown as MethodExtractorContext;
  const assignment = (source: string) => {
    const [node] = parse(source).rootNode.descendantsOfType('binary_operator');
    return node;
  };
  const SOURCE = (op: string) => `x ${op} R6Class("A", public = list(f = function() 1, v = 1))`;

  it.each(['<-', '=', '<<-'])('treats an R6Class assignment with %s as a class', (op) => {
    const node = assignment(SOURCE(op));
    expect(new RFieldExtractor().isTypeDeclaration(node)).toBe(true);
    expect(rMethodExtractor.isTypeDeclaration(node)).toBe(true);
    expect(new RFieldExtractor().extract(node, fieldContext)?.ownerFqn).toBe('x');
    expect(rMethodExtractor.extract(node, methodContext)?.ownerName).toBe('x');
  });

  it.each(['+', '==', '->'])('does not treat `x %s R6Class(...)` as a class', (op) => {
    const node = assignment(SOURCE(op));
    expect(new RFieldExtractor().isTypeDeclaration(node)).toBe(false);
    expect(rMethodExtractor.isTypeDeclaration(node)).toBe(false);
    expect(new RFieldExtractor().extract(node, fieldContext)).toBeNull();
    expect(rMethodExtractor.extract(node, methodContext)).toBeNull();
    const entry = (name: string) => {
      const found = node.descendantsOfType('argument').find((a) => a.text.startsWith(`${name} =`));
      if (!found) throw new Error(`no ${name} entry`);
      return found;
    };
    expect(getRTopLevelPropertyOwnerName(entry('v'))).toBeNull();
    expect(getRTopLevelMethodOwnerName(entry('f'))).toBeNull();
  });
});

describe('R type environment: only an assignment binds a type', () => {
  const bound = (source: string, name: string): string | undefined => {
    const typeEnv = buildTypeEnv(parse(source), SupportedLanguages.R);
    for (const [, scope] of typeEnv.allScopes()) {
      const type = scope.get(name);
      if (type) return type;
    }
    return undefined;
  };

  const constructorBinding = (source: string) => {
    const [node] = parse(source).rootNode.descendantsOfType('binary_operator');
    return typeConfig.scanConstructorBinding?.(node);
  };

  it.each(['<-', '=', '<<-'])('scans `obj %s Foo$new()` as a constructor binding', (op) => {
    expect(constructorBinding(`obj ${op} Foo$new()`)).toEqual({
      varName: 'obj',
      calleeName: 'Foo',
    });
    expect(constructorBinding(`obj ${op} new("Foo")`)).toEqual({
      varName: 'obj',
      calleeName: 'Foo',
    });
  });

  it.each(['+', '==', '->'])('scans nothing for `obj %s Foo$new()`', (op) => {
    expect(constructorBinding(`obj ${op} Foo$new()`)).toBeUndefined();
    expect(constructorBinding(`obj ${op} new("Foo")`)).toBeUndefined();
  });

  it.each(['+', '=='])('does not count `Foo %s R6Class(...)` as a local class', (op) => {
    const source = `Foo ${op} R6Class("Foo")\n#' @param d Foo\nf <- function(d) d`;
    expect(bound(source, 'd')).toBeUndefined();
  });

  it('counts `Foo <- R6Class(...)` as a local class (positive control)', () => {
    const source = `Foo <- R6Class("Foo")\n#' @param d Foo\nf <- function(d) d`;
    expect(bound(source, 'd')).toBe('Foo');
  });

  it.each(['+', '=='])('binds no roxygen type for `f %s function(d)`', (op) => {
    const source = `Foo <- R6Class("Foo")\n#' @param d Foo\nf ${op} function(d) d`;
    expect(bound(source, 'd')).toBeUndefined();
  });
});
