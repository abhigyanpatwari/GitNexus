import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { applyJavaLocalNameClaims } from '../../src/core/ingestion/languages/java/local-name-claims.js';
import { getJavaParser } from '../../src/core/ingestion/languages/java/query.js';
import { nodeToCapture } from '../../src/core/ingestion/utils/ast-helpers.js';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java lexical scope and receiver review follow-ups', () => {
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
});
