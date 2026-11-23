/** Repeat independent ES module graphs while keeping their target identities distinct. */
export function addModuleFixtures(sources, expectTargets, units, batches) {
  for (const [prefix, extension] of [
    ['ts', 'ts'],
    ['js', 'mjs'],
  ]) {
    for (let unit = 0; unit < units; unit++) {
      const file = (role) => `${prefix}${unit}-${role}.${extension}`;
      const specifier = (role) => `./${prefix}${unit}-${role}.${prefix === 'ts' ? 'js' : 'mjs'}`;
      const from = (role) => `from '${specifier(role)}';`;
      const left = [
        'export default function localDefault() {}',
        'export { localDefault as publicDefault };',
      ];
      const right = [];
      const forward = [];
      const overrides = [`export * ${from('ambiguous')}`];
      const namespaces = [`export * as operations ${from('left')}`, `export * ${from('left')}`];
      const imports = [
        `import { operations } ${from('namespace')}`,
        `import * as pack ${from('namespace')}`,
      ];
      const callers = [];
      const moduleCase = (caller, body, targets, role = 'entry') => {
        const targetFile = role === 'namespace' ? namespaces : callers;
        targetFile.push(`export function ${caller}${body}`);
        expectTargets(`Function:${file(role)}:${caller}`, `${prefix}Modules`, targets);
      };
      if (prefix === 'ts') {
        sources.set(file('types'), `export type * ${from('left')}`);
        sources.set(file('type-namespace'), `export type * as erased ${from('left')}`);
        imports.push(`import { erased } ${from('type-namespace')}`);
      }
      for (let batch = 0; batch < batches; batch++) {
        const name = `publish${batch}`;
        const hidden = `hidden${unit}_${batch}`;
        const localName = `localOnly${batch}`;
        const publicName = `publicAlias${batch}`;
        const quotedName = `quoted-${batch}`;
        const forwardedQuoted = `quoted export ${batch}`;
        const wildcardName = `${prefix}Wildcard${unit}_${batch}`;
        const entity = `Entity${batch}`;
        const leftOwner = `Function:${file('left')}:${name}`;
        const rightOwner = `Function:${file('right')}:${name}`;
        left.push(
          `export function ${name}() {}`,
          `function ${hidden}() {}`,
          `function ${localName}() {}`,
          `export { ${localName} as ${publicName} };`,
          `export { ${localName} as '${quotedName}' };`,
          `export function ${wildcardName}() {}`,
        );
        right.push(`export function ${name}() {}`);
        forward.push(`export { ${name} } ${from('left')}`);
        forward.push(`export { '${quotedName}' as "${forwardedQuoted}" } ${from('left')}`);
        overrides.push(`export { ${name} } ${from('right')}`);
        imports.push(
          `import { ${name} as conflict${batch} } ${from('ambiguous')}`,
          `import { ${name} as sameOwner${batch} } ${from('diamond')}`,
          `import { ${name} as explicitOwner${batch} } ${from('override')}`,
          `import { '${forwardedQuoted}' as quoted${batch} } ${from('forward')}`,
        );
        moduleCase(`ambiguous${batch}`, `() { conflict${batch}(); }`, []);
        moduleCase(`diamond${batch}`, `() { sameOwner${batch}(); }`, [leftOwner]);
        moduleCase(`explicit${batch}`, `() { explicitOwner${batch}(); }`, [rightOwner]);
        moduleCase(`viaNamespace${batch}`, `() { operations.${name}(); }`, [leftOwner]);
        moduleCase(`viaNested${batch}`, `() { pack.operations.${name}(); }`, [leftOwner]);
        moduleCase(`default${batch}`, '() { operations.default(); }', [
          `Function:${file('left')}:localDefault`,
        ]);
        moduleCase(`privateDefault${batch}`, '() { operations.localDefault(); }', []);
        moduleCase(`aliasDefault${batch}`, '() { operations.publicDefault(); }', [
          `Function:${file('left')}:localDefault`,
        ]);
        moduleCase(`aliasLocal${batch}`, `() { pack.${publicName}(); }`, [
          `Function:${file('left')}:${localName}`,
        ]);
        moduleCase(`privateLocal${batch}`, `() { pack.${localName}(); }`, []);
        moduleCase(`quotedAlias${batch}`, `() { quoted${batch}(); }`, [
          `Function:${file('left')}:${localName}`,
        ]);
        moduleCase(`unboundStar${batch}`, `() { ${wildcardName}(); }`, [], 'namespace');
        moduleCase(`hidden${batch}`, `() { operations.${hidden}(); }`, []);
        moduleCase(`unbound${batch}`, `() { operations.${name}(); }`, [], 'namespace');
        if (prefix === 'ts') {
          left.push(`export class ${entity} { touch() {} }`);
          right.push(`export class ${entity} { touch() {} }`);
          imports.push(`import { ${name} as erasedCall${batch} } ${from('types')}`);
          const touch = [`Method:${file('left')}:${entity}.touch#0`];
          moduleCase(
            `typed${batch}`,
            `(value: pack.operations.${entity}) { value.touch(); }`,
            touch,
          );
          moduleCase(`typeOnly${batch}`, `(value: erased.${entity}) { value.touch(); }`, touch);
          moduleCase(`erasedStar${batch}`, `() { erasedCall${batch}(); }`, []);
          moduleCase(`erasedNamespace${batch}`, `() { erased.${name}(); }`, []);
        }
      }
      sources.set(file('left'), left.join('\n'));
      sources.set(file('right'), right.join('\n'));
      sources.set(file('forward'), forward.join('\n'));
      sources.set(file('override'), overrides.join('\n'));
      sources.set(file('namespace'), namespaces.join('\n'));
      sources.set(file('entry'), [...imports, ...callers].join('\n'));
      sources.set(file('ambiguous'), `export * ${from('forward')}\nexport * ${from('right')}`);
      sources.set(file('diamond'), `export * ${from('forward')}\nexport * ${from('left')}`);
    }
  }
}

/** An edit to a barrel must change its importer's call without reparsing it. */
export const barrelEdit = {
  file: 'ts0-override.ts',
  from: "export { publish0 } from './ts0-right.js';",
  to: "export { publish0 } from './ts0-left.js';",
  caller: 'Function:ts0-entry.ts:explicit0',
  target: 'Function:ts0-left.ts:publish0',
};
