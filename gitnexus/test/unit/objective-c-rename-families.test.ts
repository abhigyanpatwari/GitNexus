import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import {
  objectiveCRenameEvidence,
  objectiveCRenameProvider,
} from '../../src/core/ingestion/languages/objective-c/rename.js';
import {
  joinObjectiveCSymbolFamily,
  objectiveCScopeResolver,
} from '../../src/core/ingestion/languages/objective-c/scope-resolver.js';

describe('Objective-C rename families', () => {
  describe.each(['protocol', 'implementation'])('joining from the %s', (anchor) => {
    it.each([40, 160, 640])('bounds family-map writes for %i conformers', (count) => {
      const families = new Map<string, Set<string>>();
      const writes = vi.spyOn(families, 'set');
      const protocol = { qualifiedName: 'objc:method:objc:protocol:Runnable:-:run' };
      const methods = Array.from({ length: count }, (_, i) => ({
        qualifiedName: `objc:method:objc:class:Worker${i}:-:run`,
      }));
      // Start with existing singleton families. Each implementation then joins
      // the growing protocol family and encounters the same declaration again.
      for (const method of methods) joinObjectiveCSymbolFamily(families, method.qualifiedName, []);
      for (const method of methods) {
        const first = anchor === 'protocol' ? protocol : method;
        joinObjectiveCSymbolFamily(families, first.qualifiedName, [protocol, method]);
      }

      expect(writes.mock.calls.length).toBeLessThanOrEqual(2 * (count + 1));
      const family = families.get(protocol.qualifiedName);
      expect(family).toEqual(new Set([protocol, ...methods].map((method) => method.qualifiedName)));
      for (const method of methods) expect(families.get(method.qualifiedName)).toBe(family);
    });
  });

  it('merges previously separate families and adds later names to the surviving set', () => {
    const families = new Map<string, Set<string>>();
    const join = (name: string, ...related: string[]) =>
      joinObjectiveCSymbolFamily(
        families,
        name,
        related.map((qualifiedName) => ({ qualifiedName })),
      );
    join('Left.run', 'LeftChild.run');
    join('Right.run', 'RightChild.run', 'RightCategory.run');
    join('Other.run');
    join('LeftChild.run', 'RightChild.run', 'Bridge.run');

    const expected = new Set([
      'Left.run',
      'LeftChild.run',
      'Right.run',
      'RightChild.run',
      'RightCategory.run',
      'Bridge.run',
    ]);
    for (const member of expected) expect(families.get(member)).toEqual(expected);
    expect(families.get('Other.run')).toEqual(new Set(['Other.run']));
  });

  it('reuses a resolved family across files and edits, and resolves a new target independently', async () => {
    const sources = await Promise.all(
      [
        ['Runnable.h', '@protocol Runnable\n- (void)run;\n@end'],
        ['Worker.m', '@interface Worker <Runnable>\n- (void)run;\n@end'],
        ['Other.m', '@interface Other\n- (void)run;\n@end'],
      ].map(([filePath, content]) =>
        objectiveCRenameProvider.parseSource({
          filePath,
          content,
          languageProvider: objectiveCScopeResolver.languageProvider,
          scopeResolver: objectiveCScopeResolver,
        }),
      ),
    );
    const files = new Map(sources.map((source) => [source.path, source]));
    const parsed = sources.map((source) => source.parsed);
    const graph = createKnowledgeGraph();
    const indexes = finalizeScopeModel(parsed);
    objectiveCScopeResolver.emitPostResolutionEdges?.(graph, parsed, new Map(), indexes, {
      fileContents: new Map(),
      recordSourceBinding: () => {},
    });
    const evidence = objectiveCRenameEvidence(parsed[0]);
    assert(evidence);
    const reads = vi.spyOn(evidence.symbolFamilies, 'get');
    const [protocol, worker, other] = parsed.map((file) => {
      const method = file.localDefs.find((def) => def.type === 'Method');
      assert(method);
      return method;
    });
    const context = {
      target: protocol,
      definitions: [protocol, worker, other],
      files,
      indexes,
      graph,
      model: createSemanticModel(),
      referenceBindings: new Map(),
      newName: 'execute',
    };
    assert(objectiveCRenameProvider.checkSafety);
    expect(objectiveCRenameProvider.checkSafety(context)).toBeUndefined();
    expect(objectiveCRenameProvider.symbolFamily?.(context)).toEqual([protocol, worker]);
    const scans = vi.spyOn(files, 'values');
    for (const source of sources.slice(0, 2)) {
      const occurrence = source.occurrences.find((item) => item.name === 'run');
      assert(occurrence);
      expect(objectiveCRenameProvider.rewrite?.({ ...context, source, occurrence })).toMatchObject([
        { oldText: 'run', newText: 'execute' },
      ]);
    }
    expect(scans).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(1);
    const nextPass = { ...context, graph: createKnowledgeGraph() };
    expect(objectiveCRenameProvider.symbolFamily?.(nextPass)).toEqual([protocol, worker]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(objectiveCRenameProvider.symbolFamily?.({ ...nextPass, files: new Map(files) })).toEqual(
      [protocol, worker],
    );
    expect(reads).toHaveBeenCalledTimes(3);
    expect(objectiveCRenameProvider.symbolFamily?.({ ...context, target: other })).toEqual([other]);
  });
});
