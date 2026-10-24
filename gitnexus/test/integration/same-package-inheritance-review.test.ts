import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

describe('implicit inheritance candidate ownership', () => {
  let root: string;
  let result: PipelineResult;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-inheritance-review-'));
    writeFixtureRepo(root, {
      'kt/p/B.kt': `package p
open class B {
  fun topLevel() {}
}
`,
      'kt/p/C.kt': `package p
fun helper() {
  class B {
    fun invisible() {}
  }
}
class C : B()
class Outer {
  class Nested : B()
}
fun localDeriving() {
  class Local : B()
}
`,
      'kt/q/B.kt': `package q
open class B {}
`,
      'java/p/B.java': `package p;
public class B {}
`,
      'java/q/B.java': `package q;
public class B {}
`,
      'java/p/Factory.java': `package p;
public class Factory {
  Object make() { return new external.B() {}; }
}
`,
      'cs/src/Feature/C.cs': `namespace P {
class C : B<int> {}
class Plain : B {}
}
`,
      'cs/src/Feature/B.cs': `namespace P {
class B {}
}
`,
      'cs/src/Generic/B.cs': `namespace P {
class B<T> {}
}
`,
      'cs/other/B.cs': `namespace Other {
class B {}
}
`,
    });
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  const bases = (source: string, file: string) =>
    getRelationships(result, 'EXTENDS')
      .filter((e) => e.source === source && e.sourceFilePath === file)
      .map((e) => e.targetFilePath);
  it.each(['C', 'Nested', 'Local'])('binds Kotlin %s to the package-level class', (name) => {
    expect(bases(name, 'kt/p/C.kt')).toEqual(['kt/p/B.kt']);
  });
  it('does not bind a qualified anonymous Java base to a package sibling', () => {
    const anonymous = getRelationships(result, 'EXTENDS').filter(
      (e) => e.sourceFilePath === 'java/p/Factory.java',
    );
    expect(anonymous).not.toContainEqual(
      expect.objectContaining({ targetFilePath: 'java/p/B.java' }),
    );
  });
  it('matches the written C# generic arity before path proximity', () => {
    expect(bases('C', 'cs/src/Feature/C.cs')).toEqual(['cs/src/Generic/B.cs']);
  });
  it('keeps the non-generic C# base distinct', () => {
    expect(bases('Plain', 'cs/src/Feature/C.cs')).toEqual(['cs/src/Feature/B.cs']);
  });
});
