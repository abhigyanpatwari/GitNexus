import { describe, expect, it } from 'vitest';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, useFixture } from './helpers.js';

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Dart))(
  'Dart library export visibility',
  () => {
    const run = useFixture('dart-library-exports', {
      'leaf.dart':
        'class User { void save() {} }\nUser make() => User();\nvoid hidden() {}\nvoid _private() {}',
      'other.dart': 'void collision() {}',
      'conflict.dart': 'void collision() {}',
      'private.dart': 'void importedOnly() {}',
      'facade.dart': `export 'leaf.dart' show User, make, hidden hide hidden;
export 'cycle.dart';
export 'other.dart';
export 'conflict.dart';
import 'private.dart';
void facadeDoesNotImport() { make(); }
`,
      'cycle.dart': "export 'facade.dart';\nvoid cycleCall() {}",
      'app.dart': `import 'facade.dart' as p;
import 'facade.dart' deferred as later;
import 'facade.dart' as limited hide User, make;
void direct() { p.make().save(); p.cycleCall(); }
Future<void> deferred() async { await later.loadLibrary(); later.make().save(); }
void rejected() { p.hidden(); p._private(); p.importedOnly(); p.collision(); limited.make().save(); limited.User().save(); }
void rejectedAnnotation(limited.User user) { user.save(); }
void visibleAnnotation(p.User user) { user.save(); }
`,
      'bare.dart': `import 'facade.dart' show make;
void bare() { make().save(); }
`,
    });
    it('follows immediate, deferred and unprefixed exports through a cycle', () => {
      expect(
        getRelationships(run(), 'CALLS')
          .filter((edge) => ['save', 'cycleCall'].includes(edge.target))
          .map((edge) => `${edge.source} -> ${edge.rel.targetId}`)
          .sort(),
      ).toEqual([
        'bare -> Method:leaf.dart:User.save#0',
        'deferred -> Method:leaf.dart:User.save#0',
        'direct -> Function:cycle.dart:cycleCall',
        'direct -> Method:leaf.dart:User.save#0',
        'visibleAnnotation -> Method:leaf.dart:User.save#0',
      ]);
    });
    it('does not publish hidden, private, imported-only or ambiguous names, or import exports locally', () => {
      expect(
        getRelationships(run(), 'CALLS').filter((edge) =>
          ['rejected', 'rejectedAnnotation', 'facadeDoesNotImport'].includes(edge.source),
        ),
      ).toEqual([]);
    });
  },
);
