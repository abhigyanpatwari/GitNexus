import { describe, expect, it } from 'vitest';
import { buildScopeTree, finalize, type FinalizeHooks, type ParsedFile } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { emitImportEdges } from '../../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { rustProvider } from '../../../src/core/ingestion/languages/rust.js';
import { rustIsGlobalNameFallbackPlausible } from '../../../src/core/ingestion/languages/rust/name-fallback-visibility.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  persistParsedFileChunk,
  loadParsedFilesForPaths,
} from '../../../src/storage/parsedfile-store.js';

function extract(source: string, filePath = 'src/caller.rs'): ParsedFile {
  const parsed = extractParsedFile(rustProvider, source, filePath);
  if (parsed === undefined) throw new Error(`Failed extraction: ${filePath}`);
  return parsed;
}

const source = `
mod importing {
    use crate::target::helper;
    pub fn allowed() { helper(); }
}
mod sibling {
    pub fn denied() { helper(); }
}
`;

function link(parsed: ParsedFile, lexical = true) {
  const target = extract('pub fn helper() {}', 'src/target.rs');
  const hooks: FinalizeHooks = {
    resolveImportTarget: (raw: string) =>
      raw.startsWith('crate::target') ? target.filePath : null,
    expandsWildcardTo: () => ['helper'],
    mergeBindings: (existing, incoming) => [...existing, ...incoming],
    importsBindAtLexicalScope: lexical,
  };
  return { target, out: finalize({ files: [parsed, target], workspaceIndex: undefined }, hooks) };
}

describe('import lexical provenance', () => {
  it('keeps file dependency edges when import binding moves into a local scope', () => {
    const parsed = extract(source);
    const { target, out } = link(parsed);
    const graph = createKnowledgeGraph();
    emitImportEdges(
      graph,
      out.imports,
      buildScopeTree([...parsed.scopes, ...target.scopes]),
      'scope import',
    );
    const dependencies = graph.relationships.filter((edge) => edge.type === 'IMPORTS');
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0]!.sourceId).toBe('File:src/caller.rs');
    expect(dependencies[0]!.targetId).toBe('File:src/target.rs');
  });

  it('does not promote a local wildcard into the importing file export closure', () => {
    const parsed = extract('mod inner { use crate::target::*; }');
    const target = extract('pub fn helper() {}', 'src/target.rs');
    const consumer = extract('use crate::caller::helper;', 'src/consumer.rs');
    const out = finalize(
      { files: [parsed, target, consumer], workspaceIndex: undefined },
      {
        importsBindAtLexicalScope: true,
        resolveImportTarget: (raw) =>
          raw.startsWith('crate::target') ? target.filePath : parsed.filePath,
        expandsWildcardTo: () => ['helper'],
        mergeBindings: (existing, incoming) => [...existing, ...incoming],
      },
    );
    expect(out.bindings.get(parsed.parsedImports[0]!.declaredAtScope!)?.has('helper')).toBe(true);
    expect(out.imports.get(consumer.moduleScope)?.[0]?.linkStatus).toBe('unresolved');
    expect(out.bindings.get(consumer.moduleScope)?.has('helper')).toBe(false);
  });

  it('survives the worker/disk ParsedFile round-trip', async () => {
    const parsed = extract(source);
    const dir = await mkdtemp(path.join(tmpdir(), 'gn-import-provenance-'));
    try {
      await persistParsedFileChunk(dir, 'imports', [parsed]);
      const loaded = await loadParsedFilesForPaths(dir, new Set([parsed.filePath]));
      const restored = loaded.get(parsed.filePath)!;
      expect(restored.parsedImports).toEqual(parsed.parsedImports);
      const scopeId = restored.parsedImports[0]!.declaredAtScope!;
      expect(link(restored).out.bindings.get(scopeId)?.has('helper')).toBe(true);
      expect(link(restored).out.bindings.get(restored.moduleScope)?.has('helper')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('retains the declaration scope even for non-executing imports', () => {
    const parsed = extract(source);
    const imported = parsed.parsedImports[0]!;
    expect(imported.declaredAtScope).toBeDefined();
    expect(imported.declaredAtScope).not.toBe(parsed.moduleScope);
    expect(parsed.scopes.find((scope) => scope.id === imported.declaredAtScope)?.kind).toBe(
      'Namespace',
    );
    expect(imported.runsOnlyWhenCalled).toBeUndefined();
    expect(JSON.parse(JSON.stringify(imported)).declaredAtScope).toBe(imported.declaredAtScope);
  });

  it.each([
    'use crate::target::helper;',
    'use crate::target::helper as alias;',
    'use crate::target::*;',
  ])('binds %s only in the importing scope', (declaration) => {
    const parsed = extract(source.replace('use crate::target::helper;', declaration));
    const { out } = link(parsed);
    const scope = parsed.parsedImports[0]!.declaredAtScope!;
    const name = declaration.includes('alias') ? 'alias' : 'helper';
    expect(out.bindings.get(scope)?.get(name)?.[0]?.origin).toMatch(/import|wildcard/);
    expect(out.bindings.get(parsed.moduleScope)?.has(name)).toBe(false);
    expect(out.imports.get(scope)).toHaveLength(1);
    expect(out.stats.totalEdges).toBe(1);
    expect(out.stats.linkedEdges).toBe(1);
  });

  it('preserves file-level binding for resolvers that have not opted in', () => {
    const parsed = extract(source);
    expect(link(parsed, false).out.bindings.get(parsed.moduleScope)?.has('helper')).toBe(true);
  });

  it('preserves legacy imports without a scope receipt', () => {
    const parsed = extract(source);
    const legacy = {
      ...parsed,
      parsedImports: [
        {
          kind: 'named' as const,
          localName: 'helper',
          importedName: 'helper',
          targetRaw: 'crate::target::helper',
        },
      ],
    };
    expect(link(legacy).out.bindings.get(parsed.moduleScope)?.has('helper')).toBe(true);
  });

  it('does not use a sibling inline module import to authorize a guess', () => {
    const parsed = extract(source);
    const { target } = link(parsed);
    const sites = parsed.referenceSites.filter(
      (site) => site.kind === 'call' && site.name === 'helper',
    );
    expect(sites).toHaveLength(2);
    const candidate = target.localDefs.find((def) => def.qualifiedName === 'helper')!;
    expect(
      rustIsGlobalNameFallbackPlausible({ callerParsed: parsed, candidate, site: sites[0]! }),
    ).toBe(true);
    expect(
      rustIsGlobalNameFallbackPlausible({ callerParsed: parsed, candidate, site: sites[1]! }),
    ).toBe(false);
  });
});
