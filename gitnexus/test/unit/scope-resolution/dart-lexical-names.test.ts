/**
 * DART-11 — what Dart publishes for the receiver walk to stop on.
 *
 * Every Function scope carries `@scope.lexical-names`: the names it binds,
 * typed or not. Inline closures and local functions get Function scopes of
 * their own, so their binders land on THEM and not on the enclosing function,
 * and their typed parameters bind inside them.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';

const SOURCE = `void f5(Address cs, List<dynamic> items) {
  items.forEach((cs) {
    var local = cs;
  });
  void inner(Other o) {
    o.save();
  }
  try {} catch (e) {}
  var h = (Other x) => x;
}

class B {
  void m(int a) {
    var b = 1;
  }
}
`;

/** `startLine:startCol-endLine:endCol` of a capture. */
const span = (match: CaptureMatch, tag: string): string => {
  const r = match[tag]!.range;
  return `${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`;
};

function functionScopes(matches: readonly CaptureMatch[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const match of matches) {
    if (match['@scope.function'] === undefined) continue;
    const raw = match['@scope.lexical-names']?.text;
    out[span(match, '@scope.function')] = raw === undefined ? [] : (JSON.parse(raw) as string[]);
  }
  return out;
}

function parameterBindings(matches: readonly CaptureMatch[]): string[] {
  return matches
    .filter((m) => m['@type-binding.parameter'] !== undefined)
    .map(
      (m) =>
        `${m['@type-binding.name']!.text}:${m['@type-binding.type']!.text}@${span(m, '@type-binding.parameter')}`,
    )
    .sort();
}

describe('Dart lexical names (DART-11)', () => {
  const matches = emitDartScopeCaptures(SOURCE, 'app.dart');

  it('every Function scope lists the names IT binds; nested closures keep their own', () => {
    expect(functionScopes(matches)).toEqual({
      // f5: parameters, the catch variable and the bound closure's name — not
      // the closures' own parameters or `local`, which bind inside them.
      '1:0-10:1': ['cs', 'e', 'h', 'items'],
      // the inline closure argument
      '2:16-4:3': ['cs', 'local'],
      // the local function `inner`
      '5:2-7:3': ['o'],
      // the closure bound to `h`
      '9:10-9:24': ['x'],
      // a method
      '13:2-15:3': ['a', 'b'],
    });
  });

  it('typed parameters of closures and local functions bind inside their own scope', () => {
    expect(parameterBindings(matches)).toEqual([
      'a:int@13:16-15:3',
      'cs:Address@1:41-10:1',
      'items:List@1:41-10:1',
      'o:Other@5:22-7:3',
      'x:Other@9:20-9:24',
    ]);
  });
});
