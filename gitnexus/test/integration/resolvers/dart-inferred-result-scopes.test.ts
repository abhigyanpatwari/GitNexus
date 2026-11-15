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
  'Dart inferred result scopes',
  () => {
    const run = useFixture('dart-inferred-results', {
      'models.dart': 'class User { void save() {} }\nclass Address { void save() {} }\n',
      'other.dart': 'class Other {}\n',
      'decoy.dart': 'class User { void save() {} }\n',
      'producer.dart': `import 'models.dart' as models;
import 'other.dart' as models;
Future<models.User> fetch() async => models.User();
class Service { Future<models.User> getUser() async => models.User(); }
`,
      'ambiguous.dart': `import 'models.dart' as models;
import 'decoy.dart' as models;
Future<models.User> fetchAmbiguous() async => throw 'ambiguous';
`,
      'app.dart': `import 'models.dart';
import 'producer.dart';
import 'ambiguous.dart';
class Named { final String name; Named(this.name); }
Future<void> instanceResult(Service svc) async {
  final x = await svc.getUser(); x.save();
}
Future<void> instanceUnknown(dynamic svc) async {
  final x = await svc.getUser(); x.save();
}
Future<void> instanceShadow(Service svc, List items) async {
  items.forEach((svc) async { final x = await svc.getUser(); x.save(); });
}
Future<void> multiplePrefixes() async {
  final x = await fetch(); x.save();
}
Future<void> ambiguousPrefixes() async {
  final x = await fetchAmbiguous(); x.save();
}
Future<void> fieldLabel(Object value) async {
  final name = await fetch();
  if (value case Named(name: var n)) {}
  name.save();
}
Future<void> shadowedWrite() async {
  final x = await fetch();
  run(() { dynamic x; x = Address(); });
  x.save();
}
Future<void> capturedWrite() async {
  dynamic x = await fetch();
  run(() { x = Address(); });
  x.save();
}
void run(Function f) { f(); }
`,
    });
    for (const caller of ['instanceResult', 'multiplePrefixes', 'fieldLabel', 'shadowedWrite']) {
      it(`${caller} resolves the declaring library's exact User owner`, () => {
        expect(
          getRelationships(run(), 'CALLS')
            .filter((edge) => edge.source === caller && edge.target === 'save')
            .map((edge) => edge.rel.targetId),
        ).toEqual(['Method:models.dart:User.save#0']);
      });
    }
    for (const caller of [
      'instanceUnknown',
      'instanceShadow',
      'ambiguousPrefixes',
      'capturedWrite',
    ]) {
      it(`${caller} does not guess a return owner`, () => {
        expect(
          getRelationships(run(), 'CALLS').filter(
            (edge) => edge.source === caller && edge.target === 'save',
          ),
        ).toEqual([]);
      });
    }
  },
);
