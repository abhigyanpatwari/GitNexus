import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';

// A bare field read in a subclass (`inner.save()`, an implicit `this.inner`)
// is typed by the field the class inherits from a base in another file of its
// package. That must not depend on how many files the package holds: the
// package-sibling machinery caps and then skips large packages.
describe('Java fields inherited from a same-package base', () => {
  it.each([
    { label: 'small package', extraSiblings: 0 },
    { label: 'package past the sibling skip', extraSiblings: 501 },
  ])(
    'types a bare inherited field in a $label',
    async ({ extraSiblings }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-inherited-field-'));
      try {
        const files: Record<string, string> = {
          'src/app/Base.java': `package app;
public class Base {
  public static class Inner { public void save() {} }
  protected Inner inner;
  protected Inner shadow;
}
`,
          'src/app/Other.java': `package app;
public class Other { public void save() {} }
`,
          'src/app/Kid.java': `package app;
public class Kid extends Base {
  Other shadow;
  void run() {
    inner.save();
    shadow.save();
  }
}
`,
        };
        for (let i = 0; i < extraSiblings; i++)
          files[`src/app/F${i}.java`] = `package app;\nclass F${i} {}\n`;
        writeFixtureRepo(root, files);
        const result = await runPipelineFromRepo(root, () => {}, {});
        const targets = getRelationships(result, 'CALLS')
          .filter((edge) => edge.rel.sourceId === 'Method:src/app/Kid.java:Kid.run#0')
          .map((edge) => edge.rel.targetId)
          .sort();
        // The class's own `shadow` hides the inherited one.
        expect(targets).toEqual([
          'Method:src/app/Base.java:Inner.save#0',
          'Method:src/app/Other.java:Other.save#0',
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});
