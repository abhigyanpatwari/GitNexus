import { describe, expect, it } from 'vitest';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, useFixture } from './helpers.js';

// `isLanguageAvailable` only proves the grammar module loaded; tree-sitter-dart
// can still fail in `setLanguage`. Probe the parser for a reliable skip guard.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

describe.skipIf(!dartAvailable)('Dart library export visibility', () => {
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
});

describe.skipIf(!dartAvailable)('Dart export closure rules', () => {
  // `save` and `make` each have several owners, so every edge below is decided
  // by the export namespace of the library the prefix names.
  const run = useFixture('dart-export-closure', {
    'leaf.dart':
      'class User { void save() {} }\nUser make() => User();\nUser open() => User();\nUser _hidden() => User();\n',
    'decoy.dart':
      'class Admin { void save() {} }\nAdmin make() => Admin();\nAdmin open() => Admin();\n',
    // No `show`: the directive carries every public name and no private one.
    'mid.dart': "export 'leaf.dart';\n",
    // leaf -> mid -> top <-> ring: a name needs three hops to reach `ring`.
    'top.dart': "export 'mid.dart';\nexport 'ring.dart';\n",
    'ring.dart': "export 'top.dart';\nvoid ringOnly() {}\n",
    // Its own `make` and an exported `make`.
    'own.dart': "export 'leaf.dart';\nclass Local { void save() {} }\nLocal make() => Local();\n",
    'app.dart': `import 'ring.dart' as r;
import 'top.dart' as t;
import 'own.dart' as o;
import 'mid.dart' as m;
void throughCycle() { r.make().save(); t.ringOnly(); }
void ownWins() { o.make().save(); o.open().save(); }
void privateStays() { m._hidden().save(); }
void publicPasses() { m.open().save(); }
`,
  });
  const targets = (source: string): string[] =>
    getRelationships(run(), 'CALLS')
      .filter((edge) => edge.source === source)
      .map((edge) => edge.rel.targetId)
      .sort();

  it('carries a name through several export hops and around a cycle', () => {
    expect(targets('throughCycle')).toEqual([
      'Function:leaf.dart:make',
      'Function:ring.dart:ringOnly',
      'Method:leaf.dart:User.save#0',
    ]);
  });

  it("lets a library's own declaration win over an exported one of the same name", () => {
    expect(targets('ownWins')).toEqual([
      'Function:leaf.dart:open',
      'Function:own.dart:make',
      'Method:leaf.dart:User.save#0',
      'Method:own.dart:Local.save#0',
    ]);
  });

  it('never exports a private name, with or without a show', () => {
    expect(targets('privateStays')).toEqual([]);
    expect(targets('publicPasses')).toEqual([
      'Function:leaf.dart:open',
      'Method:leaf.dart:User.save#0',
    ]);
  });
});

describe.skipIf(!dartAvailable)('Dart ambiguous exports travel', () => {
  // `both.dart` exports `make` as two declarations, which Dart rejects. A
  // library that re-exports it does not get `make` back from a third export.
  const run = useFixture('dart-export-ambiguity', {
    'a1.dart': 'class User { void save() {} }\nUser make() => User();\n',
    'a2.dart': 'class Admin { void save() {} }\nAdmin make() => Admin();\n',
    'both.dart': "export 'a1.dart';\nexport 'a2.dart';\n",
    'c.dart':
      'class Guest { void save() {} }\nGuest make() => Guest();\nGuest only() => Guest();\n',
    'down.dart': "export 'both.dart';\nexport 'c.dart';\n",
    'app.dart': `import 'down.dart' as d;
void ambiguousUpstream() { d.make().save(); }
void unaffected() { d.only().save(); }
`,
  });
  const targets = (source: string): string[] =>
    getRelationships(run(), 'CALLS')
      .filter((edge) => edge.source === source)
      .map((edge) => edge.rel.targetId)
      .sort();

  it('refuses a name that is ambiguous in a re-exported library, beside one more declaration of it', () => {
    expect(targets('ambiguousUpstream')).toEqual([]);
    expect(targets('unaffected')).toEqual(['Function:c.dart:only', 'Method:c.dart:Guest.save#0']);
  });
});
