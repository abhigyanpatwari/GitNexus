/**
 * U6 — `foldReceiverChain` types a receiver from decoded structure rather than
 * from its source text.
 *
 * The fold is called directly: U6 deliberately wires it into no resolution
 * path (that is U10), so there is no pipeline behaviour to assert yet.
 */

import { describe, it, expect } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';
import { foldReceiverChain } from '../../../src/core/ingestion/scope-resolution/passes/compound-receiver.js';
import { decodeReceiverChain } from '../../../src/core/ingestion/utils/receiver-chain-codec.js';

const SOURCE = `export class Address {
  save(): void {}
}

export class User {
  address: Address = new Address();
  save(): void {}
}

export class Base {
  inherited(): User {
    return new User();
  }
}

export class Service extends Base {
  getUser(): User {
    return new User();
  }
}

// A class with NO member \`save\`, whose FIELD's type has one. The field
// fallback finds \`save\` by walking in here; the fold must not.
export class Holder {
  user: User = new User();
}

const svc: Service = new Service();
const holder: Holder = new Holder();
`;

function build() {
  const parsed = extractParsedFile(typescriptScopeResolver.languageProvider, SOURCE, 'main.ts');
  if (parsed === undefined) throw new Error('scope extraction failed');
  typescriptScopeResolver.populateOwners(parsed);
  const parsedFiles: ParsedFile[] = [parsed];
  const allFilePaths = new Set(parsedFiles.map((p) => p.filePath));
  const scopes = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (targetRaw, fromFile) =>
        typescriptScopeResolver.resolveImportTarget(targetRaw, fromFile, allFilePaths),
      mergeBindings: (existing, incoming, scopeId) =>
        typescriptScopeResolver.mergeBindings(existing, incoming, scopeId),
    },
  });
  const index = buildWorkspaceResolutionIndex(parsedFiles);
  return { scopes, index, inScope: parsed.moduleScope };
}

const ctx = build();

/** Fold with the language contract flags overridden — used to exercise the
 *  OFF branch of `hoistTypeBindingsToModule`, which six wired languages
 *  (c, cobol, dart, python, ruby, swift) actually run. */
function foldWith(encoded: string, overrides: Record<string, unknown>) {
  const decoded = decodeReceiverChain(encoded);
  expect(decoded).toBeDefined();
  return foldReceiverChain(decoded!, ctx.inScope, ctx.scopes, ctx.index, {
    fieldFallback: false,
    hoistTypeBindingsToModule: true,
    ...overrides,
  });
}

function fold(encoded: string) {
  const decoded = decodeReceiverChain(encoded);
  expect(decoded).toBeDefined();
  // The language's own contract flags, exactly as the resolver pass would
  // pass them. TypeScript hoists method return-type bindings out of the class
  // body, so the fold needs that flag to find any of them.
  return foldReceiverChain(decoded!, ctx.inScope, ctx.scopes, ctx.index, {
    fieldFallback: false,
    hoistTypeBindingsToModule: true,
  });
}

describe('foldReceiverChain', () => {
  it('types a single call step through the method return type', () => {
    expect(fold('1|svc|cgetUser')).toMatchObject({ qualifiedName: 'User', type: 'Class' });
  });

  it('types a mixed call/field chain, base-first', () => {
    expect(fold('1|svc|cgetUser|faddress')).toMatchObject({
      qualifiedName: 'Address',
      type: 'Class',
    });
  });

  it('types a step inherited through the MRO', () => {
    expect(fold('1|svc|cinherited')).toMatchObject({ qualifiedName: 'User', type: 'Class' });
  });

  it('returns undefined when a step names no member of the previous class', () => {
    expect(fold('1|svc|cgetUser|fnoSuchField')).toBeUndefined();
  });

  it('returns undefined when the base does not resolve', () => {
    expect(fold('1|noSuchLocal|cgetUser')).toBeUndefined();
  });

  it('does not consult the field fallback', () => {
    // `Holder` has no member `save` — only its field's TYPE does. The field
    // fallback would walk Holder's fields, find `User.save` and answer: a
    // guess, at O(fields x depth x names) per step. The fold declines.
    expect(fold('1|holder|csave')).toBeUndefined();
  });

  it('declines a truncated chain even though the producer refuses to mint one', () => {
    expect(fold('1|svc|cgetUser|~')).toBeUndefined();
  });

  it('declines a construction-selector step and leaves it to the cascade', () => {
    // `Factory.new` denotes an INSTANCE of Factory, not the result of looking up
    // a member named `new`. The cascade encodes that, together with the
    // class-constant test that separates it from an instance method genuinely
    // named `new`; a chain step records only a name, so the fold cannot make the
    // distinction and must not try. Folding it turned a correct Ruby edge
    // (`Factory.new.run` → `Factory#run`) into a wrong one (`Product.run`).
    const decoded = decodeReceiverChain('1|svc|cnew');
    expect(decoded).toBeDefined();
    expect(
      foldReceiverChain(decoded!, ctx.inScope, ctx.scopes, ctx.index, {
        fieldFallback: false,
        hoistTypeBindingsToModule: true,
        constructionSyntax: { selector: 'new' },
      }),
    ).toBeUndefined();
  });

  it('does NOT climb to module scope when hoistTypeBindingsToModule is off', () => {
    // The flag exists because TypeScript hoists a method's return-type binding
    // OUT of the class body, so the fold must walk to Module scope to find it.
    // Languages that do NOT hoist must not get that walk — climbing anyway is
    // how an unrelated module-level binding of the same name gets picked up,
    // which is exactly what the flag's own contract warns against. Same chain,
    // opposite answers, so this pins the branch rather than the happy path.
    expect(foldWith('1|svc|cgetUser', { hoistTypeBindingsToModule: true })).toMatchObject({
      qualifiedName: 'User',
    });
    expect(foldWith('1|svc|cgetUser', { hoistTypeBindingsToModule: false })).toBeUndefined();
  });
});
