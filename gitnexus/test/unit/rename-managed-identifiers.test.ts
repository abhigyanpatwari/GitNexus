import { describe, expect, it } from 'vitest';
import { javaRenameProvider } from '../../src/core/ingestion/languages/java/rename.js';
import { dartRenameProvider } from '../../src/core/ingestion/languages/dart/rename.js';

const validateJavaName = javaRenameProvider.validateName;
const validateDartName = dartRenameProvider.validateName;
if (!validateJavaName || !validateDartName) throw new Error('Missing identifier validator');

describe('managed provider replacement identifiers', () => {
  it.each(['_', String.raw`\u005f`, String.raw`\uu005F`])(
    'rejects the reserved Java underscore spelling %s',
    (name) => {
      expect(validateJavaName(name)).toMatchObject({ code: 'invalid_name' });
    },
  );

  it.each(['_measure', 'measure_', '__', String.raw`\u005fmeasure`])(
    'allows an underscore within the longer Java identifier %s',
    (name) => {
      expect(validateJavaName(name)).toBeUndefined();
    },
  );

  // Dart's built-in identifiers are restricted by declaration kind, not lexically reserved.
  it.each(['abstract', 'import', 'dynamic', 'Function', 'type', 'get', 'set'])(
    'keeps the Dart built-in identifier %s available for member names',
    (name) => {
      expect(validateDartName(name)).toBeUndefined();
    },
  );

  it.each(['class', 'return', 'void', 'new'])('rejects the Dart reserved word %s', (name) => {
    expect(validateDartName(name)).toMatchObject({ code: 'invalid_name' });
  });
});
