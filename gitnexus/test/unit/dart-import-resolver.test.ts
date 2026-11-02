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
});
