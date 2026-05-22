import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _captureLogger } from '../../src/core/logger.js';
import { processCallsFromExtracted } from '../../src/core/ingestion/call-processor.js';
import { buildHeritageMap } from '../../src/core/ingestion/model/heritage-map.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ExtractedHeritage } from '../../src/core/ingestion/model/heritage-map.js';
import type { ExtractedCall } from '../../src/core/ingestion/workers/parse-worker.js';

describe('deferred-resolution-profile wiring', () => {
  let cap: ReturnType<typeof _captureLogger>;
  let prevProfileDeferred: string | undefined;
  let prevVerbose: string | undefined;
  let prevRegistryTypeScript: string | undefined;

  beforeEach(() => {
    cap = _captureLogger();
    prevProfileDeferred = process.env.GITNEXUS_PROFILE_DEFERRED;
    prevVerbose = process.env.GITNEXUS_VERBOSE;
    prevRegistryTypeScript = process.env.REGISTRY_PRIMARY_TYPESCRIPT;
    process.env.GITNEXUS_PROFILE_DEFERRED = '1';
    delete process.env.GITNEXUS_VERBOSE;
    process.env.REGISTRY_PRIMARY_TYPESCRIPT = 'false';
  });

  afterEach(() => {
    cap.restore();
    if (prevProfileDeferred === undefined) delete process.env.GITNEXUS_PROFILE_DEFERRED;
    else process.env.GITNEXUS_PROFILE_DEFERRED = prevProfileDeferred;
    if (prevVerbose === undefined) delete process.env.GITNEXUS_VERBOSE;
    else process.env.GITNEXUS_VERBOSE = prevVerbose;
    if (prevRegistryTypeScript === undefined) delete process.env.REGISTRY_PRIMARY_TYPESCRIPT;
    else process.env.REGISTRY_PRIMARY_TYPESCRIPT = prevRegistryTypeScript;
  });

  const deferredMsgs = (): string[] =>
    cap
      .records()
      .map((r) => String(r.msg ?? ''))
      .filter((m) => m.includes('[deferred-profile]'));

  it('buildHeritageMap emits profile stats when GITNEXUS_PROFILE_DEFERRED=1', () => {
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/a.java', 'Foo', 'class:a:Foo', 'Class');
    ctx.model.symbols.add('src/b.java', 'Foo', 'class:b:Foo', 'Class');
    ctx.model.symbols.add('src/c.java', 'Bar', 'class:c:Bar', 'Class');
    ctx.model.symbols.add('src/d.java', 'Bar', 'class:d:Bar', 'Class');

    const heritage: ExtractedHeritage[] = [
      { filePath: 'src/a.java', className: 'Foo', parentName: 'Bar', kind: 'extends' },
    ];

    buildHeritageMap(heritage, ctx);

    expect(
      deferredMsgs().some(
        (m) =>
          m.includes('buildHeritageMap:') &&
          m.includes('child×parent lookup product >1') &&
          m.includes('max product'),
      ),
    ).toBe(true);
  });

  it('processCallsFromExtracted emits done summary with skipped registry-primary count', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();
    ctx.model.symbols.add('src/index.ts', 'helper', 'Function:src/index.ts:helper', 'Function');

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/index.ts',
        calledName: 'helper',
        sourceId: 'Function:src/index.ts:main',
      },
      {
        filePath: 'src/main.py',
        calledName: 'run',
        sourceId: 'Function:src/main.py:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    expect(
      deferredMsgs().some(
        (m) =>
          m.includes('processCallsFromExtracted done:') &&
          m.includes('skipped registry-primary files=1'),
      ),
    ).toBe(true);
  });

  it('processCallsFromExtracted does not log per-file progress for registry-primary skips', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    const calls: ExtractedCall[] = [
      {
        filePath: 'src/only.py',
        calledName: 'run',
        sourceId: 'Function:src/only.py:main',
      },
    ];

    await processCallsFromExtracted(graph, calls, ctx);

    expect(deferredMsgs().some((m) => m.includes('calls 1/1 file=src/only.py'))).toBe(false);
    expect(deferredMsgs().some((m) => m.includes('skipped registry-primary files=1'))).toBe(true);
  });
});
