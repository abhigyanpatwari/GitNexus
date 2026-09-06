/**
 * Unit tests for the per-language `isGlobalNameFallbackPlausible` hooks and the
 * shared path arithmetic they are built on.
 *
 * These hooks decide whether a UNIQUE-NAME GUESS is allowed to become a labeled
 * CALLS edge or must be dropped as impossible. The asymmetry matters for how
 * these tests are written: a wrong `false` deletes a real edge, so every case
 * that the language cannot decide is asserted to return `true`. "Refuses when
 * impossible" and "does not refuse when merely unproven" are therefore BOTH
 * requirements, and both are tested per language.
 *
 * Pure functions over synthetic stubs — no pipeline, no fixtures.
 */

import { describe, it, expect } from 'vitest';
import type { ParsedFile, ParsedImport, SymbolDefinition } from 'gitnexus-shared';
import { goIsGlobalNameFallbackPlausible } from '../../../src/core/ingestion/languages/go/name-fallback-visibility.js';
import { dartIsGlobalNameFallbackPlausible } from '../../../src/core/ingestion/languages/dart/name-fallback-visibility.js';
import { rustIsGlobalNameFallbackPlausible } from '../../../src/core/ingestion/languages/rust/name-fallback-visibility.js';
import { swiftIsGlobalNameFallbackPlausible } from '../../../src/core/ingestion/languages/swift/name-fallback-visibility.js';
import { rubyIsGlobalNameFallbackPlausible } from '../../../src/core/ingestion/languages/ruby/name-fallback-visibility.js';
import {
  directoryOf,
  modulePathReaches,
  moduleSegments,
  stripExtension,
} from '../../../src/core/ingestion/scope-resolution/utils/name-fallback-visibility.js';

const namedImport = (targetRaw: string, localName = 'x'): ParsedImport => ({
  kind: 'named',
  localName,
  importedName: localName,
  targetRaw,
});

const mkCaller = (
  filePath: string,
  imports: readonly ParsedImport[] = [],
  referenceSites: ParsedFile['referenceSites'] = [],
  localDefs: readonly SymbolDefinition[] = [],
): ParsedFile =>
  ({
    filePath,
    parsedImports: imports,
    referenceSites,
    localDefs,
  }) as unknown as ParsedFile;

/** A bare (unqualified) call site — the shape the name-guess tier exists for. */
const BARE_SITE = { name: 'unique_helper_xyz' } as const;

const mkCandidate = (filePath: string, qualifiedName: string, ownerId?: string): SymbolDefinition =>
  ({
    nodeId: `def:${filePath}:${qualifiedName}`,
    filePath,
    type: 'Function',
    qualifiedName,
    ownerId,
  }) as unknown as SymbolDefinition;

describe('shared path arithmetic', () => {
  it('splits module paths on /, :: and .', () => {
    expect(moduleSegments('a/b/c')).toEqual(['a', 'b', 'c']);
    expect(moduleSegments('crate::a::b')).toEqual(['crate', 'a', 'b']);
    expect(moduleSegments('com.example.Thing')).toEqual(['com', 'example', 'Thing']);
  });

  it('does not split a path-bearing specifier on its extension dot', () => {
    expect(moduleSegments('./util/parse.js')).toEqual(['util', 'parse.js']);
  });

  it('matches a written module prefix against a repo-relative directory', () => {
    // The written import carries a module prefix that is not a directory.
    expect(modulePathReaches('github.com/org/svc/internal/models', 'internal/models')).toBe(true);
    // ...and the reverse, when the module manifest sits in a subdirectory.
    expect(modulePathReaches('mod/internal/models', 'svc/internal/models')).toBe(true);
  });

  it('does not match unrelated paths that merely share a middle segment', () => {
    expect(modulePathReaches('github.com/org/svc/internal/models', 'internal/handlers')).toBe(
      false,
    );
    expect(modulePathReaches('a/b', 'c/d')).toBe(false);
  });

  it('reports no match for an empty path on either side', () => {
    expect(modulePathReaches('', 'a/b')).toBe(false);
    expect(modulePathReaches('a/b', '')).toBe(false);
  });

  it('derives directories and strips extensions', () => {
    expect(directoryOf('a/b/c.go')).toBe('a/b');
    expect(directoryOf('main.go')).toBe('');
    expect(stripExtension('a/b.rs')).toBe('a/b');
    expect(stripExtension('a/b')).toBe('a/b');
  });
});

describe('Go: isGlobalNameFallbackPlausible', () => {
  it('allows an external test package to dot-import exported production functions', () => {
    const callerParsed = mkCaller('foo/caller_test.go', [
      { kind: 'wildcard', targetRaw: 'example.com/mod/foo' },
    ]);
    const sourceTextOf = (file: string) =>
      file.endsWith('_test.go') ? 'package foo_test' : 'package foo';
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed,
        sourceTextOf,
        candidate: mkCandidate('foo/helper.go', 'Helper'),
      }),
    ).toBe(true);
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed,
        sourceTextOf,
        candidate: mkCandidate('foo/helper.go', 'helper'),
      }),
    ).toBe(false);
  });
  it('REFUSES an unexported identifier from another package', () => {
    // The headline case: `a.uniqueHelperXyz` is invisible to package `b`, and no
    // import can make it visible, so the guess is impossible rather than weak.
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('b/caller.go'),
        candidate: mkCandidate('a/helper.go', 'uniqueHelperXyz'),
      }),
    ).toBe(false);
  });

  it('REFUSES an unexported identifier even when the package IS imported', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('b/caller.go', [namedImport('example.com/mod/a')]),
        candidate: mkCandidate('a/helper.go', 'uniqueHelperXyz'),
      }),
    ).toBe(false);
  });

  it('allows an unexported identifier inside the SAME package directory', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('a/caller.go'),
        candidate: mkCandidate('a/helper.go', 'uniqueHelperXyz'),
      }),
    ).toBe(true);
  });

  it('REFUSES an exported identifier when the caller never imports its package', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('b/caller.go', [namedImport('example.com/mod/unrelated')]),
        candidate: mkCandidate('a/helper.go', 'UniqueHelperXyz'),
      }),
    ).toBe(false);
  });

  it('allows an exported identifier whose package the caller dot-imports', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('b/caller.go', [
          { kind: 'wildcard', targetRaw: 'example.com/mod/a' },
        ]),
        candidate: mkCandidate('a/helper.go', 'UniqueHelperXyz'),
      }),
    ).toBe(true);
  });

  it('REFUSES methods as bare calls even with a dot import', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('b/caller.go'),
        candidate: mkCandidate('a/helper.go', 'Host.doThing'),
      }),
    ).toBe(false);
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('b/caller.go', [{ kind: 'wildcard', targetRaw: 'mod/a' }]),
        candidate: mkCandidate('a/helper.go', 'Host.DoThing'),
      }),
    ).toBe(false);
  });

  it.each(['a', 'renamed', '_'])(
    'REFUSES an ordinary/alias/blank import (%s) for a bare call',
    (localName) => {
      expect(
        goIsGlobalNameFallbackPlausible({
          callerParsed: mkCaller('b/caller.go', [
            { kind: 'namespace', localName, importedName: 'a', targetRaw: 'mod/a' },
          ]),
          candidate: mkCandidate('a/helper.go', 'UniqueHelperXyz'),
        }),
      ).toBe(false);
    },
  );

  it('keeps internal tests of a production package named foo_test in the same package', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('a/caller_test.go'),
        candidate: mkCandidate('a/helper.go', 'uniqueHelperXyz'),
        sourceTextOf: () => 'package foo_test\n',
      }),
    ).toBe(true);
  });

  it('REFUSES same-directory declarations when the known package clauses differ', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('a/caller_test.go'),
        candidate: mkCandidate('a/helper.go', 'UniqueHelperXyz'),
        sourceTextOf: (path) => (path.endsWith('_test.go') ? 'package a_test\n' : 'package a\n'),
      }),
    ).toBe(false);
  });

  it('REFUSES a Method definition even in its own package with no qualified name', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('a/caller.go'),
        candidate: { ...mkCandidate('a/helper.go', 'DoThing'), type: 'Method' },
      }),
    ).toBe(false);
  });

  it('does not refuse when there is no identifier to judge', () => {
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('b/caller.go'),
        candidate: mkCandidate('a/helper.go', ''),
      }),
    ).toBe(true);
  });

  it("REFUSES an exported helper declared in another package's `_test.go`, module root included", () => {
    // A `_test.go` file is compiled only into its own package's test binary;
    // no other package can see it. The module-root exception used to run first
    // and accept `root_helper_test.go`'s exports for every subdirectory caller.
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('internal/svc/caller.go', [namedImport('github.com/org/mod')]),
        candidate: mkCandidate('helpers_test.go', 'ExportedTestHelper'),
      }),
    ).toBe(false);
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('internal/svc/caller.go', [
          namedImport('github.com/org/mod/internal/models'),
        ]),
        candidate: mkCandidate('internal/models/fixtures_test.go', 'NewFixture'),
      }),
    ).toBe(false);
    // ...even from another package's own test file.
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('internal/svc/caller_test.go', [
          namedImport('github.com/org/mod/internal/models'),
        ]),
        candidate: mkCandidate('internal/models/fixtures_test.go', 'NewFixture'),
      }),
    ).toBe(false);
  });

  it('requires a dot import even for the module ROOT package', () => {
    // The root package is imported by the module path alone, which the
    // repo-relative layout cannot align against — undecidable, so allowed.
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('internal/svc/caller.go', [
          { kind: 'wildcard', targetRaw: 'github.com/org/mod' },
        ]),
        candidate: mkCandidate('root.go', 'ExportedHelper'),
      }),
    ).toBe(true);
    expect(
      goIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('internal/svc/caller.go'),
        candidate: mkCandidate('root.go', 'ExportedHelper'),
      }),
    ).toBe(false);
  });
});

describe('Dart: isGlobalNameFallbackPlausible', () => {
  it('does NOT refuse a library-private name from another directory — a `part` URI may cross it', () => {
    // `part '../shared/gen.dart';` is legal Dart, and `part` directives are not
    // extracted yet, so "different directory" is undecidable, not impossible.
    // The edge stays a labeled guess rather than being deleted.
    expect(
      dartIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('lib/widgets/b.dart'),
        candidate: mkCandidate('lib/models/a.dart', '_privateHelper'),
      }),
    ).toBe(true);
  });

  it('allows a library-private name in a SIBLING file (possible `part`)', () => {
    // `part` directives are not extracted yet, and parts are siblings of their
    // library file — refusing here would delete the Flutter `foo.g.dart` edge.
    expect(
      dartIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('lib/b.dart'),
        candidate: mkCandidate('lib/a.dart', '_privateHelper'),
      }),
    ).toBe(true);
  });

  it('allows the generated-part idiom: `_$FooFromJson` in `foo.g.dart` beside `foo.dart`', () => {
    expect(
      dartIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('lib/models/foo.dart'),
        candidate: mkCandidate('lib/models/foo.g.dart', '_$FooFromJson'),
      }),
    ).toBe(true);
  });

  it('allows a library-private name in the same file', () => {
    expect(
      dartIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('lib/a.dart'),
        candidate: mkCandidate('lib/a.dart', '_privateHelper'),
      }),
    ).toBe(true);
  });

  it('allows a library-private name across directories when the caller names the file', () => {
    // The `part` / `part of` direction, once the extractor surfaces it as an
    // import target: an explicit directive against the candidate's file wins.
    expect(
      dartIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('lib/widgets/b.dart', [namedImport('lib/models/a.dart')]),
        candidate: mkCandidate('lib/models/a.dart', '_privateHelper'),
      }),
    ).toBe(true);
  });

  it('allows a public name across files', () => {
    expect(
      dartIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('lib/b.dart'),
        candidate: mkCandidate('lib/a.dart', 'publicHelper'),
      }),
    ).toBe(true);
  });

  it('judges privacy on the member, not its owner', () => {
    // `_Foo.bar` is a public member of a private class — the member name is what
    // a bare call would name, so it is not refused on the owner's underscore.
    expect(
      dartIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('lib/b.dart'),
        candidate: mkCandidate('lib/a.dart', '_Foo.bar'),
      }),
    ).toBe(true);
  });
});

describe('Rust: isGlobalNameFallbackPlausible', () => {
  it.each([
    ['src/a/b.rs', 'super::unique_helper_xyz', 'src/a.rs'],
    ['src/a/b/c.rs', 'super::super::unique_helper_xyz', 'src/a/mod.rs'],
    ['src/a/b.rs', 'self::child::unique_helper_xyz', 'src/a/b/child.rs'],
  ])('resolves relative imports from %s', (caller, target, candidate) => {
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller(caller, [namedImport(target, BARE_SITE.name)]),
        candidate: mkCandidate(candidate, BARE_SITE.name),
      }),
    ).toBe(true);
  });
  it('REFUSES a cross-module item with no covering `use`', () => {
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller('src/b.rs', [namedImport('crate::unrelated')]),
        candidate: mkCandidate('src/a.rs', 'unique_helper_xyz'),
      }),
    ).toBe(false);
  });

  it('allows a same-file item', () => {
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller('src/a.rs'),
        candidate: mkCandidate('src/a.rs', 'unique_helper_xyz'),
      }),
    ).toBe(true);
  });

  it('REFUSES a bare item when only its module was imported', () => {
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller('src/b.rs', [namedImport('crate::a')]),
        candidate: mkCandidate('src/a.rs', 'unique_helper_xyz'),
      }),
    ).toBe(false);
  });

  it('treats `mod.rs` as its parent directory module', () => {
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller('src/b.rs', [{ kind: 'wildcard', targetRaw: 'crate::net::http' }]),
        candidate: mkCandidate('src/net/http/mod.rs', 'unique_helper_xyz'),
      }),
    ).toBe(true);
  });

  it('does not refuse when the candidate file maps to no module path', () => {
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller('src/b.rs'),
        candidate: mkCandidate('lib.rs', 'unique_helper_xyz'),
      }),
    ).toBe(true);
  });

  it('allows an item whose `use` names the ITEM rather than only its module', () => {
    // A bare call exercises the import matcher, not the qualified-site bypass.
    const candidate = mkCandidate('src/user.rs', 'build_user');
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: { name: 'build_user' },
        callerParsed: mkCaller('src/main.rs', [
          namedImport('crate::user::build_user', 'build_user'),
        ]),
        candidate,
      }),
    ).toBe(true);
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: { name: 'build_user' },
        callerParsed: mkCaller('src/main.rs'),
        candidate,
      }),
    ).toBe(false);
  });

  it('REFUSES when the only `use` of the module names a DIFFERENT item', () => {
    // `use crate::a::other;` brings `other` into scope, not `helper`. The
    // parent-path match used to accept every item of `a` on its strength.
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller('src/b.rs', [namedImport('crate::a::other', 'other')]),
        candidate: mkCandidate('src/a.rs', 'unique_helper_xyz'),
      }),
    ).toBe(false);
  });

  it('accepts an aliased import only under its local spelling', () => {
    const callerParsed = mkCaller('src/b.rs', [
      {
        kind: 'named',
        localName: 'renamed',
        importedName: 'unique_helper_xyz',
        targetRaw: 'crate::a::unique_helper_xyz',
      },
    ]);
    const candidate = mkCandidate('src/a.rs', 'unique_helper_xyz');
    expect(rustIsGlobalNameFallbackPlausible({ callerParsed, candidate, site: BARE_SITE })).toBe(
      false,
    );
    expect(
      rustIsGlobalNameFallbackPlausible({ callerParsed, candidate, site: { name: 'renamed' } }),
    ).toBe(true);
  });

  it('allows a glob `use` of the module — every item is in scope', () => {
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller('src/b.rs', [{ kind: 'wildcard', targetRaw: 'crate::a' }]),
        candidate: mkCandidate('src/a.rs', 'unique_helper_xyz'),
      }),
    ).toBe(true);
  });

  it('allows a `use` that names the candidate itself, with the item on the path', () => {
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: BARE_SITE,
        callerParsed: mkCaller('src/b.rs', [
          namedImport('crate::a::unique_helper_xyz', 'unique_helper_xyz'),
        ]),
        candidate: mkCandidate('src/a.rs', 'unique_helper_xyz'),
      }),
    ).toBe(true);
  });

  it('does not judge a PATH-QUALIFIED call site', () => {
    // `User::new(...)` names its path in source. Refusing it for lacking a
    // `use` of the module would delete an edge the code spells out — the
    // regression this carve-out exists for (rust-scope.test.ts).
    expect(
      rustIsGlobalNameFallbackPlausible({
        site: { name: 'new', rawQualifiedName: 'User::new' },
        callerParsed: mkCaller('src/main.rs'),
        candidate: mkCandidate('src/user.rs', 'User.new'),
      }),
    ).toBe(true);
  });
});

describe('Swift: isGlobalNameFallbackPlausible', () => {
  it('does not invent module boundaries between arbitrary Xcode directories', () => {
    expect(
      swiftIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('App/Caller.swift'),
        candidate: mkCandidate('Shared/Helper.swift', 'helper'),
      }),
    ).toBe(true);
  });

  it('recognizes distinct src targets and requires a matching import', () => {
    const candidate = mkCandidate('src/Core/Helper.swift', 'helper');
    expect(
      swiftIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('src/App/Caller.swift'),
        candidate,
      }),
    ).toBe(false);
    expect(
      swiftIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('src/App/Caller.swift', [namedImport('Core')]),
        candidate,
      }),
    ).toBe(true);
  });
  it('allows a cross-file candidate in the same target (whole-module internal)', () => {
    expect(
      swiftIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('Sources/Core/Caller.swift'),
        candidate: mkCandidate('Sources/Core/Helper.swift', 'uniqueHelperXyz'),
      }),
    ).toBe(true);
  });

  it('REFUSES a candidate in another target the caller never imports', () => {
    expect(
      swiftIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('Sources/App/Caller.swift'),
        candidate: mkCandidate('Sources/Core/Helper.swift', 'uniqueHelperXyz'),
      }),
    ).toBe(false);
  });

  it('allows a candidate in another target the caller imports', () => {
    expect(
      swiftIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('Sources/App/Caller.swift', [namedImport('Core')]),
        candidate: mkCandidate('Sources/Core/Helper.swift', 'uniqueHelperXyz'),
      }),
    ).toBe(true);
  });

  it('does not refuse when the layout heuristic cannot place a file', () => {
    expect(
      swiftIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('Caller.swift'),
        candidate: mkCandidate('Sources/Core/Helper.swift', 'uniqueHelperXyz'),
      }),
    ).toBe(true);
  });
});

describe('Ruby: isGlobalNameFallbackPlausible', () => {
  /** A candidate file whose `localDefs` carry the owner with the given label. */
  const ownerFile =
    (ownerId: string, label: 'Class' | 'Trait') =>
    (filePath: string): ParsedFile | undefined =>
      ({
        filePath,
        parsedImports: [],
        referenceSites: [],
        localDefs: [{ nodeId: ownerId, filePath, type: label, qualifiedName: 'Billing' }],
      }) as unknown as ParsedFile;

  it('allows a TOP-LEVEL method across files (the autoload shape)', () => {
    // Ruby keeps this guess on purpose: with zeitwerk a file really can call a
    // method whose defining file it never requires.
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb'),
        candidate: mkCandidate('app/a.rb', 'unique_helper_xyz'),
      }),
    ).toBe(true);
  });

  it('REFUSES a CLASS-owned method whose class the caller never names', () => {
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb', [namedImport('app/unrelated')]),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
        sourceTextOf: () => 'unique_helper_xyz()',
      }),
    ).toBe(false);
  });

  it('allows a MODULE-owned method with no mention — Rails mixes modules in for you', () => {
    // `module ApplicationHelper` is included into every view by the framework;
    // a bare `format_money()` there is legal with no include/require/constant.
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/views/show.html.erb'),
        candidate: mkCandidate('app/helpers/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Trait'),
      }),
    ).toBe(true);
  });

  it('allows a class-owned method when the caller INHERITS from anything (transitive chains)', () => {
    // `class UsersController < AdminController` reaches ApplicationController's
    // methods while naming only AdminController — undecidable from one file.
    const inherits = {
      kind: 'inherits',
      name: 'AdminController',
    } as unknown as ParsedFile['referenceSites'][number];
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/controllers/users_controller.rb', [], [inherits]),
        candidate: mkCandidate(
          'app/controllers/application_controller.rb',
          'ApplicationController#unique_helper_xyz',
          'def:ApplicationController',
        ),
        parsedFileOf: ownerFile('def:ApplicationController', 'Class'),
      }),
    ).toBe(true);
  });

  it('allows a class-owned method when the caller mixes anything in (include/extend marker)', () => {
    const mixin = {
      kind: 'namespace',
      localName: 'Auditable',
      importedName: 'Auditable',
      targetRaw: '__heritage__:include:Auditable:Report',
    } as unknown as ParsedImport;
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/models/report.rb', [mixin]),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
      }),
    ).toBe(true);
  });

  it('allows a class-owned method when the caller file DEFINES a module (a mixin body)', () => {
    // `module PostGuardian; def can_see?(post); is_staff? ...` — the module's
    // methods run inside `class Guardian`, which includes it; the module file
    // never names Guardian.
    const moduleDef = {
      nodeId: 'def:PostGuardian',
      filePath: 'lib/guardian/post_guardian.rb',
      type: 'Trait',
      qualifiedName: 'PostGuardian',
    } as unknown as SymbolDefinition;
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('lib/guardian/post_guardian.rb', [], [], [moduleDef]),
        candidate: mkCandidate('lib/guardian.rb', 'Guardian#is_staff?', 'def:Guardian'),
        parsedFileOf: ownerFile('def:Guardian', 'Class'),
      }),
    ).toBe(true);
  });

  it('does not refuse when the owner cannot be typed (no file lookup)', () => {
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb'),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
      }),
    ).toBe(true);
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb'),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: () => undefined,
      }),
    ).toBe(true);
  });

  it('allows a class-owned method when the caller requires its namespace (snake_case path)', () => {
    // `require 'billing/invoice_service'` names `Billing::InvoiceService` — the
    // path is snake_case and the constant CamelCase, so the match normalizes.
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb', [namedImport('billing/invoice_service')]),
        candidate: mkCandidate(
          'app/a.rb',
          'Billing::InvoiceService#unique_helper_xyz',
          'def:InvoiceService',
        ),
        parsedFileOf: ownerFile('def:InvoiceService', 'Class'),
      }),
    ).toBe(true);
  });

  it('allows a class-owned method when the caller includes the constant by name', () => {
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb', [namedImport('Billing', 'Billing')]),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
      }),
    ).toBe(true);
  });

  it('allows a class-owned method when the caller mentions the constant', () => {
    const site = { name: 'Billing' } as unknown as ParsedFile['referenceSites'][number];
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb', [], [site]),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
      }),
    ).toBe(true);
  });

  it('REFUSES when the caller only mentions a LONGER constant containing the name as a substring', () => {
    // `BillingService.build` is not a mention of `Billing`; `includes()` said it was.
    const site = {
      name: 'build',
      rawQualifiedName: 'BillingService.build',
    } as unknown as ParsedFile['referenceSites'][number];
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb', [], [site]),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
        sourceTextOf: () => 'BillingService.build; unique_helper_xyz()',
      }),
    ).toBe(false);
  });

  it('allows a qualified mention whose SEGMENT is the constant (`Acme::Billing.new`)', () => {
    const site = {
      name: 'new',
      rawQualifiedName: 'Acme::Billing.new',
    } as unknown as ParsedFile['referenceSites'][number];
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb', [], [site]),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
      }),
    ).toBe(true);
  });

  it('keeps the LABELED guess when the caller file rebinds `self` (`instance_eval` DSL blocks) (magyargergo)', () => {
    // `service.instance_eval do unique_helper_xyz() end` dispatches the bare
    // call on `service`, so the class never being named here proves nothing.
    const src =
      'def caller(service)\n  service.instance_eval do\n    unique_helper_xyz()\n  end\nend\n';
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb'),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
        sourceTextOf: () => src,
      }),
    ).toBe(true);
    // ...and still REFUSES when the source has no such block.
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb'),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
        sourceTextOf: () => 'def caller\n  unique_helper_xyz()\nend\n',
      }),
    ).toBe(false);
    // A missing source text is an unanswered question, not a refusal.
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb'),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
        sourceTextOf: () => undefined,
      }),
    ).toBe(true);
  });

  it('keeps the labeled guess when the source lookup itself is absent', () => {
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb'),
        candidate: mkCandidate('app/a.rb', 'Billing.unique_helper_xyz', 'def:Billing'),
        parsedFileOf: ownerFile('def:Billing', 'Class'),
      }),
    ).toBe(true);
  });

  it('does not refuse an owned method with no nameable namespace', () => {
    expect(
      rubyIsGlobalNameFallbackPlausible({
        callerParsed: mkCaller('app/b.rb'),
        candidate: mkCandidate('app/a.rb', 'unique_helper_xyz', 'def:anon'),
        parsedFileOf: ownerFile('def:anon', 'Class'),
      }),
    ).toBe(true);
  });
});
