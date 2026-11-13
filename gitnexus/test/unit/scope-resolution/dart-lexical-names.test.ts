/**
 * DART-11 — what Dart publishes for the receiver walk to stop on.
 *
 * Every scope carries `@scope.lexical-names`: the names it DECLARES, typed or
 * not. Inline closures and local functions get Function scopes of their own,
 * and a nested block, a `for`, a switch case, an if-case and the body a catch
 * clause guards get a Block scope when they declare a name, so each binder
 * lands on the scope Dart gives it. A name that declares nothing — a constant
 * in a matching pattern, a field label, a pattern assignment, `_` — is not
 * listed.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
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
  const r = match[tag]?.range;
  return r === undefined ? `<no ${tag}>` : `${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`;
};

/** Every Function and Block scope, as `Kind span`, with the names it lists. */
function scopes(matches: readonly CaptureMatch[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const match of matches) {
    const tag =
      match['@scope.function'] !== undefined
        ? '@scope.function'
        : match['@scope.block'] !== undefined
          ? '@scope.block'
          : undefined;
    if (tag === undefined) continue;
    const kind = tag === '@scope.function' ? 'Function' : 'Block';
    const raw = match['@scope.lexical-names']?.text;
    out[`${kind} ${span(match, tag)}`] = raw === undefined ? [] : (JSON.parse(raw) as string[]);
  }
  return out;
}

function parameterBindings(matches: readonly CaptureMatch[]): string[] {
  return matches
    .filter((m) => m['@type-binding.parameter'] !== undefined)
    .map(
      (m) =>
        `${m['@type-binding.name']?.text}:${m['@type-binding.type']?.text}@${span(m, '@type-binding.parameter')}`,
    )
    .sort();
}

describe.skipIf(!dartAvailable)('Dart lexical names (DART-11)', () => {
  const matches = dartAvailable ? emitDartScopeCaptures(SOURCE, 'app.dart') : [];

  it('every scope lists the names IT declares; closures, local functions and the catch body keep their own', () => {
    expect(scopes(matches)).toEqual({
      // f5: parameters, the local function's and the bound closure's names —
      // not the closures' own parameters or `local`, and not the catch
      // variable, which belongs to the body the catch clause guards.
      'Function 1:0-10:1': ['cs', 'h', 'inner', 'items'],
      // the inline closure argument
      'Function 2:16-4:3': ['cs', 'local'],
      // the local function `inner`
      'Function 5:2-7:3': ['o'],
      // the catch body `{}`
      'Block 8:19-8:21': ['e'],
      // the closure bound to `h`
      'Function 9:10-9:24': ['x'],
      // a method
      'Function 13:2-15:3': ['a', 'b'],
    });
  });

  it('a closure or local function that binds nothing gets no scope: it would be transparent', () => {
    const source = `void run(List<dynamic> items) {
  items.forEach((x) {});
  setState(() {
    helper();
  });
  void tick() {}
}
`;
    expect(scopes(emitDartScopeCaptures(source, 'b.dart'))).toEqual({
      // `tick` is declared here; its own empty scope is not emitted.
      'Function 1:0-7:1': ['items', 'tick'],
      'Function 2:16-2:22': ['x'],
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

  it('only declarations are listed: matching constants, field labels and pattern assignments declare nothing', () => {
    const source = `void p(Object value, Object o, List<dynamic> items, (int, int) pair) {
  switch (value) {
    case Address:
      break;
    case [var first, _]:
      break;
  }
  var (api: v) = (api: 1);
  if (o case Box(cs: var inner)) {}
  (q,) = (1,);
  var (a, b) = pair;
  for (final (k, w) in items) {}
}
`;
    expect(scopes(emitDartScopeCaptures(source, 'p.dart'))).toEqual({
      // `v`, `a`, `b` are declared by declaration patterns; `Address` is a
      // constant, `api` and `cs` are labels, `q` is assigned, not declared.
      'Function 1:0-13:1': ['a', 'b', 'items', 'o', 'pair', 'v', 'value'],
      // each statement's own pattern variables stay in its own scope
      'Block 5:4-6:12': ['first'],
      'Block 9:2-9:35': ['inner'],
      'Block 12:2-12:32': ['k', 'w'],
    });
  });

  it('a closure carries its own `this` only where no enclosing scope binds it: under an operator', () => {
    const source = `class Svc {
  void m(List<int> xs) {
    xs.forEach((x) {
      print(x);
    });
  }
  int operator +(int o) {
    [1].forEach((y) {
      print(y);
    });
    return 0;
  }
  int get g {
    [1].forEach((z) {
      print(z);
    });
    return 0;
  }
}
`;
    const thisAt = emitDartScopeCaptures(source, 's.dart')
      .filter(
        (m) => m['@type-binding.self'] !== undefined && m['@type-binding.name']?.text === 'this',
      )
      .map((m) => span(m, '@type-binding.self'))
      .sort();
    // The method's own binding; the operator closure's, because an operator
    // body opens no scope of its own; and the getter's own (an accessor body
    // opens a Function scope, DART-10), which the getter closure reads.
    expect(thisAt).toEqual(['13:12-18:3', '2:23-6:3', '8:20-10:5']);
  });

  it('`_` declares nothing, and a function-typed parameter names itself, not its own parameters', () => {
    const source = `void w(List<Other> items, Address a) {
  items.forEach((Other _) {
    _.save();
  });
  void cb(Other fn(int a)) {}
}
`;
    const emitted = emitDartScopeCaptures(source, 'w.dart');
    expect(scopes(emitted)).toEqual({
      'Function 1:0-6:1': ['a', 'cb', 'items'],
      // the closure declares only `_`: no scope, no parameter binding
      'Function 5:2-5:29': ['fn'],
    });
    expect(parameterBindings(emitted).filter((b) => b.startsWith('_:'))).toEqual([]);
  });
});
