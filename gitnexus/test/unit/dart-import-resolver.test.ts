import { describe, it, expect } from 'vitest';
import { emitDartScopeCaptures } from '../../src/core/ingestion/languages/dart/captures.js';
import { interpretDartImport } from '../../src/core/ingestion/languages/dart/interpret.js';

describe('Dart import prefix semantic captures', () => {
  it('keeps prefixed imports as namespace handles and ordinary imports as wildcards', () => {
    const captures = emitDartScopeCaptures(
      "import 'model.dart' as lib;\nimport 'other.dart';\n",
      'caller.dart',
    );
    expect(
      captures.filter((capture) => capture['@import.statement']).map(interpretDartImport),
    ).toEqual([
      {
        kind: 'namespace',
        localName: 'lib',
        importedName: 'model.dart',
        targetRaw: 'model.dart',
        explicitAlias: true,
      },
      { kind: 'wildcard', targetRaw: 'other.dart' },
    ]);
  });

  // `import 'x.dart' deferred as p;` parses as the grammar's second
  // `import_specification` branch — a bare `(uri)` child plus the alias
  // `(identifier)` — not the `(configurable_uri)` shape of the non-deferred
  // forms. The prefix `p` is a namespace handle like `as p`, except for the
  // implicit `p.loadLibrary` (next case).
  it('keeps deferred prefixed imports as namespace handles', () => {
    const captures = emitDartScopeCaptures(
      "import 'x.dart' deferred as p;\nimport 'y.dart' deferred as q show A;\n",
      'caller.dart',
    );
    expect(
      captures.filter((capture) => capture['@import.statement']).map(interpretDartImport),
    ).toEqual([
      {
        kind: 'namespace',
        localName: 'p',
        importedName: 'x.dart',
        targetRaw: 'x.dart',
        explicitAlias: true,
      },
      {
        kind: 'namespace',
        localName: 'q',
        importedName: 'y.dart',
        targetRaw: 'y.dart',
        explicitAlias: true,
      },
    ]);
  });

  // A deferred prefix's `loadLibrary` is the implicit one the language adds,
  // never a declaration of the imported library, so the call, the tear-off,
  // a member called on its result and the call-result seed are all dropped.
  // The same spellings through the non-deferred `ip` keep their captures.
  it('drops loadLibrary references through a deferred prefix only', () => {
    const captures = emitDartScopeCaptures(
      [
        "import 'x.dart' deferred as dp hide loadLibrary;",
        "import 'x.dart' as ip;",
        'void f() {',
        '  dp.loadLibrary();',
        '  final t = dp.loadLibrary;',
        '  final r = dp.loadLibrary();',
        '  dp.loadLibrary().timeout(d);',
        '  ip.loadLibrary();',
        '  final u = ip.loadLibrary;',
        '  final s = ip.loadLibrary();',
        '  ip.loadLibrary().timeout(d);',
        '}',
        '',
      ].join('\n'),
      'caller.dart',
    );
    const loadSites = captures
      .map((capture) => {
        const seed = capture['@type-binding.type']?.text;
        if (seed !== undefined) return `seed ${seed}`;
        const receiver = capture['@reference.receiver']?.text;
        if (receiver === undefined) return undefined;
        const kind = capture['@reference.call.member'] !== undefined ? 'call' : 'read';
        return `${kind} ${receiver}.${capture['@reference.name']?.text}`;
      })
      .filter((site) => site?.includes('loadLibrary'))
      .sort();
    expect(loadSites).toEqual([
      'call ip.loadLibrary',
      'call ip.loadLibrary',
      'call ip.loadLibrary',
      'call ip.loadLibrary().timeout',
      'read ip.loadLibrary',
      'seed ip.loadLibrary',
    ]);
  });
});
