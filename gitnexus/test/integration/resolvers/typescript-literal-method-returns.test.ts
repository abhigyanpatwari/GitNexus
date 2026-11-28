import { describe, expect, it } from 'vitest';
import { emitTsScopeCaptures } from '../../../src/core/ingestion/languages/typescript/captures.js';
import { useFixture } from './helpers.js';

const owners = [
  'export class User { finish() {} }',
  'export class Other { finish() {} }',
  'export class Factory {',
  '  plain(): Other { return new Other(); }',
  String.raw`  'lo\u0061d'(): User { return new User(); }`,
  '  0x10(): User { return new User(); }',
  '  ["a.b"](): User { return new User(); }',
  '  [(`templ`)](): Other { return new Other(); }',
  '  [-1](): User { return new User(); }',
  '}',
  'export class Decoy { "load"(): Other { return new Other(); } }',
  'export interface Shape { ["read-item"](): User; }',
  'export abstract class Abstract { abstract "read-item"(): Other; }',
].join('\n');

describe('TypeScript literal method return types', () => {
  const result = useFixture(
    'ts-literal-method-returns',
    {
      'owners.ts': owners,
      'use.ts': [
        'import { Abstract, Decoy, Factory, Shape } from "./owners.js";',
        'export function plain(f: Factory) { f.plain().finish(); }',
        'export function dot(f: Factory) { f.load().finish(); }',
        'export function bracket(f: Factory) { f["load"]().finish(); }',
        'export function numeric(f: Factory) { f[16]().finish(); }',
        'export function dotted(f: Factory) { f["a.b"]().finish(); }',
        'export function template(f: Factory) { f.templ().finish(); }',
        'export function signed(f: Factory) { f[-1]().finish(); }',
        'export function assigned(f: Factory) { const user = f.load(); user.finish(); }',
        'export function decoy(f: Decoy) { f.load().finish(); }',
        'export function declared(f: Shape) { f["read-item"]().finish(); }',
        'export function abstract(f: Abstract) { f["read-item"]().finish(); }',
        'export function dynamicKey(f: any, key: string) { f[key]().finish(); }',
      ].join('\n'),
    },
    { skipDerivedGraphPhases: true, workerPoolSize: 1 },
  );

  it('emits one return annotation per declaration with the canonical member name', () => {
    const bindings = emitTsScopeCaptures(owners, 'owners.ts')
      .filter((capture) => capture['@type-binding.return'])
      .map((capture) => [capture['@type-binding.name'].text, capture['@type-binding.type'].text]);
    expect(bindings).toEqual([
      ['plain', 'Other'],
      ['load', 'User'],
      ['16', 'User'],
      ['a.b', 'User'],
      ['templ', 'Other'],
      ['-1', 'User'],
      ['load', 'Other'],
      ['read-item', 'User'],
      ['read-item', 'Other'],
    ]);
  });

  it('selects both the producing member and its declared result across files', () => {
    const { graph } = result();
    const calls = [...graph.iterRelationshipsByType('CALLS')].filter((edge) =>
      edge.sourceId.startsWith('Function:use.ts:'),
    );
    for (const [caller, producer, resultOwner] of [
      ['plain', 'Factory.plain', 'Other'],
      ['dot', 'Factory.load', 'User'],
      ['bracket', 'Factory.load', 'User'],
      ['numeric', 'Factory.16', 'User'],
      ['dotted', 'Factory.a.b', 'User'],
      ['template', 'Factory.templ', 'Other'],
      ['signed', 'Factory.-1', 'User'],
      ['assigned', 'Factory.load', 'User'],
      ['decoy', 'Decoy.load', 'Other'],
      ['declared', 'Shape.read-item', 'User'],
      ['abstract', 'Abstract.read-item', 'Other'],
    ]) {
      expect(
        calls
          .filter((edge) => edge.sourceId === `Function:use.ts:${caller}`)
          .map((edge) => edge.targetId)
          .sort(),
        caller,
      ).toEqual(
        [`Method:owners.ts:${producer}#0`, `Method:owners.ts:${resultOwner}.finish#0`].sort(),
      );
    }
    expect(calls.filter((edge) => edge.sourceId === 'Function:use.ts:dynamicKey')).toEqual([]);
  });
});
