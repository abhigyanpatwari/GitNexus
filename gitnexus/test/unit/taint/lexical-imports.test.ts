import Python from 'tree-sitter-python';
import { describe, expect, it } from 'vitest';
import { emitFileCfgs } from '../../../src/core/ingestion/cfg/emit.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { emitFileTaint } from '../../../src/core/ingestion/taint/emit.js';
import { harvestFileSummaries } from '../../../src/core/ingestion/taint/summary-harvest-driver.js';
import { createPythonCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/python.js';
import { pythonProvider } from '../../../src/core/ingestion/languages/python.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
} from '../../../src/core/ingestion/taint/match.js';
import { PYTHON_TAINT_MODEL } from '../../../src/core/ingestion/taint/python-model.js';
import { TS_JS_TAINT_MODEL } from '../../../src/core/ingestion/taint/typescript-model.js';
import { hasTaintSafeSites } from '../../../src/core/ingestion/taint/site-safety.js';
import { makeCfgHarness } from '../../helpers/cfg-harness.js';
import { cfgsOf } from '../../helpers/ts-cfg-harness.js';

const python = makeCfgHarness(Python, createPythonCfgVisitor(), 'fixture.py');
// A fixture-only sanitizer pins import ownership without changing the built-in model.
const pythonModel = {
  ...PYTHON_TAINT_MODEL,
  sanitizers: [{ module: 'shlex', name: 'quote', neutralizes: ['command-injection'] as const }],
};

function counts(code: string, language: 'python' | 'typescript') {
  const isPython = language === 'python';
  const parsed = extractParsedFile(
    isPython ? pythonProvider : typescriptProvider,
    code,
    isPython ? 'fixture.py' : 'fixture.ts',
  );
  expect(parsed).toBeDefined();
  const index = buildTaintImportIndex(parsed!.parsedImports, parsed!);
  const cfgs = isPython ? python.cfgsOf(code) : cfgsOf(code);
  return cfgs.map((cfg) => {
    expect(hasTaintSafeSites(cfg)).toBe(true);
    const matches = matchFunctionSites(cfg, isPython ? pythonModel : TS_JS_TAINT_MODEL, index);
    return {
      sinks: matches.statements.flatMap((s) => s.sinks).length,
      sanitizers: matches.statements.flatMap((s) => s.sanitizers).length,
    };
  });
}

describe('taint matches lexical import provenance', () => {
  it('preserves true global sinks when no lexical declaration owns the name', () => {
    expect(counts('def command(value):\n    eval(value)\n', 'python')).toEqual([
      { sinks: 1, sanitizers: 0 },
    ]);
    expect(counts('function command(value) { eval(value); }', 'typescript')).toEqual([
      { sinks: 1, sanitizers: 0 },
    ]);
  });

  it('does not select a sanitizer from uncertain conditional imports', () => {
    expect(
      counts(
        `def quoted(flag, value):
    if flag:
        from shlex import quote
    else:
        from harmless import quote
    return quote(value)
`,
        'python',
      ),
    ).toEqual([{ sinks: 0, sanitizers: 0 }]);
  });

  it('keeps Python sibling imports separate even when an external module is unresolved', () => {
    expect(
      counts(
        `def command(value):
    from os import system as run
    run(value)
def unrelated(value):
    from harmless import system as run
    run(value)
`,
        'python',
      ),
    ).toEqual([
      { sinks: 1, sanitizers: 0 },
      { sinks: 0, sanitizers: 0 },
    ]);
  });

  it('does not expose a Python function import to a sibling', () => {
    expect(
      counts(
        `def command(value):
    from os import system
    system(value)
def unrelated(value):
    system(value)
`,
        'python',
      ),
    ).toEqual([
      { sinks: 1, sanitizers: 0 },
      { sinks: 0, sanitizers: 0 },
    ]);
  });

  it('uses columns to distinguish Python calls before and after an import on one line', () => {
    expect(
      counts(
        `def command(value):
    system(value); from os import system; system(value)
`,
        'python',
      ),
    ).toEqual([{ sinks: 1, sanitizers: 0 }]);
  });

  it('blocks a global Python sink shadowed by a module declaration', () => {
    expect(
      counts(
        `eval = custom
def run(value):
    eval(value)
`,
        'python',
      ),
    ).toEqual([{ sinks: 0, sanitizers: 0 }]);
  });

  it('does not borrow a sanitizer from a different Python function', () => {
    expect(
      counts(
        `def quoted(value):
    from shlex import quote
    return quote(value)
def unrelated(value):
    return quote(value)
`,
        'python',
      ),
    ).toEqual([
      { sinks: 0, sanitizers: 1 },
      { sinks: 0, sanitizers: 0 },
    ]);
  });

  it('resolves module-level CommonJS aliases and renamed destructures', () => {
    expect(
      counts(
        `const cp = require('node:child_process');
const { exec: run } = require('child_process');
function command(value) { cp.exec(value); run(value); }
`,
        'typescript',
      ),
    ).toEqual([{ sinks: 2, sanitizers: 0 }]);
  });

  it('rejects a require call whose loader is a parameter', () => {
    expect(
      counts(
        `function command(require, value) {
  const cp = require('child_process'); cp.exec(value);
}`,
        'typescript',
      ),
    ).toEqual([{ sinks: 0, sanitizers: 0 }]);
  });

  it('does not expose a local CommonJS import to a sibling', () => {
    expect(
      counts(
        `function command(value) { const cp = require('child_process'); cp.exec(value); }
function unrelated(value) { cp.exec(value); }`,
        'typescript',
      ),
    ).toEqual([
      { sinks: 1, sanitizers: 0 },
      { sinks: 0, sanitizers: 0 },
    ]);
  });

  it('keeps a block shadow local and preserves the outer import after the block', () => {
    expect(
      counts(
        `import { exec } from 'child_process';
function command(value) { { const exec = custom; exec(value); } exec(value); }`,
        'typescript',
      ),
    ).toEqual([{ sinks: 1, sanitizers: 0 }]);
  });

  it('does not treat a type-only import as a runtime sink', () => {
    expect(
      counts(
        `import type { exec } from 'child_process';
function command(value) { exec(value); }`,
        'typescript',
      ),
    ).toEqual([{ sinks: 0, sanitizers: 0 }]);
  });
});

describe('lexical taint integration and incomplete site facts', () => {
  it('abstains from module/global matching when a call has no exact position', () => {
    const code = `import { exec } from 'child_process';
function command(value) { exec(value); eval(value); }`;
    const parsed = extractParsedFile(typescriptProvider, code, 'fixture.ts')!;
    const [harvested] = cfgsOf(code);
    const cfg = {
      ...harvested,
      blocks: harvested.blocks.map((block) => ({
        ...block,
        statements: block.statements?.map((statement) => ({
          ...statement,
          sites: statement.sites?.map((site) => ({ ...site, at: undefined })),
        })),
      })),
    };
    expect(hasTaintSafeSites(cfg)).toBe(true);
    const matches = matchFunctionSites(
      cfg,
      TS_JS_TAINT_MODEL,
      buildTaintImportIndex(parsed.parsedImports, parsed),
    );
    expect(matches.hasSink).toBe(false);
  });

  it('carries lexical provenance through emission and function summaries', () => {
    const code = `function command(req, value) {
  const { exec } = require('child_process');
  exec(req.body); exec(value);
}
function unrelated(req, value) {
  exec(req.body); exec(value);
}`;
    const parsed = extractParsedFile(typescriptProvider, code, 'fixture.ts')!;
    const cfgs = cfgsOf(code);
    const graph = createKnowledgeGraph();
    emitFileCfgs(graph, cfgs);
    const emitted = emitFileTaint(
      graph,
      cfgs,
      parsed.parsedImports,
      TS_JS_TAINT_MODEL,
      undefined,
      undefined,
      undefined,
      parsed,
    );
    expect(emitted.functionsAnalyzed).toBe(1);
    expect(emitted.functionsSkippedNoMatch).toBe(1);
    expect(emitted.findingsEmitted).toBe(1);
    expect([...graph.iterRelationships()].filter((edge) => edge.type === 'TAINTED')).toHaveLength(
      1,
    );

    // Give the driver unique graph anchors for the real harvested functions.
    const fnIndex = new Map([
      [
        parsed.filePath,
        new Map(cfgs.map((cfg, i) => [cfg.functionStartLine - 1, [`function:${i}`]] as const)),
      ],
    ]);
    const harvested = harvestFileSummaries(
      fnIndex,
      cfgs,
      parsed.parsedImports,
      TS_JS_TAINT_MODEL,
      undefined,
      undefined,
      parsed,
    );
    expect(harvested.unresolved).toBe(0);
    expect(harvested.gaps).toBe(0);
    expect(
      harvested.summaries.find((summary) => summary.fnId === 'function:0')?.paramToSink,
    ).toContainEqual({ param: 1, sinkKind: 'command-injection' });
    expect(
      harvested.summaries.find((summary) => summary.fnId === 'function:1')?.paramToSink,
    ).toEqual([]);
  });
});
