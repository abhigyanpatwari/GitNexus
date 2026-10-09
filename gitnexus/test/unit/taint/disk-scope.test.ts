import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import type { ParsedFile } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { runScopeResolution } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { getScopeIndexStoreDir } from '../../../src/storage/scope-index-store.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';
import { cfgsOf } from '../../helpers/ts-cfg-harness.js';

const stores = createTempDirPool('gn-taint-disk-scope-');
const code = `import { exec } from 'child_process';
function command(req, value) {
  exec(req.body); exec(value);
  eval(req.body); eval(value);
}
function shadowed(req, value, eval, exec) {
  exec(req.body); exec(value);
  eval(req.body); eval(value);
}
function localCommand(req, value) {
  const { exec: run } = require('child_process');
  run(req.body); run(value);
}
function unrelated(req, value) {
  run(req.body); run(value);
}`;

function analyze(disk: boolean) {
  const previous = process.env.GITNEXUS_DISK_SCOPE_INDEX;
  process.env.GITNEXUS_DISK_SCOPE_INDEX = disk ? '1' : '0';
  try {
    const parsed = extractParsedFile(typescriptProvider, code, 'fixture.ts');
    if (parsed === undefined) throw new Error('fixture extraction failed');
    const cfgs = cfgsOf(code);
    const preExtracted = new Map<string, ParsedFile>([
      [parsed.filePath, { ...parsed, cfgSideChannel: cfgs }],
    ]);
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    const storePath = stores.dir();
    const stats = runScopeResolution(
      {
        graph,
        model,
        files: [{ path: parsed.filePath, content: code }],
        pdg: true,
        preExtractedParsedFiles: preExtracted,
        scopeIndexStorePath: storePath,
        prebuiltFunctionNodeIndex: new Map([
          [
            parsed.filePath,
            new Map(cfgs.map((cfg, i) => [cfg.functionStartLine - 1, [`function:${i}`]])),
          ],
        ]),
      },
      typescriptScopeResolver,
    );
    if (disk) {
      expect(readdirSync(getScopeIndexStoreDir(storePath)).length).toBeGreaterThan(0);
      // The real seal ran and released the caller's resident ParsedFiles.
      expect(preExtracted.size).toBe(0);
    }
    return {
      findings: [...graph.iterRelationships()]
        .filter((edge) => edge.type === 'TAINTED')
        .sort((a, b) => a.id.localeCompare(b.id)),
      summaries: stats.functionSummaries,
    };
  } finally {
    if (previous === undefined) delete process.env.GITNEXUS_DISK_SCOPE_INDEX;
    else process.env.GITNEXUS_DISK_SCOPE_INDEX = previous;
  }
}

describe('taint emission after the disk scope seal', () => {
  it('preserves exact findings and summaries without losing lexical import/global barriers', () => {
    const resident = analyze(false);
    const sealed = analyze(true);
    // The module import, true global, and function-local import each contribute
    // one finding. Shadowed names and the sibling's local import contribute none.
    expect(resident.findings).toHaveLength(3);
    expect(sealed.findings).toEqual(resident.findings);
    expect(sealed.summaries).toEqual(resident.summaries);
    const sinks = (functionIndex: number) =>
      sealed.summaries.find((summary) => summary.fnId === `function:${functionIndex}`)?.paramToSink;
    expect(sinks(0)).toEqual([
      { param: 0, sinkKind: 'code-injection' },
      { param: 0, sinkKind: 'command-injection' },
      { param: 1, sinkKind: 'code-injection' },
      { param: 1, sinkKind: 'command-injection' },
    ]);
    expect(sinks(1)).toEqual([]);
    expect(sinks(2)).toEqual([
      { param: 0, sinkKind: 'command-injection' },
      { param: 1, sinkKind: 'command-injection' },
    ]);
    expect(sinks(3)).toEqual([]);
  });
});
