import { describe, expect, it } from 'vitest';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../../../src/core/ingestion/languages/typescript.js';
import { lookupLexicalName } from 'gitnexus-shared';

describe('lexical type fact ownership', () => {
  describe.each([
    { provider: typescriptProvider, extension: 'ts' },
    { provider: javascriptProvider, extension: 'js' },
  ])('$extension inferred writes', ({ provider, extension }) => {
    it.each([
      {
        shape: 'an unresolved assignment',
        source: 'function f(a) { const swap = () => { a = evil; a.m(); }; }',
        inferred: undefined,
      },
      {
        shape: 'a chained constructor assignment',
        source:
          'const evil = new Map(); function f(a) { const swap = () => { a = evil; a.m(); }; }',
        inferred: 'Map',
      },
      {
        shape: 'a direct constructor assignment',
        source: 'function f(a) { const swap = () => { a = new Foo(); a.m(); }; }',
        inferred: 'Foo',
      },
      {
        shape: 'a module binding assignment',
        source: 'let a; const swap = () => { a = new Map(); a.m(); };',
        inferred: 'Map',
      },
    ])('resolves $shape to its declaration', ({ source, inferred }) => {
      const parsed = extractParsedFile(provider, source, `app.${extension}`)!;
      const site = parsed.referenceSites.find((entry) => entry.name === 'm')!;
      const owner = parsed.scopes.find((entry) =>
        entry.nameClaims?.some((claim) => claim.name === 'a'),
      )!;
      const selected = lookupLexicalName(
        site.inScope,
        'a',
        { scopes: { getScope: (id) => parsed.scopes.find((entry) => entry.id === id) } },
        { position: site.atRange, purpose: 'value' },
      );
      expect(selected.scope).toBe(owner);
      expect(selected.typeBinding?.rawName).toBe(inferred);
    });

    it('does not promote a closure write into an outer receiver fact', () => {
      const parsed = extractParsedFile(
        provider,
        'function f(a) { const swap = () => { a = new Foo(); }; a.m(); }',
        `app.${extension}`,
      )!;
      const site = parsed.referenceSites.find((entry) => entry.name === 'm')!;
      const selected = lookupLexicalName(
        site.inScope,
        'a',
        { scopes: { getScope: (id) => parsed.scopes.find((entry) => entry.id === id) } },
        { position: site.atRange, purpose: 'value' },
      );
      expect(selected.scope?.id).toBe(site.inScope);
      expect(selected.typeBinding).toBeUndefined();
    });
  });

  it.each([
    { provider: typescriptProvider, extension: 'ts', declaration: 'function f(a: Base)' },
    {
      provider: javascriptProvider,
      extension: 'js',
      declaration: '/** @param {Base} a */ function f(a)',
    },
  ])(
    'preserves the $extension declared receiver type across a closure write',
    ({ provider, extension, declaration }) => {
      const parsed = extractParsedFile(
        provider,
        `${declaration} { const swap = () => { a = new Foo(); a.inner(); }; a.outer(); }`,
        `app.${extension}`,
      )!;
      const owner = parsed.scopes.find((entry) =>
        entry.nameClaims?.some((claim) => claim.name === 'a'),
      )!;
      const declared = owner.typeBindings.get('a');
      expect(declared).toMatchObject({
        rawName: 'Base',
        source: 'parameter-annotation',
        lookupPurpose: 'type',
      });
      for (const name of ['inner', 'outer']) {
        const site = parsed.referenceSites.find((entry) => entry.name === name)!;
        const selected = lookupLexicalName(
          site.inScope,
          'a',
          { scopes: { getScope: (id) => parsed.scopes.find((entry) => entry.id === id) } },
          { position: site.atRange, purpose: 'value' },
        );
        expect(selected.scope).toBe(owner);
        expect(selected.typeBinding).toBe(declared);
      }
    },
  );

  it('keeps JSDoc parameter types in their declaring functions', () => {
    const parsed = extractParsedFile(
      javascriptProvider,
      `
/** @param {User} value */
function first(value) { value.save(); }
/** @param {Repo} value */
function second(value) { value.save(); }
`,
      'app.js',
    )!;
    const functions = parsed.scopes.filter((scope) => scope.kind === 'Function');
    expect(functions.map((scope) => scope.typeBindings.get('value')?.rawName)).toEqual([
      'User',
      'Repo',
    ]);
    expect(
      functions.every((scope) => scope.nameClaims?.some((claim) => claim.name === 'value')),
    ).toBe(true);
    expect(parsed.scopes.find((scope) => scope.kind === 'Module')!.typeBindings.has('value')).toBe(
      false,
    );
  });

  it.each([
    { provider: typescriptProvider, extension: 'ts', parameter: 'users: User[]' },
    { provider: javascriptProvider, extension: 'js', parameter: 'users' },
  ])(
    'keeps $extension loop element facts beside their lexical claims',
    ({ provider, extension, parameter }) => {
      const parsed = extractParsedFile(
        provider,
        `
function visit(${parameter}) {
  for (const user of users) { user.save(); }
}
`,
        `app.${extension}`,
      )!;
      const loop = parsed.scopes.find((scope) =>
        scope.nameClaims?.some((claim) => claim.name === 'user'),
      )!;
      expect(loop.kind).toBe('Block');
      expect(loop.typeBindings.has('user')).toBe(true);
      expect(
        parsed.scopes
          .filter((scope) => scope.id !== loop.id)
          .some((scope) => scope.typeBindings.has('user')),
      ).toBe(false);
    },
  );

  it.each([
    { provider: typescriptProvider, extension: 'ts', field: 'users: User[];' },
    { provider: javascriptProvider, extension: 'js', field: 'users = [];' },
  ])(
    'preserves $extension explicit member access in a loop element type',
    ({ provider, extension, field }) => {
      const parsed = extractParsedFile(
        provider,
        `
class Service {
  ${field}
  visit() { for (const user of this.users) { user.save(); } }
}
`,
        `app.${extension}`,
      )!;
      const loop = parsed.scopes.find((scope) =>
        scope.nameClaims?.some((claim) => claim.name === 'user'),
      )!;
      expect(loop.typeBindings.get('user')?.rawName).toBe('this.users');
    },
  );

  it('marks an exported ambient class without exporting ambient module members', () => {
    const parsed = extractParsedFile(
      typescriptProvider,
      `
export declare class AmbientBase { method(): string; }
declare module 'external' { export class Nested { method(): string; } }
export namespace Container { export class Inside {} }
`,
      'ambient.ts',
    )!;
    const verdicts = new Map(
      parsed.localDefs
        .filter((def) => def.type === 'Class')
        .map((def) => [def.qualifiedName, def.isExported]),
    );
    expect(verdicts.get('AmbientBase')).toBe(true);
    expect(verdicts.get('Nested')).toBe(false);
    expect(verdicts.get('Inside')).toBe(false);
  });

  it.each([
    {
      provider: javascriptProvider,
      extension: 'js',
      declaration: 'local',
      source: 'const LIMIT = 3; function read() { return LIMIT; }',
    },
    {
      provider: javascriptProvider,
      extension: 'js',
      declaration: 'exported',
      source: 'export const LIMIT = 3; function read() { return LIMIT; }',
    },
    {
      provider: typescriptProvider,
      extension: 'ts',
      declaration: 'namespace',
      source:
        'export namespace Limits { export const LIMIT = 3; export function read() { return LIMIT; } }',
    },
  ])(
    'selects the exact $extension $declaration value declaration through its lexical claim',
    ({ provider, extension, source }) => {
      const parsed = extractParsedFile(provider, source, `app.${extension}`)!;
      const site = parsed.referenceSites.find(
        (site) => site.name === 'LIMIT' && site.kind === 'read',
      )!;
      const selected = lookupLexicalName(
        site.inScope,
        'LIMIT',
        {
          scopes: { getScope: (id) => parsed.scopes.find((scope) => scope.id === id) },
        },
        { position: site.atRange, purpose: 'value' },
      );
      expect(selected.status).toBe('resolved');
      expect(selected.bindings.some((binding) => binding.def.qualifiedName === 'LIMIT')).toBe(true);
    },
  );
});
