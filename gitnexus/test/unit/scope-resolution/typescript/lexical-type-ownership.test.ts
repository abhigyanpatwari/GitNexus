import { describe, expect, it } from 'vitest';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../../../src/core/ingestion/languages/typescript.js';
import { lookupLexicalName } from 'gitnexus-shared';

describe('lexical type fact ownership', () => {
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
