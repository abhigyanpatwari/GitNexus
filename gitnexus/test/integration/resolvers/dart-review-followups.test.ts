import { describe, expect, it } from 'vitest';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, getResolutionOutcomes, useFixture } from './helpers.js';

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

describe.skipIf(!dartAvailable)('Dart review follow-ups', () => {
  const run = useFixture('dart-review-followups', {
    'pubspec.yaml': 'name: legacy\nenvironment:\n  sdk: ">=3.6.0 <4.0.0"\n',
    'package.dart':
      'class Legacy { void oldSave() {} }\nvoid packageLocal() { final _ = Legacy(); _.oldSave(); }\n',
    'modern/pubspec.yaml': 'name: modern\nenvironment:\n  sdk: ^3.7.0\n',
    'modern/modern.dart':
      'class Recent { void modernSave() {} }\nvoid recentLocal() { final _ = Recent(); _.modernSave(); }\n',
    'app.dart': `class Address { void save() {} }
class User { Address address = Address(); void save() {} }
class Other { void save() {} }
class Svc {
  Address addr = Address();
  Future<User> getUserAsync() async => User();
  User getUser() => User();
  static void staticClosure() { [1].forEach((x) { this.addr.save(); }); }
  void instanceClosure() { [1].forEach((x) { this.addr.save(); }); }
}
Future<void> cascades(Svc svc, User user) async {
  (await svc.getUserAsync())..save()..address.save();
  svc.getUser()..save();
  user..save();
  Other inner(Other cs) => cs..save();
}
void unknown(dynamic source) { source..save(); }
`,
    'old.dart': `// @dart = 3.6
class Old { void oldSave() {} }
void oldParameter(Old _) { _.oldSave(); }
void oldLocal() { final _ = Old(); _.oldSave(); }
`,
    'modern.dart': `// @dart = 3.7
class Modern { void modernSave() {} }
void modernParameter(Modern _) { _.modernSave(); }
void modernLocal() { final _ = Modern(); _.modernSave(); }
`,
  });

  it('retains only the instance closure receiver', () => {
    expect(
      getRelationships(run(), 'CALLS')
        .filter((edge) => edge.target === 'save' && edge.source.endsWith('Closure'))
        .map((edge) => `${edge.source} -> ${edge.rel.targetId}`),
    ).toEqual(['instanceClosure -> Method:app.dart:Address.save#0']);
  });

  it('honors explicit pre-3.7 versions and records modern unbound wildcard reads', () => {
    expect(
      getRelationships(run(), 'CALLS')
        .filter((edge) => ['oldSave', 'modernSave'].includes(edge.target))
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(['oldLocal', 'oldParameter', 'packageLocal']);
    expect(
      getResolutionOutcomes(run())
        .filter((outcome) => outcome.kind === 'suppressed' && outcome.filePath === 'modern.dart')
        .map((outcome) => outcome.kind),
    ).toEqual(['suppressed', 'suppressed']);
  });

  it('types cascade heads, resets each section and honors nested parameters', () => {
    expect(
      getRelationships(run(), 'CALLS')
        .filter(
          (edge) =>
            edge.target === 'save' && ['cascades', 'inner', 'unknown'].includes(edge.source),
        )
        .map((edge) => `${edge.source} -> ${edge.rel.targetId}`)
        .sort(),
    ).toEqual([
      'cascades -> Method:app.dart:Address.save#0',
      'cascades -> Method:app.dart:User.save#0',
      'cascades -> Method:app.dart:User.save#0',
      'cascades -> Method:app.dart:User.save#0',
      'inner -> Method:app.dart:Other.save#0',
    ]);
    expect(
      getResolutionOutcomes(run())
        .filter(
          (outcome) =>
            outcome.kind === 'suppressed' &&
            outcome.name === 'save' &&
            outcome.range.startLine === 17,
        )
        .map((outcome) => outcome.kind),
    ).toEqual(['suppressed']);
  });
});
