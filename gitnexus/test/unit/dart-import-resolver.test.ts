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
  // forms. The prefix `p` is a namespace handle exactly like `as p`.
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
});
