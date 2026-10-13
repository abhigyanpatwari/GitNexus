import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { SupportedLanguages } from 'gitnexus-shared';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';

const cases = [
  [SupportedLanguages.CSharp, 'csharp', 'Worker.cs', '@worker', 'Read'],
  [SupportedLanguages.Kotlin, 'kotlin', 'worker.kt', '`worker`', 'read'],
  [SupportedLanguages.Swift, 'swift', 'worker.swift', '`worker`', 'read'],
] as const;

describe('provider workspace identifier normalization', () => {
  it.each(cases)(
    'keeps %s source identities while aligning escaped receiver and type bindings',
    (language, directory, file, escapedReceiver, member) => {
      const resolver = SCOPE_RESOLVERS.get(language)!;
      const content = fs.readFileSync(
        new URL(
          `../fixtures/rename-integration/${directory}/escaped-receiver-identity/before/${file}`,
          import.meta.url,
        ),
        'utf8',
      );
      const parsed = extractParsedFile(resolver.languageProvider, content, file)!;
      expect(parsed).toBeDefined();
      resolver.populateOwners(parsed);
      const originalScopes = parsed.scopes.map((scope) => ({
        bindings: [...scope.bindings],
        typeBindings: [...scope.typeBindings],
      }));
      const originalReferences = structuredClone(parsed.referenceSites);
      const originalReceiver = parsed.referenceSites.find(
        (site) => site.name === member && site.explicitReceiver?.name === escapedReceiver,
      );
      expect(originalReceiver).toBeDefined();

      const workspace = [parsed];
      resolver.populateWorkspaceReferences!(workspace, {
        fileContents: new Map([[file, content]]),
      });
      const normalized = workspace[0];
      expect(normalized.localDefs).toBe(parsed.localDefs);
      expect(normalized.localDefs.map((def) => [def.nodeId, def.nameRange])).toEqual(
        parsed.localDefs.map((def) => [def.nodeId, def.nameRange]),
      );
      expect(normalized.referenceSites.find((site) => site.name === member)).toEqual({
        ...originalReceiver,
        explicitReceiver: { name: 'worker' },
      });
      const typeBindings = normalized.scopes.flatMap((scope) => [...scope.typeBindings]);
      expect(typeBindings).toContainEqual([
        'worker',
        expect.objectContaining({ rawName: 'Worker' }),
      ]);
      expect(typeBindings.some(([name]) => name === escapedReceiver)).toBe(false);
      expect(
        parsed.scopes.map((scope) => ({
          bindings: [...scope.bindings],
          typeBindings: [...scope.typeBindings],
        })),
      ).toEqual(originalScopes);
      expect(parsed.referenceSites).toEqual(originalReferences);
      const firstSites = normalized.referenceSites;
      resolver.populateWorkspaceReferences!(workspace, { fileContents: new Map() });
      workspace[0].referenceSites.forEach((site, index) => expect(site).toBe(firstSites[index]));
    },
  );
});

it.each([SupportedLanguages.TypeScript, SupportedLanguages.JavaScript])(
  'normalizes %s callable operands and preserves raw owner identities and spans',
  (language) => {
    const resolver = SCOPE_RESOLVERS.get(language)!;
    const source = String.raw`function calc\u0075late() { return 7; }
function invoke(c\u0062) { return c\u0062(); }
export function run() { const c\u0062 = calc\u0075late; const next = cb; return next(); }
export function throughParameter() { return invoke(calc\u0075late); }
`;
    const parsed = extractParsedFile(
      resolver.languageProvider,
      source,
      language === SupportedLanguages.TypeScript ? 'flow.ts' : 'flow.js',
    )!;
    const original = structuredClone(parsed.callableFlowSites);
    const workspace = [parsed];
    resolver.populateWorkspaceReferences!(workspace, { fileContents: new Map() });
    const normalized = workspace[0];
    expect(normalized.localDefs).toBe(parsed.localDefs);
    expect(parsed.callableFlowSites).toEqual(original);
    expect(normalized.callableFlowSites?.length).toBeGreaterThan(0);
    const operands = normalized.callableFlowSites!.flatMap((site) =>
      ['source', 'destination', 'binding', 'callee', 'receiver', 'pointer'].flatMap((key) =>
        key in site ? [site[key as keyof typeof site]] : [],
      ),
    );
    expect(operands).toContainEqual(expect.objectContaining({ name: 'calculate' }));
    expect(operands).toContainEqual(expect.objectContaining({ name: 'cb' }));
    expect(JSON.stringify(operands)).not.toContain('\\\\u');
    for (let index = 0; index < original!.length; index++) {
      const before = original![index];
      const after = normalized.callableFlowSites![index];
      if (before.kind === 'formal' && after.kind === 'formal') {
        expect(after.ownerName).toBe(before.ownerName);
        expect(after.ownerRange).toEqual(before.ownerRange);
      }
      for (const key of ['source', 'destination', 'binding', 'callee', 'receiver', 'pointer']) {
        if (key in before && key in after) {
          expect((after as unknown as Record<string, { atRange: unknown }>)[key].atRange).toEqual(
            (before as unknown as Record<string, { atRange: unknown }>)[key].atRange,
          );
        }
      }
    }
  },
);

it.each(cases)(
  'preserves raw %s member keys and canonicalizes only lexical receiver bases',
  (language, directory, file) => {
    const resolver = SCOPE_RESOLVERS.get(language)!;
    const content = fs.readFileSync(
      new URL(
        `../fixtures/rename-integration/${directory}/escaped-member-identity/before/${file}`,
        import.meta.url,
      ),
      'utf8',
    );
    const parsed = extractParsedFile(resolver.languageProvider, content, file)!;
    const member = parsed.referenceSites.find(
      (site) => site.kind === 'call' && site.explicitReceiver?.name.includes('worker'),
    )!;
    expect(member).toBeDefined();
    const chain = `2|${member.explicitReceiver!.name}|c${member.name}|i`;
    const withChain = { ...parsed, referenceSites: [{ ...member, receiverChain: chain }] };
    const workspace = [withChain];
    resolver.populateWorkspaceReferences!(workspace, { fileContents: new Map() });
    const normalized = workspace[0].referenceSites[0];
    expect(normalized.name).toBe(member.name);
    expect(normalized.explicitReceiver?.name).toBe('worker');
    expect(normalized.receiverChain).toBe(`2|worker|c${member.name}|i`);
    expect(normalized.atRange).toBe(member.atRange);
    expect(withChain.referenceSites[0].receiverChain).toBe(chain);
    resolver.populateWorkspaceReferences!(workspace, { fileContents: new Map() });
    expect(workspace[0].referenceSites[0]).toBe(normalized);
  },
);
