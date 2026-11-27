import { describe, expect, it, vi } from 'vitest';
import {
  createEagerImportVisibility,
  type ImportEdge,
  type ParsedFile,
  type ScopeId,
} from 'gitnexus-shared';
import { onDemandTargets } from '../../../src/core/ingestion/scope-resolution/graph-bridge/on-demand-targets.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const MODULE = 'module:App/View.swift' as ScopeId;
const importer = { filePath: 'App/View.swift', moduleScope: MODULE } as ParsedFile;
const edge = (kind: ImportEdge['kind'], targetFile: string): ImportEdge => ({
  kind,
  localName: 'Mod',
  targetExportedName: 'Mod',
  targetFile,
});
const NAMESPACE = new Set<ImportEdge['kind']>(['namespace']);
const indexesWith = (imports: ScopeResolutionIndexes['imports']) =>
  ({ imports }) as unknown as ScopeResolutionIndexes;

describe('onDemandTargets', () => {
  it('follows one hop among the candidates of the same import statement, and no further', () => {
    const at = (line: number) => ({ startLine: line, startCol: 0, endLine: line, endCol: 10 });
    const statement = (localName: string, line: number, targetFile: string): ImportEdge => ({
      ...edge('namespace', targetFile),
      localName,
      atRange: at(line),
    });
    const indexes = indexesWith(
      createEagerImportVisibility(
        new Map([
          [
            MODULE,
            [
              statement('Mod', 1, 'Mod/Alias.swift'),
              statement('Mod', 1, 'Mod/Target.swift'),
              statement('Mod', 1, 'Mod/Further.swift'),
              statement('Other', 2, 'Other/Elsewhere.swift'),
            ],
          ],
        ]),
      ),
    );
    const follow = vi.fn((kept: string) =>
      kept === 'Mod/Alias.swift'
        ? (candidate: string) => candidate !== 'Mod/Alias.swift'
        : kept === 'Mod/Target.swift'
          ? () => true
          : undefined,
    );
    const kept = onDemandTargets(
      importer,
      indexes,
      NAMESPACE,
      (file) => file === 'Mod/Alias.swift',
      follow,
    );
    // Alias.swift's predicate accepts every other file of its own statement,
    // not the other statement's; Target.swift, added by the hop, is not
    // followed again.
    expect([...kept].sort()).toEqual(['Mod/Alias.swift', 'Mod/Further.swift', 'Mod/Target.swift']);
    expect(follow.mock.calls.map(([file]) => file)).toEqual(['Mod/Alias.swift']);
  });

  it('walks the statements once when no kept target asks to be followed', () => {
    const forEachTarget = vi.fn(
      (scope: ScopeId, visit: (file: string, via: ImportEdge) => void) => {
        if (scope === MODULE) visit('Mod/A.swift', edge('namespace', 'Mod/A.swift'));
      },
    );
    const kept = onDemandTargets(
      importer,
      { imports: { forEachTarget } } as unknown as ScopeResolutionIndexes,
      NAMESPACE,
      () => true,
      () => undefined,
    );
    expect([...kept]).toEqual(['Mod/A.swift']);
    expect(forEachTarget).toHaveBeenCalledTimes(1);
  });

  it('keeps the targets the predicate selects, of the given kinds only', () => {
    const indexes = indexesWith(
      createEagerImportVisibility(
        new Map([
          [
            MODULE,
            [
              edge('namespace', 'Mod/A.swift'),
              edge('namespace', 'Mod/B.swift'),
              edge('named', 'Mod/C.swift'),
            ],
          ],
        ]),
      ),
    );
    expect(onDemandTargets(importer, indexes, NAMESPACE, (file) => file !== 'Mod/B.swift')).toEqual(
      new Set(['Mod/A.swift']),
    );
  });

});
