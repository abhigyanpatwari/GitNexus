import { describe, expect, it } from 'vitest';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, useFixture } from './helpers.js';

// isLanguageAvailable only says the grammar module loaded; probe the parser so
// a grammar that fails in setLanguage skips the suite instead of failing it.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

describe.skipIf(!dartAvailable)(
  // Skipped when the Dart parser cannot be initialised (probe above).
  'Dart branch binding visibility',
  () => {
    const run = useFixture('dart-branch-bindings', {
      'app.dart': `class Outer { List<Inner> items() => []; void save() {} }
class Inner { void save() {} }
void statementIf(Outer x, dynamic value) {
  if (value case Inner x) { x.save(); } else { x.save(); }
}
void elementIf(Outer x, dynamic value) {
  final a = [if (value case Inner x) x.save() else x.save()];
}
void statementFor(Outer x) {
  for (final x in x.items()) { x.save(); }
}
void elementFor(Outer x) {
  final a = [for (final x in x.items()) x.save()];
}
void statementCondition(Outer x) {
  if (x.items() case [Inner x]) { x.save(); } else { x.save(); }
}
void elementCondition(Outer x) {
  final a = [if (x.items() case [Inner x]) x.save() else x.save()];
}
`,
    });
    for (const caller of ['statementIf', 'elementIf']) {
      it(`${caller}: the pattern binder does not hide the outer else receiver`, () => {
        expect(
          getRelationships(run(), 'CALLS')
            .filter((edge) => edge.source === caller && edge.target === 'save')
            .map((edge) => edge.rel.targetId),
        ).toEqual(['Method:app.dart:Outer.save#0']);
      });
    }
    for (const caller of ['statementFor', 'elementFor']) {
      it(`${caller}: the iterable sees the outer receiver and the body keeps its binder`, () => {
        expect(
          getRelationships(run(), 'CALLS')
            .filter((edge) => edge.source === caller)
            .map((edge) => edge.rel.targetId),
        ).toEqual(['Method:app.dart:Outer.items#0']);
      });
    }
    for (const caller of ['statementCondition', 'elementCondition']) {
      it(`${caller}: the matched expression sees the outer receiver`, () => {
        expect(
          getRelationships(run(), 'CALLS')
            .filter((edge) => edge.source === caller)
            .map((edge) => edge.rel.targetId),
        ).toEqual(['Method:app.dart:Outer.items#0', 'Method:app.dart:Outer.save#0']);
      });
    }
  },
);
