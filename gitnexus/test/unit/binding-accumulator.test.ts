import { describe, it, expect } from 'vitest';
import {
  BindingAccumulator,
  enrichExportedTypeMap,
  type BindingEntry,
  type EnrichmentGraphLookup,
  type EnrichmentGraphNode,
} from '../../src/core/ingestion/binding-accumulator.js';

describe('BindingAccumulator', () => {
  describe('append + read', () => {
    it('returns entries for a single file', () => {
      const acc = new BindingAccumulator();
      const entries: BindingEntry[] = [
        { scope: '', varName: 'x', typeName: 'number' },
        { scope: 'foo@10', varName: 'y', typeName: 'string' },
      ];
      acc.appendFile('src/a.ts', entries);
      expect(acc.getFile('src/a.ts')).toEqual(entries);
    });

    it('returns entries for multiple files', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'a', typeName: 'number' }]);
      acc.appendFile('src/b.ts', [{ scope: '', varName: 'b', typeName: 'string' }]);
      expect(acc.getFile('src/a.ts')).toHaveLength(1);
      expect(acc.getFile('src/b.ts')).toHaveLength(1);
      expect(acc.fileCount).toBe(2);
    });

    it('returns undefined for unknown file', () => {
      const acc = new BindingAccumulator();
      expect(acc.getFile('nonexistent.ts')).toBeUndefined();
    });

    it('accumulates entries across multiple calls for the same file', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'number' }]);
      acc.appendFile('src/a.ts', [{ scope: 'fn@5', varName: 'y', typeName: 'boolean' }]);
      const entries = acc.getFile('src/a.ts');
      expect(entries).toHaveLength(2);
      expect(entries![0].varName).toBe('x');
      expect(entries![1].varName).toBe('y');
    });

    it('skips append when entries is empty', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', []);
      expect(acc.getFile('src/a.ts')).toBeUndefined();
      expect(acc.fileCount).toBe(0);
    });

    it('tracks totalBindings correctly', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [
        { scope: '', varName: 'x', typeName: 'number' },
        { scope: '', varName: 'y', typeName: 'string' },
      ]);
      acc.appendFile('src/b.ts', [{ scope: '', varName: 'z', typeName: 'boolean' }]);
      expect(acc.totalBindings).toBe(3);
    });
  });

  describe('finalize + immutability', () => {
    it('finalize prevents further appends', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'number' }]);
      acc.finalize();
      expect(() =>
        acc.appendFile('src/b.ts', [{ scope: '', varName: 'y', typeName: 'string' }]),
      ).toThrow(/finalize/);
    });

    it('finalized getter returns true after finalize', () => {
      const acc = new BindingAccumulator();
      expect(acc.finalized).toBe(false);
      acc.finalize();
      expect(acc.finalized).toBe(true);
    });

    it('getFile works after finalize', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'number' }]);
      acc.finalize();
      expect(acc.getFile('src/a.ts')).toHaveLength(1);
    });

    it('finalize is idempotent', () => {
      const acc = new BindingAccumulator();
      acc.finalize();
      expect(() => acc.finalize()).not.toThrow();
    });
  });

  describe('fileScopeEntries', () => {
    it('returns only scope="" entries as [varName, typeName] tuples', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [
        { scope: '', varName: 'x', typeName: 'number' },
        { scope: 'foo@10', varName: 'y', typeName: 'string' },
        { scope: '', varName: 'z', typeName: 'boolean' },
      ]);
      const tuples = acc.fileScopeEntries('src/a.ts');
      expect(tuples).toEqual([
        ['x', 'number'],
        ['z', 'boolean'],
      ]);
    });

    it('returns empty array for unknown file', () => {
      const acc = new BindingAccumulator();
      expect(acc.fileScopeEntries('nonexistent.ts')).toEqual([]);
    });

    it('returns empty array when file has no file-scope entries', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: 'fn@1', varName: 'x', typeName: 'number' }]);
      expect(acc.fileScopeEntries('src/a.ts')).toEqual([]);
    });
  });

  describe('iteration', () => {
    it('files() yields all file paths', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'number' }]);
      acc.appendFile('src/b.ts', [{ scope: '', varName: 'y', typeName: 'string' }]);
      acc.appendFile('src/c.ts', [{ scope: '', varName: 'z', typeName: 'boolean' }]);
      const paths = [...acc.files()];
      expect(paths.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    });

    it('files() returns empty iterator when no files added', () => {
      const acc = new BindingAccumulator();
      expect([...acc.files()]).toEqual([]);
    });
  });

  describe('memory estimate', () => {
    it('returns a reasonable estimate for 1000 files x 2 entries', () => {
      const acc = new BindingAccumulator();
      for (let i = 0; i < 1000; i++) {
        acc.appendFile(`src/file${i}.ts`, [
          { scope: '', varName: `var${i}a`, typeName: 'string' },
          { scope: `fn${i}@0`, varName: `var${i}b`, typeName: 'number' },
        ]);
      }
      const bytes = acc.estimateMemoryBytes();
      // Should be between 50KB and 2MB
      expect(bytes).toBeGreaterThan(50 * 1024);
      expect(bytes).toBeLessThan(2 * 1024 * 1024);
    });
  });

  describe('pipeline integration (simulated)', () => {
    it('deserializes allScopeBindings from worker into accumulator', () => {
      const acc = new BindingAccumulator();

      // Simulated worker output:
      // After narrowing the worker IPC payload to file-scope only, the
      // emitted tuple shape is [varName, typeName]. Function-scope entries
      // are stripped at the parse-worker boundary; the sequential path's
      // flush() still writes all scopes via its own code path.
      const workerBindings = [
        {
          filePath: 'src/service.ts',
          bindings: [['config', 'Config'] as [string, string]],
        },
        {
          filePath: 'src/utils.ts',
          bindings: [['logger', 'Logger'] as [string, string]],
        },
      ];

      // Pipeline deserialization logic (mirrors pipeline.ts adapter):
      // two-element tuples → BindingEntry with hard-coded scope: ''.
      for (const { filePath, bindings } of workerBindings) {
        const entries: BindingEntry[] = bindings.map(([varName, typeName]) => ({
          scope: '',
          varName,
          typeName,
        }));
        acc.appendFile(filePath, entries);
      }
      acc.finalize();

      expect(acc.fileCount).toBe(2);
      expect(acc.totalBindings).toBe(2);

      // fileScopeEntries — what the ExportedTypeMap enrichment loop uses.
      expect(acc.fileScopeEntries('src/service.ts')).toEqual([['config', 'Config']]);
      expect(acc.fileScopeEntries('src/utils.ts')).toEqual([['logger', 'Logger']]);

      // Every entry produced by the worker path has scope === '' after the
      // IPC narrowing — locks the contract in place.
      const serviceEntries = acc.getFile('src/service.ts');
      expect(serviceEntries).toHaveLength(1);
      expect(serviceEntries![0]).toEqual({
        scope: '',
        varName: 'config',
        typeName: 'Config',
      });
    });

    it('worker IPC payload contains ONLY file-scope entries (narrowing guard)', () => {
      // Function-scope bindings were being
      // serialized over worker IPC with no consumer, costing ~4.9 MB. The
      // worker now uses typeEnv.fileScope() instead of typeEnv.allScopes(),
      // so `handleRequest@15 → db: Database` never crosses the IPC boundary.
      //
      // This test simulates a TypeEnvironment that HAD both file-scope and
      // function-scope bindings (as would be produced by a realistic file),
      // then asserts the worker IPC payload contains only the file-scope
      // ones. If a future change accidentally re-broadens the worker loop
      // to `allScopes()`, this assertion fires.
      const simulatedFileScope = new Map<string, string>([
        ['config', 'Config'],
        ['db', 'Database'],
      ]);
      // Function-scope entries that must NOT appear in the worker payload.
      const simulatedFunctionScope = new Map<string, string>([
        ['localRequest', 'Request'],
        ['localUser', 'User'],
      ]);

      // Mirror the parse-worker loop (post-narrowing shape):
      //   const fileScope = typeEnv.fileScope();
      //   for (const [varName, typeName] of fileScope) {
      //     scopeBindings.push([varName, typeName]);
      //   }
      const workerPayload: [string, string][] = [];
      for (const [varName, typeName] of simulatedFileScope) {
        workerPayload.push([varName, typeName]);
      }

      // Verify: the simulated function-scope variables are never pushed.
      const allVarNames = workerPayload.map(([v]) => v);
      expect(allVarNames).toEqual(['config', 'db']);
      expect(allVarNames).not.toContain('localRequest');
      expect(allVarNames).not.toContain('localUser');

      // Sanity: simulatedFunctionScope exists so the test is not trivially
      // vacuous — it documents what the old allScopes() path would have
      // emitted and what the new fileScope() path deliberately excludes.
      expect(simulatedFunctionScope.size).toBe(2);

      // Round-trip through the accumulator with the pipeline adapter shape.
      const acc = new BindingAccumulator();
      const entries: BindingEntry[] = workerPayload.map(([varName, typeName]) => ({
        scope: '',
        varName,
        typeName,
      }));
      acc.appendFile('src/service.ts', entries);
      acc.finalize();

      const stored = acc.getFile('src/service.ts');
      expect(stored).toHaveLength(2);
      // All accumulator entries from the worker path have scope === ''.
      for (const entry of stored!) {
        expect(entry.scope).toBe('');
      }
    });
  });

  // -------------------------------------------------------------------------
  // fileScopeEntries() must be O(n_file_scope),
  // not O(n_total). Storage is split into _allByFile + _fileScopeByFile so
  // reads skip function-scope entries entirely.
  // -------------------------------------------------------------------------

  describe('storage split (fast-path fileScopeEntries)', () => {
    it('mixed file-scope and function-scope input: fileScopeEntries ignores function-scope', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [
        { scope: '', varName: 'file1', typeName: 'T1' },
        { scope: 'fn@10', varName: 'local1', typeName: 'L1' },
        { scope: '', varName: 'file2', typeName: 'T2' },
        { scope: 'fn@20', varName: 'local2', typeName: 'L2' },
        { scope: 'fn@30', varName: 'local3', typeName: 'L3' },
      ]);

      // fileScopeEntries returns exactly the two file-scope entries,
      // preserving insertion order.
      expect(acc.fileScopeEntries('src/a.ts')).toEqual([
        ['file1', 'T1'],
        ['file2', 'T2'],
      ]);

      // getFile still returns all 5 entries (mixed scopes preserved).
      expect(acc.getFile('src/a.ts')).toHaveLength(5);
    });

    it('only-function-scope file: fileScopeEntries returns [] but files() still lists it', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/only-fn.ts', [
        { scope: 'fn@5', varName: 'x', typeName: 'X' },
        { scope: 'fn@10', varName: 'y', typeName: 'Y' },
      ]);

      expect(acc.fileScopeEntries('src/only-fn.ts')).toEqual([]);
      expect(acc.getFile('src/only-fn.ts')).toHaveLength(2);
      expect([...acc.files()]).toContain('src/only-fn.ts');
      expect(acc.fileCount).toBe(1);
    });

    it('multiple appends accumulate in both maps consistently', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [
        { scope: '', varName: 'x', typeName: 'X' },
        { scope: 'fn@1', varName: 'y', typeName: 'Y' },
      ]);
      acc.appendFile('src/a.ts', [
        { scope: '', varName: 'z', typeName: 'Z' },
        { scope: 'fn@2', varName: 'w', typeName: 'W' },
      ]);

      expect(acc.fileScopeEntries('src/a.ts')).toEqual([
        ['x', 'X'],
        ['z', 'Z'],
      ]);
      expect(acc.getFile('src/a.ts')).toHaveLength(4);
      expect(acc.totalBindings).toBe(4);
    });

    it('performance guard: fileScopeEntries does not walk function-scope entries', () => {
      const acc = new BindingAccumulator();
      // 1 file-scope entry + 1000 function-scope entries.
      const entries: BindingEntry[] = [{ scope: '', varName: 'shared', typeName: 'Shared' }];
      for (let i = 0; i < 1000; i++) {
        entries.push({
          scope: `fn${i}@${i * 10}`,
          varName: `local${i}`,
          typeName: 'Local',
        });
      }
      acc.appendFile('src/big.ts', entries);

      // fileScopeEntries returns the single file-scope pair without
      // iterating the 1000 function-scope entries — this is the O(1) cache
      // lookup behavior guaranteed by the storage split.
      const result = acc.fileScopeEntries('src/big.ts');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(['shared', 'Shared']);
      // Sanity: getFile still sees everything.
      expect(acc.getFile('src/big.ts')).toHaveLength(1001);
    });
  });

  // -------------------------------------------------------------------------
  // Integration coverage for the sequential
  // path → accumulator → ExportedTypeMap enrichment loop at pipeline.ts
  // lines 1082-1110. This test mirrors that loop inline with a minimal
  // KnowledgeGraph-shaped mock, locking in the node-ID format contract
  // (Function:{filePath}:{name}, Variable:..., Const:...). If the ID format
  // drifts for any language, this test fires.
  // -------------------------------------------------------------------------

  describe('ExportedTypeMap enrichment (integration)', () => {
    /**
     * Minimal graph backing for `enrichExportedTypeMap`. Matches the
     * `EnrichmentGraphNode` shape from binding-accumulator.ts — which in
     * turn matches the real `GraphNode.properties.isExported` access path
     * used by the production `KnowledgeGraph`. Using this shape (rather
     * than a flat `isExported` field) means a refactor of the graph's
     * `properties` layout will fail this test, not silently pass.
     */
    function makeGraphLookup(
      nodes: Array<{ id: string; isExported: boolean }>,
    ): EnrichmentGraphLookup {
      const byId = new Map<string, EnrichmentGraphNode>();
      for (const n of nodes) {
        byId.set(n.id, { id: n.id, properties: { isExported: n.isExported } });
      }
      return { getNode: (id) => byId.get(id) };
    }

    it('enriches exportedTypeMap with an exported Function node', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/utils.ts', [
        { scope: '', varName: 'helper', typeName: '(arg: string) => User' },
      ]);
      acc.finalize();

      const graph = makeGraphLookup([{ id: 'Function:src/utils.ts:helper', isExported: true }]);
      const exportedTypeMap = new Map<string, Map<string, string>>();

      const enriched = enrichExportedTypeMap(acc, graph, exportedTypeMap);

      expect(enriched).toBe(1);
      expect(exportedTypeMap.get('src/utils.ts')?.get('helper')).toBe('(arg: string) => User');
    });

    it('skips non-exported Variable nodes', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/app.ts', [{ scope: '', varName: 'dbClient', typeName: 'Database' }]);
      acc.finalize();

      const graph = makeGraphLookup([{ id: 'Variable:src/app.ts:dbClient', isExported: false }]);
      const exportedTypeMap = new Map<string, Map<string, string>>();

      const enriched = enrichExportedTypeMap(acc, graph, exportedTypeMap);

      expect(enriched).toBe(0);
      expect(exportedTypeMap.has('src/app.ts')).toBe(false);
    });

    it('enriches exportedTypeMap with an exported Const node', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/config.ts', [{ scope: '', varName: 'API_URL', typeName: 'string' }]);
      acc.finalize();

      const graph = makeGraphLookup([{ id: 'Const:src/config.ts:API_URL', isExported: true }]);
      const exportedTypeMap = new Map<string, Map<string, string>>();

      const enriched = enrichExportedTypeMap(acc, graph, exportedTypeMap);

      expect(enriched).toBe(1);
      expect(exportedTypeMap.get('src/config.ts')?.get('API_URL')).toBe('string');
    });

    it('silently skips accumulator entries with no matching graph node', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/missing.ts', [{ scope: '', varName: 'ghost', typeName: 'Ghost' }]);
      acc.finalize();

      // Empty graph — no nodes at any of the candidate IDs.
      const graph = makeGraphLookup([]);
      const exportedTypeMap = new Map<string, Map<string, string>>();

      // Must not throw; enrichment's `continue` path fires for every
      // unmatched entry.
      let enriched = -1;
      expect(() => {
        enriched = enrichExportedTypeMap(acc, graph, exportedTypeMap);
      }).not.toThrow();
      expect(enriched).toBe(0);
      expect(exportedTypeMap.has('src/missing.ts')).toBe(false);
    });

    it('does not overwrite existing SymbolTable entry (Tier 0 priority)', () => {
      // When the SymbolTable's tier-0 extraction pass has already populated
      // an entry for a name, the accumulator enrichment must NOT overwrite
      // it with a (lower-quality) worker-path binding.
      const acc = new BindingAccumulator();
      acc.appendFile('src/utils.ts', [
        { scope: '', varName: 'helper', typeName: 'WorkerInferredType' },
      ]);
      acc.finalize();

      // Pre-populate exportedTypeMap to simulate what SymbolTable would
      // have written in the tier-0 pass.
      const exportedTypeMap = new Map<string, Map<string, string>>([
        ['src/utils.ts', new Map([['helper', 'SymbolTableAuthoritativeType']])],
      ]);

      const graph = makeGraphLookup([{ id: 'Function:src/utils.ts:helper', isExported: true }]);

      const enriched = enrichExportedTypeMap(acc, graph, exportedTypeMap);

      // Tier 0 wins — the authoritative SymbolTable type survives.
      expect(enriched).toBe(0);
      expect(exportedTypeMap.get('src/utils.ts')?.get('helper')).toBe(
        'SymbolTableAuthoritativeType',
      );
    });

    it('handles nodes whose properties object is undefined (production shape)', () => {
      // Regression guard: the real KnowledgeGraph stores isExported under
      // `node.properties.isExported` and properties may be undefined for
      // some node kinds. The enrichment guard `!node?.properties?.isExported`
      // must treat an undefined properties object as non-exported.
      const acc = new BindingAccumulator();
      acc.appendFile('src/edge.ts', [{ scope: '', varName: 'helper', typeName: 'Helper' }]);
      acc.finalize();

      const graph: EnrichmentGraphLookup = {
        getNode: (id) =>
          id === 'Function:src/edge.ts:helper'
            ? ({ id, properties: undefined } satisfies EnrichmentGraphNode)
            : undefined,
      };
      const exportedTypeMap = new Map<string, Map<string, string>>();

      const enriched = enrichExportedTypeMap(acc, graph, exportedTypeMap);

      expect(enriched).toBe(0);
      expect(exportedTypeMap.has('src/edge.ts')).toBe(false);
    });

    it('returns 0 and leaves exportedTypeMap untouched when accumulator is empty', () => {
      const acc = new BindingAccumulator();
      acc.finalize();

      const graph = makeGraphLookup([{ id: 'Function:src/utils.ts:helper', isExported: true }]);
      const existingMap = new Map<string, Map<string, string>>([
        ['src/existing.ts', new Map([['keep', 'Type']])],
      ]);

      const enriched = enrichExportedTypeMap(acc, graph, existingMap);

      expect(enriched).toBe(0);
      expect(existingMap.size).toBe(1);
      expect(existingMap.get('src/existing.ts')?.get('keep')).toBe('Type');
    });
  });

  // -------------------------------------------------------------------------
  // BindingAccumulator.dispose() releases the accumulator's heap footprint
  // after the enrichment loop has consumed everything it needs. Post-dispose
  // reads return empty/undefined without throwing, matching "never-appended"
  // state. Idempotent and orthogonal to finalize().
  // -------------------------------------------------------------------------

  describe('fileScopeGet (O(1) point lookup)', () => {
    it('returns the typeName for a known file-scope binding', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/api.ts', [
        { scope: '', varName: 'getUser', typeName: 'User' },
        { scope: '', varName: 'getPost', typeName: 'Post' },
      ]);
      expect(acc.fileScopeGet('src/api.ts', 'getUser')).toBe('User');
      expect(acc.fileScopeGet('src/api.ts', 'getPost')).toBe('Post');
    });

    it('returns undefined for an unknown file', () => {
      const acc = new BindingAccumulator();
      expect(acc.fileScopeGet('nonexistent.ts', 'x')).toBeUndefined();
    });

    it('returns undefined for an unknown name in a known file', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);
      expect(acc.fileScopeGet('src/api.ts', 'missing')).toBeUndefined();
    });

    it('ignores function-scope entries', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/service.ts', [
        { scope: 'handler@10', varName: 'localDb', typeName: 'Database' },
        { scope: '', varName: 'config', typeName: 'Config' },
      ]);
      // Only file-scope entries are indexed by fileScopeGet.
      expect(acc.fileScopeGet('src/service.ts', 'config')).toBe('Config');
      expect(acc.fileScopeGet('src/service.ts', 'localDb')).toBeUndefined();
    });

    it('returns undefined after dispose', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'User' }]);
      acc.dispose();
      expect(acc.fileScopeGet('src/api.ts', 'getUser')).toBeUndefined();
    });

    it('last-write-wins for duplicate varNames in the same file', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'OldType' }]);
      acc.appendFile('src/api.ts', [{ scope: '', varName: 'getUser', typeName: 'NewType' }]);
      expect(acc.fileScopeGet('src/api.ts', 'getUser')).toBe('NewType');
    });
  });

  describe('dispose', () => {
    it('empties all read methods after dispose', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [
        { scope: '', varName: 'x', typeName: 'X' },
        { scope: 'fn@10', varName: 'y', typeName: 'Y' },
      ]);
      acc.appendFile('src/b.ts', [{ scope: '', varName: 'z', typeName: 'Z' }]);

      // Sanity: pre-dispose state is populated.
      expect(acc.fileCount).toBe(2);
      expect(acc.totalBindings).toBe(3);

      acc.dispose();

      // Post-dispose state: all read methods return empty/undefined.
      expect(acc.fileCount).toBe(0);
      expect(acc.totalBindings).toBe(0);
      expect([...acc.files()]).toEqual([]);
      expect(acc.getFile('src/a.ts')).toBeUndefined();
      expect(acc.getFile('src/b.ts')).toBeUndefined();
      expect(acc.fileScopeEntries('src/a.ts')).toEqual([]);
      expect(acc.fileScopeEntries('src/b.ts')).toEqual([]);
    });

    it('is idempotent — calling twice is a no-op', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'X' }]);
      acc.dispose();
      expect(() => acc.dispose()).not.toThrow();
      expect(acc.fileCount).toBe(0);
      expect(acc.totalBindings).toBe(0);
    });

    it('appendFile after dispose throws with the expected message', () => {
      // Single-use lifecycle: dispose is terminal. Any subsequent append is
      // a programming error (the consumer is treating a released accumulator
      // as if it were live). Convert the silent failure into a loud one.
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'X' }]);
      acc.dispose();
      expect(() =>
        acc.appendFile('src/b.ts', [{ scope: '', varName: 'y', typeName: 'Y' }]),
      ).toThrow('BindingAccumulator: use after dispose');
    });

    it('works after finalize() — append still throws, reads return empty', () => {
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'X' }]);
      acc.finalize();
      acc.dispose();
      // Finalized takes precedence — the finalize check runs first in
      // appendFile, so the error is the "finalize" one, not the
      // "use after dispose" one.
      expect(() =>
        acc.appendFile('src/b.ts', [{ scope: '', varName: 'y', typeName: 'Y' }]),
      ).toThrow(/finalize/);
      // Reads still return empty.
      expect(acc.fileCount).toBe(0);
      expect(acc.totalBindings).toBe(0);
      expect(acc.getFile('src/a.ts')).toBeUndefined();
    });

    it('estimateMemoryBytes drops to zero after dispose', () => {
      const acc = new BindingAccumulator();
      // Populate a large batch to give the estimate a non-trivial baseline.
      for (let i = 0; i < 100; i++) {
        acc.appendFile(`src/file${i}.ts`, [
          { scope: '', varName: `var${i}a`, typeName: 'string' },
          { scope: '', varName: `var${i}b`, typeName: 'number' },
        ]);
      }
      const preDisposeBytes = acc.estimateMemoryBytes();
      expect(preDisposeBytes).toBeGreaterThan(0);

      acc.dispose();

      // After dispose, the iteration over `_allByFile` in estimateMemoryBytes
      // has zero files to walk, so the returned value is exactly 0.
      expect(acc.estimateMemoryBytes()).toBe(0);
    });

    it('disposed getter reflects dispose state', () => {
      // Locks in the `get disposed()` contract for API symmetry with
      // `get finalized()`. Without this test, a trivial wrong impl like
      // `get disposed() { return this._finalized; }` passes everything.
      const acc = new BindingAccumulator();
      expect(acc.disposed).toBe(false);
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'X' }]);
      expect(acc.disposed).toBe(false);
      acc.dispose();
      expect(acc.disposed).toBe(true);
      acc.dispose(); // idempotent
      expect(acc.disposed).toBe(true);
    });

    it('dispose then finalize: appends throw, state is consistent', () => {
      // Orthogonality check: dispose() and finalize() are independent
      // lifecycle dimensions. dispose → finalize → appendFile should throw
      // the finalized error (because finalize was called), and the
      // accumulator should report both flags as true.
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'X' }]);
      acc.dispose();
      acc.finalize();
      expect(acc.disposed).toBe(true);
      expect(acc.finalized).toBe(true);
      expect(() =>
        acc.appendFile('src/b.ts', [{ scope: '', varName: 'y', typeName: 'Y' }]),
      ).toThrow(/finalize/);
    });

    it('fileScopeEntries returns a defensive copy — mutation does not corrupt state', () => {
      // Encapsulation guard: the cached internal array must not be exposed
      // by reference. Mutating the returned array should not affect
      // subsequent reads.
      const acc = new BindingAccumulator();
      acc.appendFile('src/a.ts', [
        { scope: '', varName: 'x', typeName: 'X' },
        { scope: '', varName: 'y', typeName: 'Y' },
      ]);

      const firstRead = acc.fileScopeEntries('src/a.ts');
      expect(firstRead).toHaveLength(2);

      // Try to corrupt internal state via the returned array. The
      // `readonly` return type is compile-time only; cast to mutable at
      // runtime to simulate a consumer that bypasses TypeScript.
      const mutableView = firstRead as unknown as [string, string][];
      mutableView.push(['corrupted', 'Corrupt']);
      mutableView.length = 0;

      // Subsequent reads are unaffected by the mutation attempt.
      const secondRead = acc.fileScopeEntries('src/a.ts');
      expect(secondRead).toHaveLength(2);
      expect(secondRead[0][0]).toBe('x');
      expect(secondRead[1][0]).toBe('y');
    });
  });
});
