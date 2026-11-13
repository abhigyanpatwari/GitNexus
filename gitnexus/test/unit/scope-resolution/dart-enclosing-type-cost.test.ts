/**
 * The receiver binding a Dart closure needs must not search the ancestors for
 * the enclosing type declaration (#3912 review).
 *
 * A closure that no enclosing scope binds `this` for synthesizes its own, from
 * the nearest enclosing class, mixin, extension, extension type or enum. Under
 * a top-level function there is none, so EVERY closure in a nest asks, and a
 * search that climbs to the root costs O(depth) per closure and O(depth^2) per
 * nest. The capture walk now carries the enclosing type (or its absence) down
 * the tree, and a declared member's lookup is memoised per file, so the search
 * steps onto a bounded number of ancestors per scope however deep closures
 * nest. These tests count those steps through the test hook.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import {
  getDartCaptureWalkStats,
  resetDartCaptureWalkStats,
} from '../../../src/core/ingestion/languages/dart/walk-stats.js';
import {
  getDartEnclosingTypeStats,
  resetDartEnclosingTypeStats,
} from '../../../src/core/ingestion/languages/dart/receiver-binding.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

// The Dart grammar is optional; this suite skips where it cannot load.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

/** `depth` inline closures, each nested in the previous one, fixed-width indented. */
function inlineNest(depth: number, host: string, close: string): string {
  let body = '';
  for (let j = 0; j < depth; j++) body += `  items.forEach((x${j}) { x${j}.save();\n`;
  for (let j = 0; j < depth; j++) body += '  });\n';
  return `${host}\n${body}${close}`;
}

/** `depth` closures bound to locals, each nested in the previous one. */
function namedNest(depth: number): string {
  let body = '';
  for (let j = 0; j < depth; j++) body += `  var h${j} = (x${j}) { x${j}.save();\n`;
  for (let j = 0; j < depth; j++) body += '  };\n';
  return `void f(List<int> items) {\n${body}}\n`;
}

const functionScopes = (matches: readonly CaptureMatch[]): number =>
  matches.filter((m) => m['@scope.function'] !== undefined).length;

const thisTypes = (matches: readonly CaptureMatch[]): string[] =>
  matches
    .filter(
      (m) => m['@type-binding.self'] !== undefined && m['@type-binding.name']?.text === 'this',
    )
    .map((m) => m['@type-binding.type']?.text ?? '');

/** Ancestor steps the enclosing-type search takes for one file, and its scopes. */
function cost(source: string): {
  visits: number;
  scopes: number;
  matches: readonly CaptureMatch[];
} {
  resetDartEnclosingTypeStats();
  const matches = emitDartScopeCaptures(source, 'lib/nest.dart');
  return {
    visits: getDartEnclosingTypeStats().ancestorVisits,
    scopes: functionScopes(matches),
    matches,
  };
}

describe.skipIf(!dartAvailable)('Dart enclosing-type search is linear in the file', () => {
  beforeEach(() => resetDartEnclosingTypeStats());

  it('inline closures nested under a top-level function: at most one ancestor step per scope, flat in depth', () => {
    const shallow = cost(inlineNest(8, 'void f(List<int> items) {', '}\n'));
    const deep = cost(inlineNest(64, 'void f(List<int> items) {', '}\n'));
    // One Function scope per closure plus `f` itself.
    expect(shallow.scopes).toBe(9);
    expect(deep.scopes).toBe(65);
    // No enclosing type, and no `this` for any closure.
    expect(thisTypes(deep.matches)).toEqual([]);
    expect(deep.visits).toBeLessThanOrEqual(deep.scopes);
    // The search no longer depends on how deep the closures sit.
    expect(deep.visits).toBe(shallow.visits);
  });

  it('inline closures nested under an operator: the outermost closure still binds `this`, without a climb', () => {
    const source = inlineNest(
      64,
      'class Svc {\n  int operator +(List<int> items) {',
      '    return 0;\n  }\n}\n',
    );
    const deep = cost(source);
    // An operator body opens no scope, so the outermost closure carries the
    // class's `this`, and every closure inside it inherits that binding.
    expect(thisTypes(deep.matches)).toEqual(['Svc']);
    expect(deep.visits).toBeLessThanOrEqual(deep.scopes);
  });

  it('closures bound to locals, nested: the memoised member lookup stops where the outer one did', () => {
    const [d8, d16, d64] = [8, 16, 64].map((depth) => cost(namedNest(depth)));
    expect([d8.scopes, d16.scopes, d64.scopes]).toEqual([9, 17, 65]);
    // Each lookup steps onto the few nodes between a closure and the one it
    // is nested in, then stops on the memoised answer, so every added level
    // costs the same: 48 more levels cost 6x what 8 more did. A root climb
    // per closure makes each added level cost more than the one before.
    expect(d64.visits - d16.visits).toBeLessThanOrEqual(6 * (d16.visits - d8.visits));
    expect(d64.visits).toBeLessThanOrEqual(8 * d64.scopes);
  });
});

describe.skipIf(!dartAvailable)('Dart callable-flow owner is read, not climbed', () => {
  it('the owner hook takes no parent step for any node the capture walk visited', () => {
    // The shared callable-flow pass asks for the owning function of every call
    // and argument. A `parent` read costs the node's depth in node-tree-sitter,
    // so a climb per lookup grows with depth; the walk records every answer.
    for (const source of [
      inlineNest(64, 'void f(List<int> items) {', '}\n'),
      inlineNest(64, 'class Svc {\n  int operator +(List<int> items) {', '    return 0;\n  }\n}\n'),
      namedNest(64),
    ]) {
      resetDartCaptureWalkStats();
      emitDartScopeCaptures(source, 'lib/nest.dart');
      expect(getDartCaptureWalkStats().ownerParentSteps).toBe(0);
    }
  });

  it('a call reads its callee, and a closure its static check, without a sibling read', () => {
    // The shared pass asks for the callee of every call (the named sibling
    // before its selector), and every closure that synthesizes `this` checks
    // for a `static` token before it. A sibling read costs the node's depth;
    // the walk passes both answers down.
    for (const source of [
      inlineNest(64, 'void f(List<int> items) {', '}\n'),
      inlineNest(64, 'class Svc {\n  int operator +(List<int> items) {', '    return 0;\n  }\n}\n'),
      namedNest(64),
    ]) {
      resetDartCaptureWalkStats();
      emitDartScopeCaptures(source, 'lib/nest.dart');
      expect(getDartCaptureWalkStats().siblingReads).toBe(0);
    }
  });
});
