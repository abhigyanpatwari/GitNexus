import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [baseline, candidate] = process.argv.slice(2);
assert(baseline && candidate, 'Expected BASE_RUNTIME CANDIDATE_RUNTIME');
const moduleAt = (root) =>
  pathToFileURL(path.resolve(root, 'gitnexus/dist/_shared/scope-resolution/name-claims.js')).href;
const { lookupLexicalName: before } = await import(moduleAt(baseline));
const { lookupLexicalName: after } = await import(moduleAt(candidate));
let seed = 48161;
const random = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const pos = (n) => ({ startLine: n, startCol: 0 });
const range = (n) => ({ ...pos(n), endLine: n, endCol: 20 });
const names = ['a', 'b', 'missing'];
let comparisons = 0;
for (let trial = 0; trial < 3000; trial++) {
  const scopes = new Map();
  for (let i = 0; i < 5; i++) {
    const claims = [];
    const bindings = new Map();
    const types = new Map();
    const imports = [];
    for (const name of names.slice(0, 2)) {
      if (random(3) === 0)
        claims.push({
          name,
          kind: ['binding', 'import', 'blocked'][random(3)],
          range: range(2 + random(8)),
          purpose: ['value', 'type', 'both', undefined][random(4)],
          availableFrom: random(2) ? pos(2 + random(8)) : undefined,
          inactive: ['outer', 'blocked', 'module'][random(3)],
          redirect: random(8) === 0 ? 'module' : undefined,
          hoisted: random(2) === 0,
          merge: random(3) === 0,
        });
      if (random(2))
        bindings.set(name, [
          {
            def: { nodeId: `${i}:${name}`, type: 'Function', filePath: 'a.ts' },
            origin: random(2) ? 'local' : 'import',
            availableFrom: random(2) ? pos(5) : undefined,
            declarationRange: range(5),
          },
        ]);
      if (random(3) === 0)
        imports.push({
          kind: 'namespace',
          localName: name,
          targetFile: random(2) ? 'b.ts' : null,
          targetExportedName: '',
          atRange: range(4),
          linkStatus: random(2) ? 'resolved' : 'unresolved',
        });
      if (random(3) === 0)
        types.set(name, {
          rawName: 'Value',
          source: [
            'annotation',
            'constructor-inferred',
            'assignment-inferred',
            'receiver-propagated',
          ][random(4)],
          declaredAtScope: String(i),
          bindingRange: random(2) ? range(5) : undefined,
        });
    }
    scopes.set(String(i), {
      id: String(i),
      parent: i === 0 ? null : String(i - 1),
      kind: i === 0 ? 'Module' : ['Function', 'Block', 'Class', 'Object'][random(4)],
      filePath: 'a.ts',
      range: range(i),
      bindings,
      imports,
      ownedDefs: [],
      typeBindings: types,
      nameClaims: claims,
      lexicalNames: random(3) === 0 ? new Set(['a']) : undefined,
      ownsReceivers: random(3) === 0 ? new Set(['b']) : undefined,
      lookupPolicy: {
        nameClaimsComplete: random(2) === 0,
        deferParentActivation: random(2) === 0,
        skipFromChildren: random(4) === 0,
      },
    });
  }
  if (trial % 20 === 0) scopes.get('0').parent = '4';
  const sources = { scopes: { getScope: (id) => scopes.get(id) } };
  for (const name of names)
    for (const purpose of ['value', 'type'])
      for (const position of [undefined, pos(1), pos(6), pos(12)]) {
        const options = Object.freeze({
          purpose,
          position,
          skipEnclosingClasses: trial % 2 === 0,
          preservePosition: trial % 3 === 0,
        });
        assert.deepEqual(
          after('4', name, sources, options),
          before('4', name, sources, options),
          `Trial ${trial}, ${name}, ${purpose}, line ${position?.startLine}`,
        );
        comparisons++;
      }
}
console.log({ comparisons, status: 'passed' });
