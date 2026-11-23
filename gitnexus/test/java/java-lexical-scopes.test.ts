import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { applyJavaLocalNameClaims } from '../../src/core/ingestion/languages/java/local-name-claims.js';
import { getJavaParser } from '../../src/core/ingestion/languages/java/query.js';
import { nodeToCapture } from '../../src/core/ingestion/utils/ast-helpers.js';
import {
  getRelationships,
  runPipelineFromRepo,
  useFixture,
  writeFixtureRepo,
} from '../integration/resolvers/helpers.js';

// Java lexical scopes: alias ownership, local name claims, and lambda,
// anonymous-class and switch-group scoping of receivers.

describe('Java alias lexical ownership', () => {
  const result = useFixture('java-alias-lexical-ownership', {
    'Main.java': `
class User { void save() {} public String toString() { return "user"; } }
class Repo { void save() {} public String toString() { return "repo"; } }
class Unknown {}
class Address { void save() {} }
class OtherAddress { void save() {} }
class Holder { User user; }
class Customer {
  Address address;
  Unknown unresolved;
  OtherAddress address() { return new OtherAddress(); }
  OtherAddress unresolved() { return new OtherAddress(); }
}
class Factory { Repo make() { return new Repo(); } }
class OtherFactory { User make() { return new User(); } }
class App {
  Repo x;
  Repo field;
  void seedOtherMethod() { User x = new User(); }
  void parameterAlias(Repo x) { var copy = x; copy.save(); }
  void unknownParameterAlias(Unknown x) { var copy = x; copy.save(); }
  void fieldAlias(Customer user) {
    OtherAddress address = new OtherAddress();
    var copy = user.address;
    copy.save();
  }
  void fieldVersusMethodAlias(Customer user) { var copy = user.address; copy.save(); }
  void unknownFieldVersusMethodAlias(Customer user) { var copy = user.unresolved; copy.save(); }
  void thisFieldAlias() { var copy = this.field; copy.save(); }
  void nestedFieldAlias(Holder holder) { var copy = holder.user; copy.save(); }
  void beforeLocalDeclaration() {
    var copy = x;
    User x = new User();
    copy.save();
  }
  void afterLocalDeclaration() {
    User x = new User();
    var copy = x;
    copy.save();
  }
  void adjacentAlias(boolean ready, User source) {
    if (ready) {}var x = source;
    x.save();
  }
  void adjacentTyped(boolean ready, User source) {
    if (ready) {}User x = source;
    x.save();
  }
  void adjacentConstructor(boolean ready) {
    if (ready) {}var x = new User();
    x.save();
  }
  void adjacentAnonymous(boolean ready) {
    if (ready) {}var x = new User() { @Override void save() {} };
    x.save();
  }
  void factoryAlias(Factory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void loopFactoryAlias(Factory factory) {
    for (var value = factory.make(); value != null;) { var copy = value; copy.save(); break; }
  }
  void afterLoopFactoryAlias(Factory factory, User valueAfter) {
    for (var value = factory.make(); value != null;) { break; }
    var value = valueAfter; var copy = value; copy.save();
  }
  void competingFactoryAlias(OtherFactory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void unknownLocalAlias() { Unknown x = new Unknown(); var copy = x; copy.save(); }
  void declaredTypeAfterAssignment(Factory factory) {
    Object value = new User();
    var copy = value;
    value = factory.make();
    copy.toString();
  }
}
`,
  });

  it.each([
    ['parameterAlias', 'Repo', 1],
    ['fieldAlias', 'Address', 1],
    ['fieldVersusMethodAlias', 'Address', 1],
    ['thisFieldAlias', 'Repo', 0],
    ['nestedFieldAlias', 'User', 1],
    ['beforeLocalDeclaration', 'Repo', 0],
    ['afterLocalDeclaration', 'User', 0],
    ['adjacentAlias', 'User', 2],
    ['adjacentTyped', 'User', 2],
    ['adjacentConstructor', 'User', 1],
    ['adjacentAnonymous', 'App$1', 1],
    ['factoryAlias', 'Repo', 1],
    ['loopFactoryAlias', 'Repo', 1],
    ['afterLoopFactoryAlias', 'User', 2],
    ['competingFactoryAlias', 'User', 1],
  ])('resolves %s to the exact %s owner', (caller, owner, arity) => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === `Method:Main.java:App.${caller}#${arity}` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId)
      .sort();
    expect(targets).toEqual([`Method:Main.java:${owner}.save#0`]);
  });

  it('does not infer an unknown parameter alias from a same-named field or another method', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:App.unknownParameterAlias#1' &&
          edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([]);
  });

  it('does not infer an unknown local alias from a same-named field or another method', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:App.unknownLocalAlias#0' &&
          edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([]);
  });

  it('does not reinterpret a field alias as a same-named zero-argument method', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:App.unknownFieldVersusMethodAlias#1' &&
          edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([]);
  });

  it('preserves the declared alias type across later assignment of its source', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:App.declaredTypeAfterAssignment#1' &&
          edge.target === 'toString',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([]);
  });
});

describe('Java local alias source order and block claims', () => {
  const result = useFixture('java-local-alias-scope-claims', {
    'Main.java': `
class User { void save() {} void userOnly() {} }
class Repo { void save() {} void repoOnly() {} }
class Unknown {}
class App {
  Repo x;
  void beforeLocal() { var copy = x; User x = new User(); copy.save(); }
  void afterLocal() { User x = new User(); var copy = x; copy.save(); }
  void afterNested() { { User x = new User(); } var copy = x; copy.save(); }
  void beforeNested() { var copy = x; { User x = new User(); } copy.save(); }
  void withinNested() { { User x = new User(); var copy = x; copy.save(); } }
  void siblingBlocks() {
    { User x = new User(); var copy = x; copy.userOnly(); }
    { Repo x = new Repo(); var copy = x; copy.repoOnly(); }
  }
  void afterFor() { for (User x = new User(); condition; ) { x.userOnly(); } var copy = x; copy.save(); }
  void unknownShadow() { Unknown x = null; var copy = x; copy.save(); }
  void invalidSelfRead() { var x = x; x.save(); }
}
`,
  });
  const targets = (caller: string, member = 'save') =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === `Method:Main.java:App.${caller}#0` && edge.target === member,
      )
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    ['beforeLocal', 'Repo'],
    ['afterLocal', 'User'],
    ['afterNested', 'Repo'],
    ['beforeNested', 'Repo'],
    ['withinNested', 'User'],
    ['afterFor', 'Repo'],
  ])('preserves the exact lexical owner in %s', (caller, owner) => {
    expect(targets(caller)).toEqual([`Method:Main.java:${owner}.save#0`]);
  });
  it('keeps sibling block aliases separate', () => {
    expect(targets('siblingBlocks', 'userOnly')).toEqual(['Method:Main.java:User.userOnly#0']);
    expect(targets('siblingBlocks', 'repoOnly')).toEqual(['Method:Main.java:Repo.repoOnly#0']);
  });
  it.each(['unknownShadow', 'invalidSelfRead'])(
    '%s cannot borrow an outer field type',
    (caller) => {
      expect(targets(caller)).toEqual([]);
    },
  );
});

describe('Java lambda receiver lexical ownership', () => {
  it('keeps typed, unknown, sibling and nested lambda receivers in their lexical scopes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-lambda-ownership-'));
    try {
      writeFixtureRepo(root, {
        'Main.java': `class User { void save() {} void audit() {} }
  class Other { void save() {} }
  class App {
    User x; User y;
    void accept(Object callback) {}
    void own() {}
    void sibling() {
      accept((User x) -> x.save());
      accept((Other x) -> { x.save(); });
    }
    void unknown() { accept(x -> x.audit()); }
    void unknownList() { accept((x, y) -> x.audit()); }
    void nested() { accept((User outer) -> { accept(y -> y.audit()); outer.save(); }); }
    void lexicalThis() { accept(x -> this.own()); }
    void afterLambda() { accept((Other x) -> x.save()); x.audit(); }
  }
  `,
      });
      const result = await runPipelineFromRepo(root, () => {}, {});
      const targets = (caller: string, member: string) =>
        getRelationships(result, 'CALLS')
          .filter(
            (edge) =>
              edge.rel.sourceId === `Method:Main.java:App.${caller}#0` && edge.target === member,
          )
          .map((edge) => edge.rel.targetId)
          .sort();
      expect(targets('sibling', 'save')).toEqual([
        'Method:Main.java:Other.save#0',
        'Method:Main.java:User.save#0',
      ]);
      expect(targets('unknown', 'audit')).toEqual([]);
      expect(targets('unknownList', 'audit')).toEqual([]);
      expect(targets('nested', 'audit')).toEqual([]);
      expect(targets('nested', 'save')).toEqual(['Method:Main.java:User.save#0']);
      expect(targets('lexicalThis', 'own')).toEqual(['Method:Main.java:App.own#0']);
      expect(targets('afterLambda', 'audit')).toEqual(['Method:Main.java:User.audit#0']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});

describe('Java lexical scope and receiver', () => {
  const result = useFixture('java-review-followups-scopes', {
    'Model.java': `class User { void save() {} void store() {} }
class Other { void save() {} void store() {} }
class Factory { User make() { return null; } }
class OtherFactory { Other make() { return null; } }`,
    'Switches.java': `class Switches {
  Other x;
  void groupLocalEndsWithSwitch(int k) {
    switch (k) { case 1: User x = null; }
    var y = x;
    y.save();
  }
  void groupLocalInsideSwitch(int k) {
    switch (k) { case 1: User x = null; var w = x; w.save(); }
  }
}`,
    'Records.java': `record Rec(int n) {
  Rec {
    items()[0].save();
  }
  User[] items() { return null; }
}
class Holder { Other[] items() { return null; } }`,
    'Comments.java': `class Comments {
  void parameter(User // element type continues below
      [] values) { values[0].save(); }
  void local() {
    User // element type continues below
      [] values = null;
    values[0].save();
  }
}`,
    'Aliases.java': `class Aliases {
  void nestedCopy(Factory f, boolean c) {
    var u = f.make();
    if (c) { var w = u; w.save(); }
  }
  void deeplyNestedCopy(Factory f, boolean c) {
    var u = f.make();
    if (c) { while (c) { var w = u; { var x = w; x.save(); } } }
  }
  void lambdaCopy(Factory f) {
    var u = f.make();
    Runnable r = () -> { var w = u; w.save(); };
  }
  void reassignedBeforeCopy(Factory f, OtherFactory g, boolean c) {
    var u = f.make();
    if (c) { u = g.make(); var w = u; w.save(); }
  }
  void reassignedLaterInLoop(Factory f, boolean c) {
    var u = f.make();
    while (c) { var w = u; w.save(); u = null; }
  }
  void anonymousFieldShadow(Factory f) {
    var u = f.make();
    new Object() {
      Other u;
      void m() { var w = u; w.save(); }
    };
  }
  void outerRedeclaration(Factory f, OtherFactory g, boolean c) {
    var u = f.make();
    if (c) { var w = u; w.save(); }
    var w = g.make();
    w.store();
  }
}`,
  });
  const targets = (source: string, member = 'save') =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId.startsWith(source) && edge.target === member)
      .map((edge) => edge.rel.targetId)
      .sort();

  it('ends an old-style switch group local with its switch block', () => {
    expect(targets('Method:Switches.java:Switches.groupLocalEndsWithSwitch#')).toEqual([
      'Method:Model.java:Other.save#0',
    ]);
  });

  it('keeps a switch group local visible inside its own switch block', () => {
    expect(targets('Method:Switches.java:Switches.groupLocalInsideSwitch#')).toEqual([
      'Method:Model.java:User.save#0',
    ]);
  });

  it('treats a record compact constructor as an instance array receiver context', () => {
    expect(targets('Record:Records.java:Rec')).toEqual(['Method:Model.java:User.save#0']);
  });

  it.each(['parameter', 'local'])(
    'reads an array type split by a line comment in %s declarations',
    (caller) => {
      expect(targets(`Method:Comments.java:Comments.${caller}#`)).toEqual([
        'Method:Model.java:User.save#0',
      ]);
    },
  );

  it.each(['nestedCopy', 'deeplyNestedCopy', 'lambdaCopy'])(
    '%s keeps the producer of an unwritten source copied in a nested block',
    (caller) => {
      expect(targets(`Method:Aliases.java:Aliases.${caller}#`)).toEqual([
        'Method:Model.java:User.save#0',
      ]);
    },
  );

  it.each(['reassignedBeforeCopy', 'reassignedLaterInLoop'])(
    '%s refuses a nested copy of a written source',
    (caller) => {
      expect(targets(`Method:Aliases.java:Aliases.${caller}#`)).toEqual([]);
    },
  );

  it('does not read an outer local through a same-named anonymous class field', () => {
    expect(targets('Method:Aliases.java:Aliases$1.m#')).toEqual(['Method:Model.java:Other.save#0']);
  });

  it('keeps a nested copy out of a later same-named outer declaration', () => {
    expect(targets('Method:Aliases.java:Aliases.outerRedeclaration#')).toEqual([
      'Method:Model.java:User.save#0',
    ]);
    expect(targets('Method:Aliases.java:Aliases.outerRedeclaration#', 'store')).toEqual([
      'Method:Model.java:Other.store#0',
    ]);
  });
});

describe('Java local name claims merge with existing scope claims', () => {
  const blockScope = (claimsText: string) => {
    const tree = getJavaParser().parse('class App { void run() { var copy = 1; } }');
    const anchor = nodeToCapture('@scope.block', tree.rootNode.descendantsOfType('block')[0]!);
    const match: CaptureMatch = {
      '@scope.block': anchor,
      '@scope.name-claims': { ...anchor, name: '@scope.name-claims', text: claimsText },
    };
    return applyJavaLocalNameClaims(tree.rootNode, [match])[0]!['@scope.name-claims']!.text;
  };

  it.each(['{not json', '{"name":"prior"}'])(
    'keeps claims it cannot read exactly as written: %s',
    (claimsText) => {
      expect(blockScope(claimsText)).toBe(claimsText);
    },
  );

  it('appends local claims after readable existing claims', () => {
    const merged = JSON.parse(blockScope('[{"name":"prior","kind":"blocked"}]')) as {
      name: string;
    }[];
    expect(merged.map((claim) => claim.name)).toEqual(['prior', 'copy']);
  });

  it('assigns a declaration starting at a closing block boundary to the enclosing block', () => {
    const inner = '{ int inner = 0;}';
    const outer = `{ if (ready) ${inner}User same = input; }`;
    const tree = getJavaParser().parse(
      `class App { void run(boolean ready, User input) ${outer} }`,
    );
    const claims = new Map(
      applyJavaLocalNameClaims(tree.rootNode, []).map((match) => [
        match['@scope.block']?.text,
        (JSON.parse(match['@scope.name-claims']?.text ?? '[]') as { name: string }[]).map(
          (claim) => claim.name,
        ),
      ]),
    );
    expect(claims.get(inner)).toEqual(['inner']);
    expect(claims.get(outer)).toEqual(['same']);
  });
});

describe('Java switch groups, shadowed writes, initializer receivers and pattern types', () => {
  const result = useFixture('java-review-followups-r2-captures', {
    'Model.java': `package p;
class User { void save() {} int id() { return 0; } }
class Other { void save() {} int id() { return 0; } }
class Repo { Other other() { return null; } User user() { return null; } }
class Decoy { Other[] items() { return null; } }
@interface Ann {}`,
    'Switches.java': `package p;
class Switches {
  Repo repo;
  Switches() { var o = repo.other(); var c = o; c.save(); }
  void unbracedGroup(int k) { var o = repo.other(); switch (k) { case 1: var c = o; c.save(); break; } }
  void producerInGroup(int k) { switch (k) { case 1: var o = repo.other(); var c = o; c.save(); break; } }
  void switchExpressionGroup(int k) {
    var o = repo.other();
    int r = switch (k) { case 1: var c = o; c.save(); yield 1; default: yield 0; };
  }
  void writtenInGroup(int k) { var o = repo.other(); switch (k) { case 1: o = repo.user(); var c = o; c.save(); break; } }
  void writtenInLaterGroup(int k) {
    var o = repo.other();
    switch (k) { case 1: var c = o; c.save(); break; case 2: o = repo.user(); break; }
  }
}`,
    'Shadow.java': `package p;
class Shadow {
  Repo repo;
  void localClassFieldAfterCopy(boolean ready) {
    var x = repo.other();
    if (ready) { var y = x; y.save(); }
    class L { Other x; void f() { x = null; } }
  }
  void localClassFieldBeforeCopy() {
    var x = repo.other();
    class L { Repo x; void f() { x = null; } }
    var y = x;
    y.save();
  }
  void anonymousClassField() {
    var x = repo.other();
    Runnable r = new Runnable() { Repo x; public void run() { x = null; } };
    var y = x;
    y.save();
  }
  void localTypeNamedLikeProducerType() {
    var x = repo.other();
    class Other { void save() {} }
    var y = x;
    y.save();
  }
  void realWrite(boolean ready) {
    var x = repo.other();
    if (ready) { var y = x; y.save(); }
    x = repo.user();
  }
}`,
    'Init.java': `package p;
class FieldInit { int first = items()[0].id(); User[] items() { return null; } }
class BlockInit { { items()[0].save(); } User[] items() { return null; } }
class LambdaFieldInit { Runnable action = () -> items()[0].save(); User[] items() { return null; } }
enum EnumInit { A; int first = items()[0].id(); { items()[0].save(); } User[] items() { return null; } }
class StaticFieldInit { static int first = items()[0].id(); User[] items() { return null; } }
class StaticBlockInit { static { items()[0].save(); } User[] items() { return null; } }
interface ConstantInit { int FIRST = items()[0].id(); default User[] items() { return null; } }`,
    'Patterns.java': `package p;
class Patterns {
  void annotated(Object o) { if (o instanceof @Ann User u) { u.save(); } }
  void qualifiedAnnotated(Object o) { if (o instanceof p.@Ann User u) { u.save(); } }
}`,
  });
  const targets = (source: string, member: string) =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId.startsWith(source) && edge.target === member)
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    'Constructor:Switches.java:Switches.Switches#',
    'Method:Switches.java:Switches.unbracedGroup#',
    'Method:Switches.java:Switches.producerInGroup#',
    'Method:Switches.java:Switches.switchExpressionGroup#',
  ])('keeps a var copy made in an unbraced switch group or constructor: %s', (caller) => {
    expect(targets(caller, 'save')).toEqual(['Method:Model.java:Other.save#0']);
  });

  it.each([
    'Method:Switches.java:Switches.writtenInGroup#',
    'Method:Switches.java:Switches.writtenInLaterGroup#',
  ])('refuses a switch-group copy of a source written in the switch: %s', (caller) => {
    expect(targets(caller, 'save')).toEqual([]);
  });

  it.each([
    'Method:Shadow.java:Shadow.localClassFieldAfterCopy#',
    'Method:Shadow.java:Shadow.localClassFieldBeforeCopy#',
    'Method:Shadow.java:Shadow.anonymousClassField#',
  ])('does not treat a same-named field write as a write to the outer local: %s', (caller) => {
    expect(targets(caller, 'save')).toEqual(['Method:Model.java:Other.save#0']);
  });

  it('types a copy after a local type by the producer, not by the local type', () => {
    expect(targets('Method:Shadow.java:Shadow.localTypeNamedLikeProducerType#', 'save')).toEqual([
      'Method:Model.java:Other.save#0',
    ]);
  });

  it('still refuses a nested copy when the outer local itself is written', () => {
    expect(targets('Method:Shadow.java:Shadow.realWrite#', 'save')).toEqual([]);
  });

  it.each([
    ['Class:Init.java:FieldInit', 'id', 'Method:Model.java:User.id#0'],
    ['Class:Init.java:BlockInit', 'save', 'Method:Model.java:User.save#0'],
    ['Class:Init.java:LambdaFieldInit', 'save', 'Method:Model.java:User.save#0'],
    ['Enum:Init.java:EnumInit', 'id', 'Method:Model.java:User.id#0'],
    ['Enum:Init.java:EnumInit', 'save', 'Method:Model.java:User.save#0'],
  ])('reads an implicit this array receiver in %s initializers (%s)', (caller, member, target) => {
    expect(targets(caller, member)).toEqual([target]);
  });

  it.each([
    ['Class:Init.java:StaticFieldInit', 'id'],
    ['Class:Init.java:StaticBlockInit', 'save'],
    ['Interface:Init.java:ConstantInit', 'id'],
  ])('refuses an implicit this array receiver in static %s initializers (%s)', (caller, member) => {
    expect(targets(caller, member)).toEqual([]);
  });

  it.each(['annotated', 'qualifiedAnnotated'])(
    'binds an annotated instanceof pattern to its type without the annotation: %s',
    (caller) => {
      expect(targets(`Method:Patterns.java:Patterns.${caller}#`, 'save')).toEqual([
        'Method:Model.java:User.save#0',
      ]);
    },
  );
});

describe('Java copy of an enclosing local inside an anonymous class method', () => {
  const result = useFixture('java-review-followups-r5-anonymous-alias', {
    'lib/PackageTask.java': 'package lib; public abstract class PackageTask { Object value; }',
    'Main.java': `
import lib.LibraryTask;
class User { void save() {} }
class Other { void save() {} }
class Factory { User make() { return null; } }
abstract class Task { abstract void m(); }
abstract class Sink { abstract void m(Other value); }
abstract class FieldTask { Other value; abstract void m(); }
abstract class DeepTask extends FieldTask {}
abstract class PrivateTask { private Other value; }
class App {
  Factory factory;
  void captured() {
    var value = factory.make();
    new Task() { void m() { var copy = value; copy.save(); } };
  }
  void inLocalClass() {
    var value = factory.make();
    class Local { void m() { var copy = value; copy.save(); } }
  }
  void inheritedField() {
    var value = factory.make();
    new FieldTask() { void m() { var copy = value; copy.save(); } };
  }
  void deepInheritedField() {
    var value = factory.make();
    new DeepTask() { void m() { var copy = value; copy.save(); } };
  }
  void externalSupertype() {
    var value = factory.make();
    new LibraryTask() { public void run() { var copy = value; copy.save(); } };
  }
  void ownField() {
    var value = factory.make();
    new Task() { Other value; void m() { var copy = value; copy.save(); } };
  }
  void parameter() {
    var value = factory.make();
    new Sink() { void m(Other value) { var copy = value; copy.save(); } };
  }
  void writtenAfter() {
    var value = factory.make();
    new Task() { void m() { var copy = value; copy.save(); } };
    value = null;
  }
  void unknownFactory(lib.LibraryFactory external) {
    var value = external.make();
    new FieldTask() { void m() { var copy = value; copy.save(); } };
  }
  void externalFieldTask() {
    var value = factory.make();
    new lib.FieldTask() { public void m() { var copy = value; copy.save(); } };
  }
  void packageField() {
    var value = factory.make();
    class PackageLocal extends lib.PackageTask { void m() { var copy = value; copy.save(); } }
  }
  void privateField() {
    var value = factory.make();
    new PrivateTask() { void m() { var copy = value; copy.save(); } };
  }
}
`,
  });

  const saveTargets = (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === `Method:Main.java:${caller}` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([['App$1.m#0'], ['App$1Local.m#0'], ['App$1PackageLocal.m#0'], ['App$10.m#0']])(
    'types the copy in %s from the enclosing local producer',
    (caller) => {
      expect(saveTargets(caller)).toEqual(['Method:Main.java:User.save#0']);
    },
  );

  it.each([
    ['App$5.m#0', 'a field the anonymous class declares'],
    ['App$6.m#1', 'a parameter'],
  ])('reads the copy in %s through %s, not the enclosing local', (caller) => {
    expect(saveTargets(caller)).toEqual(['Method:Main.java:Other.save#0']);
  });

  it.each([
    ['App$2.m#0', 'a workspace supertype declares a field of that name'],
    ['App$3.m#0', 'an indirect workspace supertype declares a field of that name'],
    ['App$8.m#0', 'the enclosing factory is external and the supertype declares the field'],
  ])('types the copy in %s from the inherited field when %s', (caller) => {
    expect(saveTargets(caller)).toEqual(['Method:Main.java:Other.save#0']);
  });

  it.each([
    ['App$4.run#0', 'the supertype is outside the workspace and may declare that field'],
    ['App$7.m#0', 'the local is written after its declaration'],
    ['App$9.m#0', 'an external supertype has the same simple name as a workspace class'],
  ])('leaves the copy in %s unresolved when %s', (caller) => {
    expect(result().graph.getNode(`Method:Main.java:${caller}`)).toBeDefined();
    expect(saveTargets(caller)).toEqual([]);
  });
});
