import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ParsedFile, ScopeId, Scope } from 'gitnexus-shared';
import { runScopeResolution } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import { _captureLogger } from '../../../src/core/logger.js';

// #2099 F4 — the per-element cfgSideChannel guard at the scope-resolution emit
// site. A malformed element (wrong shape, non-integer edge endpoints, or a
// shape that throws inside emitFileCfgs) must cost at most that element's /
// that file's CFG — never abort the language's scope-resolution pass, and
// never silently emit a dangling `BasicBlock:…:undefined` edge id. Harness:
// runScopeResolution with a stub provider + preExtractedParsedFiles, the same
// trio as run-progress.test.ts (no cfgVisitor needed — the emit path reads the
// channel directly).

const mkScope = (id: ScopeId, filePath: string): Scope => ({
  id,
  parent: null,
  kind: 'Module',
  range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
  filePath,
  bindings: new Map(),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(),
});

const mkFile = (filePath: string, cfgSideChannel?: unknown): ParsedFile => ({
  filePath,
  moduleScope: `scope:${filePath}#module`,
  scopes: [mkScope(`scope:${filePath}#module`, filePath)],
  parsedImports: [],
  localDefs: [],
  referenceSites: [],
  ...(cfgSideChannel !== undefined ? { cfgSideChannel } : {}),
});

const stubProvider = {
  language: 'python' as const,
  languageProvider: {} as ScopeResolver['languageProvider'],
  importEdgeReason: 'test',
  populateOwners: () => {},
  resolveImportTarget: () => null,
  mergeBindings: (existing: unknown) => existing,
  buildMro: () => new Map(),
  propagatesReturnTypesAcrossImports: false,
} as unknown as ScopeResolver;

const validCfg: FunctionCfg = {
  filePath: 'a.py',
  functionStartLine: 1,
  functionEndLine: 3,
  functionStartColumn: 0,
  entryIndex: 0,
  exitIndex: 1,
  blocks: [
    { index: 0, startLine: 1, endLine: 1, text: '', kind: 'entry' },
    { index: 1, startLine: 3, endLine: 3, text: '', kind: 'exit' },
  ],
  edges: [{ from: 0, to: 1, kind: 'seq' }],
};

/** Run scope-resolution with `pdg: true` over one file carrying `channel`. */
function emitWith(channel: unknown): KnowledgeGraph {
  const graph = createKnowledgeGraph();
  const files = [{ path: 'a.py', content: '' }];
  const preExtracted = new Map<string, ParsedFile>([['a.py', mkFile('a.py', channel)]]);
  runScopeResolution(
    {
      graph,
      model: createSemanticModel(),
      files,
      preExtractedParsedFiles: preExtracted,
      pdg: true,
    },
    stubProvider,
  );
  return graph;
}

const basicBlockCount = (graph: KnowledgeGraph): number => {
  let n = 0;
  graph.forEachNode((node) => {
    if (node.label === 'BasicBlock') n++;
  });
  return n;
};

const cfgEdges = (graph: KnowledgeGraph): { sourceId: string; targetId: string }[] => {
  const out: { sourceId: string; targetId: string }[] = [];
  graph.forEachRelationship((r) => {
    if (r.type === 'CFG') out.push({ sourceId: r.sourceId, targetId: r.targetId });
  });
  return out;
};

describe('cfgSideChannel emit guard (#2099 F4)', () => {
  let cap: ReturnType<typeof _captureLogger>;

  beforeEach(() => {
    cap = _captureLogger();
  });
  afterEach(() => {
    cap.restore();
  });

  const warns = (): string[] =>
    cap
      .records()
      .filter((r) => r.level >= 40) // pino warn = 40
      .map((r) => String(r.msg));

  it('a wrong-shape element [{}] is skipped with a warning naming the file; no throw', () => {
    const graph = emitWith([{}]);
    expect(basicBlockCount(graph)).toBe(0);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]).toContain('a.py');
  });

  it('a non-array channel is silently skipped by the outer guard', () => {
    const graph = emitWith('garbage');
    expect(basicBlockCount(graph)).toBe(0);
    expect(warns()).toHaveLength(0);
  });

  it('mixed array: the valid element still emits, the malformed one is skipped (per-element policy)', () => {
    const graph = emitWith([validCfg, {}]);
    expect(basicBlockCount(graph)).toBe(2);
    expect(cfgEdges(graph)).toHaveLength(1);
    expect(warns()).toHaveLength(1);
  });

  it('non-integer edge endpoints are rejected by the PREDICATE — zero dangling edge ids (this shape never throws)', () => {
    const poisoned = { ...validCfg, edges: [{ from: 'x', to: 1, kind: 'seq' }] };
    const graph = emitWith([poisoned]);
    expect(basicBlockCount(graph)).toBe(0);
    expect(cfgEdges(graph)).toHaveLength(0);
    expect(warns()).toHaveLength(1);
  });

  it('an INTEGER endpoint matching no block index is rejected too — membership, not just integer-ness', () => {
    const poisoned = { ...validCfg, edges: [{ from: 0, to: 7, kind: 'seq' }] };
    const graph = emitWith([poisoned]);
    expect(basicBlockCount(graph)).toBe(0);
    expect(cfgEdges(graph)).toHaveLength(0);
    expect(warns()).toHaveLength(1);
  });

  it('missing id-anchor fields (functionStartColumn) are rejected — prevents first-writer-wins id cross-wiring', () => {
    const { functionStartColumn: _drop, ...withoutColumn } = validCfg;
    const graph = emitWith([withoutColumn]);
    expect(basicBlockCount(graph)).toBe(0);
    expect(warns()).toHaveLength(1);
  });

  it('a null element inside blocks is rejected by the predicate — no partial emit, no orphaned nodes', () => {
    const poisoned = { ...validCfg, blocks: [validCfg.blocks[0], null] };
    const graph = emitWith([poisoned]);
    expect(basicBlockCount(graph)).toBe(0); // nothing emitted — not even the valid leading block
    expect(warns()).toHaveLength(1);
  });

  it('backstop: a shape that throws past the predicate (hostile getter) is caught, warned, pass completes', () => {
    const hostile = {
      ...validCfg,
      blocks: [
        {
          get index(): number {
            throw new Error('hostile getter');
          },
          startLine: 1,
          endLine: 1,
          text: '',
          kind: 'normal' as const,
        },
      ],
    };
    expect(() => emitWith([hostile])).not.toThrow();
    expect(warns()).toHaveLength(1);
    expect(warns()[0]).toContain('CFG emission failed');
  });

  it('a well-formed channel emits blocks + edges identically (regression guard)', () => {
    const graph = emitWith([validCfg]);
    expect(basicBlockCount(graph)).toBe(2);
    expect(cfgEdges(graph)).toHaveLength(1);
    expect(warns()).toHaveLength(0);
  });
});

describe('#2082 M2 — statement-fact emit guard (isEmitSafeCfg extension)', () => {
  let cap: ReturnType<typeof _captureLogger>;
  beforeEach(() => {
    cap = _captureLogger();
  });
  afterEach(() => {
    cap.restore();
  });
  const warns = (): string[] =>
    cap
      .records()
      .filter((r) => r.level >= 40)
      .map((r) => String(r.msg));

  const rdEdges = (graph: KnowledgeGraph): number => {
    let n = 0;
    graph.forEachRelationship((r) => {
      if (r.type === 'REACHING_DEF') n++;
    });
    return n;
  };
  const cfgEdgeCount = (graph: KnowledgeGraph): number => {
    let n = 0;
    graph.forEachRelationship((r) => {
      if (r.type === 'CFG') n++;
    });
    return n;
  };

  /** Valid facts-bearing CFG: def at stmt 0 reaches the use at stmt 1. */
  const factCfg = (blocks?: unknown): unknown => ({
    ...validCfg,
    bindings: [{ name: 'x', declLine: 1, declColumn: 0, kind: 'let' }],
    blocks: blocks ?? [
      { index: 0, startLine: 1, endLine: 1, text: '', kind: 'entry', statements: [] },
      {
        index: 1,
        startLine: 3,
        endLine: 3,
        text: '',
        kind: 'exit',
        statements: [
          { line: 2, defs: [0], uses: [] },
          { line: 3, defs: [], uses: [0] },
        ],
      },
    ],
  });

  it('a well-formed facts-bearing CFG passes the guard and emits REACHING_DEF', () => {
    const graph = emitWith([factCfg()]);
    expect(rdEdges(graph)).toBeGreaterThan(0);
    expect(warns()).toHaveLength(0);
  });

  it('an OUT-OF-RANGE binding index is rejected per element (would template undefined into ids)', () => {
    const bad = factCfg([
      { index: 0, startLine: 1, endLine: 1, text: '', kind: 'entry', statements: [] },
      {
        index: 1,
        startLine: 3,
        endLine: 3,
        text: '',
        kind: 'exit',
        statements: [{ line: 2, defs: [7], uses: [0] }], // 7 escapes the 1-entry table
      },
    ]);
    const graph = emitWith([bad, validCfg]);
    // the malformed element is skipped with a warn; the valid sibling emits CFG
    expect(rdEdges(graph)).toBe(0);
    expect(cfgEdgeCount(graph)).toBeGreaterThan(0);
    expect(warns().some((m) => m.includes('malformed'))).toBe(true);
  });

  it('statements WITHOUT a binding table are rejected (malformed by construction)', () => {
    const noTable = {
      ...(factCfg() as Record<string, unknown>),
      bindings: undefined,
    };
    const graph = emitWith([noTable]);
    expect(rdEdges(graph)).toBe(0);
    expect(warns().some((m) => m.includes('malformed'))).toBe(true);
  });

  it('non-integer statement line / non-array defs are rejected per element', () => {
    const badLine = factCfg([
      {
        index: 0,
        startLine: 1,
        endLine: 1,
        text: '',
        kind: 'entry',
        statements: [{ line: 'x', defs: [], uses: [] }],
      },
      { index: 1, startLine: 3, endLine: 3, text: '', kind: 'exit', statements: [] },
    ]);
    const badDefs = factCfg([
      {
        index: 0,
        startLine: 1,
        endLine: 1,
        text: '',
        kind: 'entry',
        statements: [{ line: 2, defs: 'nope', uses: [] }],
      },
      { index: 1, startLine: 3, endLine: 3, text: '', kind: 'exit', statements: [] },
    ]);
    for (const bad of [badLine, badDefs]) {
      const graph = emitWith([bad]);
      expect(rdEdges(graph)).toBe(0);
    }
    expect(warns().some((m) => m.includes('malformed'))).toBe(true);
  });

  it('a pre-M2 channel (no bindings, no statements) still passes — CFG emits, REACHING_DEF skips', () => {
    const graph = emitWith([validCfg]);
    expect(cfgEdgeCount(graph)).toBeGreaterThan(0);
    expect(rdEdges(graph)).toBe(0);
    expect(warns()).toHaveLength(0);
  });
});

describe('#2160 review — entry/exit index validation', () => {
  it('an out-of-range entryIndex is rejected per element (would crash the solver mid-file)', () => {
    const bad = { ...validCfg, entryIndex: 99 };
    const logs = _captureLogger();
    try {
      const graph = emitWith([bad, validCfg]);
      // the malformed element is skipped; the valid sibling still emits
      let cfgEdges = 0;
      graph.forEachRelationship((r) => {
        if (r.type === 'CFG') cfgEdges++;
      });
      expect(cfgEdges).toBeGreaterThan(0);
      expect(
        logs
          .records()
          .filter((r) => r.level >= 40)
          .some((r) => String(r.msg).includes('malformed')),
      ).toBe(true);
    } finally {
      logs.restore();
    }
  });
});
