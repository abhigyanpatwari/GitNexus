import { describe, expect, it } from 'vitest';
import { javaProvider } from '../../../../src/core/ingestion/languages/java.js';
import { emitJavaScopeCaptures } from '../../../../src/core/ingestion/languages/java/captures.js';
import { extract } from '../../../../src/core/ingestion/scope-extractor.js';

describe('Java inferred call-result assignment captures', () => {
  it('keeps overload return types on their own declarations with complete written syntax', () => {
    const source = `class Case<T> {
      java.util.List<T>[] make(Integer value) { return null; }
      p.Result<Long> make(long value)[] { return null; }
    }`;
    const parsed = extract(emitJavaScopeCaptures(source, 'Case.java'), 'Case.java', javaProvider);
    expect(
      parsed.localDefs
        .filter((definition) => definition.type === 'Method')
        .map((definition) => ({
          parameters: definition.parameterTypes,
          returnType: definition.returnType,
        })),
    ).toEqual([
      { parameters: ['Integer'], returnType: 'java.util.List<T>[]' },
      { parameters: ['long'], returnType: 'p.Result<Long>[]' },
    ]);
  });
  it('preserves the exact initializer call identity only for var declarations', () => {
    const source = `class Case {
      Object make(int value) { return null; }
      void run(Case other) {
        var first = make(1);
        var wrapped = (make(2));
        var member = other.make(3);
        Object typed = make(4);
        var constructed = new Case();
      }
    }`;
    const parsed = extract(emitJavaScopeCaptures(source, 'Case.java'), 'Case.java', javaProvider);
    const sites = parsed.callResultAssignmentSites ?? [];
    expect(sites.map((site) => site.lhs)).toEqual(['first', 'wrapped', 'member']);
    for (const site of sites) {
      expect(parsed.referenceSites).toContainEqual(
        expect.objectContaining({ name: 'make', atRange: site.callSite, inScope: site.inScope }),
      );
    }
  });
});
