/**
 * Unit coverage for the TS↔JS `collectScopeContextPaths` helper (#4252).
 */
import { describe, it, expect } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { collectEcmaScopeContextPaths } from '../../src/core/ingestion/languages/typescript/collect-ecma-scope-context.js';

function mkParsed(filePath: string, targets: string[]): ParsedFile {
  return {
    filePath,
    language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
    definitions: [],
    calls: [],
    parsedImports: targets.map((targetRaw) => ({
      kind: 'named' as const,
      localName: 'x',
      importedName: 'x',
      targetRaw,
    })),
  } as unknown as ParsedFile;
}

describe('collectEcmaScopeContextPaths (#4252)', () => {
  it('pulls a sibling-language target into the visited set', () => {
    const primary = 'app/t.ts';
    const sibling = 'jslib/a.js';
    const visited = collectEcmaScopeContextPaths({
      primaryFilePaths: [primary],
      preExtractedByPath: new Map([[primary, mkParsed(primary, ['./a'])]]),
      entryFileContents: new Map(),
      allScannedPaths: new Set([primary, sibling]),
      resolutionConfig: undefined,
      resolveImportTarget: (targetRaw) => (targetRaw === './a' ? sibling : null),
    });
    expect(visited.has(primary)).toBe(true);
    expect(visited.has(sibling)).toBe(true);
  });

  it('skips imports whose resolved path is not scanned', () => {
    const primary = 'app/t.ts';
    const visited = collectEcmaScopeContextPaths({
      primaryFilePaths: [primary],
      preExtractedByPath: new Map([[primary, mkParsed(primary, ['./missing'])]]),
      entryFileContents: new Map(),
      allScannedPaths: new Set([primary]),
      resolutionConfig: undefined,
      resolveImportTarget: () => 'elsewhere/missing.js',
    });
    expect([...visited]).toEqual([primary]);
  });

  it('does not re-queue already visited paths (cycle-safe)', () => {
    const a = 'a.ts';
    const b = 'b.js';
    let resolveCalls = 0;
    const visited = collectEcmaScopeContextPaths({
      primaryFilePaths: [a],
      preExtractedByPath: new Map([
        [a, mkParsed(a, ['./b'])],
        [b, mkParsed(b, ['./a'])],
      ]),
      entryFileContents: new Map(),
      allScannedPaths: new Set([a, b]),
      resolutionConfig: undefined,
      resolveImportTarget: (targetRaw) => {
        resolveCalls += 1;
        if (targetRaw === './b') return b;
        if (targetRaw === './a') return a;
        return null;
      },
    });
    expect(visited.has(a)).toBe(true);
    expect(visited.has(b)).toBe(true);
    expect(resolveCalls).toBe(2);
  });

  it('skips a queued context file when neither ParsedFile nor source is available', () => {
    const primary = 'app/t.ts';
    const mid = 'facade.js';
    const deep = 'util.ts';
    const visited = collectEcmaScopeContextPaths({
      primaryFilePaths: [primary],
      preExtractedByPath: new Map([[primary, mkParsed(primary, ['./facade'])]]),
      entryFileContents: new Map(),
      allScannedPaths: new Set([primary, mid, deep]),
      resolutionConfig: undefined,
      resolveImportTarget: (targetRaw, fromFile) => {
        if (fromFile === primary && targetRaw === './facade') return mid;
        if (fromFile === mid && targetRaw === './util') return deep;
        return null;
      },
    });
    // One-hop: mid is discovered from primary, but without mid's ParsedFile/source
    // the BFS cannot discover deep (same limitation as Vue's hook + phase.ts).
    expect(visited.has(mid)).toBe(true);
    expect(visited.has(deep)).toBe(false);
  });
});
