import { describe, expect, it } from 'vitest';
import { useFixture } from './helpers.js';

describe('JavaScript numeric property keys', () => {
  const result = useFixture(
    'js-numeric-property-keys',
    {
      'valid.cjs': [
        'class StrictClass { named() {} }',
        'function strictFunction() { "use strict"; return 1; }',
        'const obj = { [077]() { "use strict"; }, 08() {}, 09() {}, [08.5]() {}, [-010]() {}, [0x2an]() {} };',
        'function octal() { obj[077](); }',
        'function equivalent() { obj[63](); }',
        'function decimal() { obj[8.5](); }',
        'function eight() { obj[8](); }',
        'function nine() { obj[09](); }',
        'function negative() { obj[-8](); }',
        'function bigint() { obj[42](); }',
        'const key = "dynamic";',
        'const grouped = { [ +(077) ]() {}, [-(077)]() {}, [("text")]() {}, [(key)]() {} };',
        'function positiveGroup() { grouped[((077))](); }',
        'function negativeGroup() { grouped[-(077)](); }',
        'function staticGroup() { grouped[("text")](); }',
        'function dynamicGroup() { grouped[(key)](); grouped[(1 + 2)](); }',
      ].join('\n'),
      'strict.cjs': '"other"; /* comment */ "use strict"; const strict = { [077]() {} };',
      'strict-call.cjs': [
        'const obj = { 63() {} };',
        'function invalid() { "use strict"; obj[077](); }',
        'function modernValid() { obj[63](); }',
      ].join('\n'),
      'local.cjs': 'function local() { "use strict"; const nested = { [077]() {} }; }',
      'class.cjs': 'class Strict { [077]() {} }',
      'class-field.cjs': 'const before = { [077]() {} }; const Strict = class { [08] = 1; };',
      'class-heritage.cjs': 'class Strict extends bases[09] {} const after = { [077]() {} };',
      'module.mjs': 'const esm = { [077]() {} };',
      'typescript.cts': 'const ts = { [077]() {} };',
      'modern.mjs': 'class Modern { [0o77](arg) {} } function modern() { new Modern()[63](1); }',
    },
    { skipDerivedGraphPhases: true, workerPoolSize: 1 },
  );

  it('resolves octal and legacy decimal keys using their runtime values', () => {
    const { graph } = result();
    const calls = [...graph.iterRelationshipsByType('CALLS')]
      .filter((edge) => edge.sourceId.startsWith('Function:valid.cjs:'))
      .map((edge) => [edge.sourceId, edge.targetId])
      .sort();
    expect(calls).toEqual([
      ['Function:valid.cjs:bigint', 'Method:valid.cjs:obj.42#0'],
      ['Function:valid.cjs:decimal', 'Method:valid.cjs:obj.8.5#0'],
      ['Function:valid.cjs:eight', 'Method:valid.cjs:obj.8#0'],
      ['Function:valid.cjs:equivalent', 'Method:valid.cjs:obj.63#0'],
      ['Function:valid.cjs:negative', 'Method:valid.cjs:obj.-8#0'],
      ['Function:valid.cjs:negativeGroup', 'Method:valid.cjs:grouped.-63#0'],
      ['Function:valid.cjs:nine', 'Method:valid.cjs:obj.9#0'],
      ['Function:valid.cjs:octal', 'Method:valid.cjs:obj.63#0'],
      ['Function:valid.cjs:positiveGroup', 'Method:valid.cjs:grouped.63#0'],
      ['Function:valid.cjs:staticGroup', 'Method:valid.cjs:grouped.text#0'],
    ]);
    expect(
      graph.nodes
        .filter((node) => node.id.startsWith('Method:valid.cjs:grouped.'))
        .map((node) => node.id)
        .sort(),
    ).toEqual([
      'Method:valid.cjs:grouped.-63#0',
      'Method:valid.cjs:grouped.63#0',
      'Method:valid.cjs:grouped.text#0',
    ]);
  });

  it('excludes illegal legacy keys and retains modern keys in strict code', () => {
    const { graph } = result();
    const invalidFiles = new Set([
      'strict.cjs',
      'local.cjs',
      'class.cjs',
      'class-field.cjs',
      'class-heritage.cjs',
      'module.mjs',
      'typescript.cts',
    ]);
    expect(
      graph.nodes.filter(
        (node) => node.label === 'Method' && invalidFiles.has(node.properties.filePath),
      ),
    ).toEqual([]);
    expect(graph.getNode('Method:modern.mjs:Modern.63#1')?.properties.parameterCount).toBe(1);
    const calls = [...graph.iterRelationshipsByType('CALLS')].filter(
      (edge) => edge.targetId === 'Method:strict-call.cjs:obj.63#0',
    );
    expect(calls.map((edge) => edge.sourceId)).toEqual(['Function:strict-call.cjs:modernValid']);
  });
});
