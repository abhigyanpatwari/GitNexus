import { describe, expect, it } from 'vitest';
import { findDanglingEdges, getRelationships, useFixture } from './helpers.js';

// Python, Swift and Kotlin don't resolve Outer.Inner().member() chains yet,
// even without a name clash, so only C# is expected to produce the edge.
const CASES = [
  {
    language: 'Python',
    file: 'forms.py',
    caller: 'use',
    member: 'clean',
    expectedOwner: 'PostForm.Meta',
    resolves: false,
    content:
      'class UserForm:\n    class Meta:\n        def clean(self):\n            return 1\n\n' +
      'class PostForm:\n    class Meta:\n        def clean(self):\n            return 2\n\n' +
      'def use():\n    return PostForm.Meta().clean()\n',
  },
  {
    language: 'Swift',
    file: 'S.swift',
    caller: 'use',
    member: 'foo',
    expectedOwner: 'B.Inner',
    resolves: false,
    content:
      'struct A {\n  struct Inner {\n    func foo() -> Int { return 1 }\n  }\n}\n' +
      'struct B {\n  struct Inner {\n    func foo() -> Int { return 2 }\n  }\n}\n' +
      'func use() -> Int {\n  return B.Inner().foo()\n}\n',
  },
  {
    language: 'C#',
    file: 'C.cs',
    caller: 'M',
    member: 'Foo',
    expectedOwner: 'App.B.Inner',
    resolves: true,
    content:
      'namespace App;\n' +
      'public class A { public class Inner { public int Foo() { return 1; } } }\n' +
      'public class B { public class Inner { public int Foo() { return 2; } } }\n' +
      'public class Use { public int M() { return new B.Inner().Foo(); } }\n',
  },
  {
    language: 'Kotlin',
    file: 'K.kt',
    caller: 'use',
    member: 'foo',
    expectedOwner: 'app.B.Inner',
    resolves: false,
    content:
      'package app\n' +
      'class A { class Inner { fun foo(): Int = 1 } }\n' +
      'class B { class Inner { fun foo(): Int = 2 } }\n' +
      'fun use(): Int = B.Inner().foo()\n',
  },
] as const;

for (const testCase of CASES) {
  describe(`${testCase.language}: calls into same-tail nested types (#4188)`, () => {
    const run = useFixture(`nested-call-${testCase.language.replace('#', 'sharp').toLowerCase()}`, {
      [testCase.file]: testCase.content,
    });

    it('emits no edge to a missing node', () => {
      expect(findDanglingEdges(run())).toEqual([]);
    });

    it(`never resolves ${testCase.caller}() to the other nested type's ${testCase.member}`, () => {
      const targets = getRelationships(run(), 'CALLS')
        .filter((call) => call.source === testCase.caller && call.target === testCase.member)
        .map((call) => call.rel.targetId);
      if (testCase.resolves) expect(targets).toHaveLength(1);
      for (const target of targets) {
        expect(target).toContain(`:${testCase.expectedOwner}.${testCase.member}`);
      }
    });
  });
}
