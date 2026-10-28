/**
 * Locks the static value-flow check end to end (U10, R9, KTD11 walk rules 1–6, design §5.3a)
 * without LadybugDB or the TypeScript server: an injected fake edge source serves REACHING_DEF
 * edges in the persisted format (`BasicBlock:<file>:<fnLine>:<fnCol>:<n>` ids, reasons encoded by
 * the shared codec) and CALL_SUMMARY return-flow params, and a fake checker resolves names to
 * declarations of the in-memory production modules. Covers the plan's U10 scenarios: Math.round
 * vetoes; repo arithmetic is clean; a Map.set/Map.get round trip into a comparison is clean;
 * regex uses veto; expected-only is unknown; an `any` entry parameter is unknown; a truncated
 * function query is unknown; a fifth call level hits the depth cap; the statement rule; a derived
 * binding walked under its own name; repo code outside the mutated files is unknown; CALL_SUMMARY
 * continues the walk in the caller; a TypeScript version other than 7.0.2 and a missing PDG layer
 * degrade the run; a PDG that misses a use is unknown; a checker whose project fails to open
 * closes its server (a fake `typescript/unstable/sync` in a temp package).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeReachingDefReasonPairs } from '../../../src/core/ingestion/cfg/reaching-def-reason-codec.js';
import type { DiscardedValue } from '../../../tools/scenario-map/facet/input-facet.js';
import type { BindSide } from '../../../tools/scenario-map/value-flow/bind.js';
import {
  openChecker,
  PINNED_TYPESCRIPT,
  type OpenCheckerResult,
  type ValueFlowChecker,
} from '../../../tools/scenario-map/value-flow/checker.js';
import {
  staticValueFlow,
  type PdgEdgeSource,
  type PdgLayerState,
  type RdEdge,
  type StaticValueFlowRun,
  type ValueFlowPair,
} from '../../../tools/scenario-map/value-flow/pdg-walk.js';
import type { CalleeInfo } from '../../../tools/scenario-map/value-flow/sinks.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake TypeScript 7 API whose project never opens; it logs `open` and `close`. */
const FAKE_SYNC = `export const events = [];
export class API {
  constructor() { events.push('open'); }
  updateSnapshot() { throw new Error('project failed to open'); }
  close() { events.push('close'); }
}
`;

/** A temp repo whose gitnexus/ resolves `typescript/unstable/sync` to {@link FAKE_SYNC}. */
function fakeTypescript(): { repoRoot: string; syncFile: string } {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'scenario-checker-'));
  tempDirs.push(repoRoot);
  const tsDir = path.join(repoRoot, 'gitnexus', 'node_modules', 'typescript');
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(path.join(repoRoot, 'gitnexus', 'package.json'), '{"name":"fake","private":true}');
  writeFileSync(
    path.join(tsDir, 'package.json'),
    JSON.stringify({
      name: 'typescript',
      version: PINNED_TYPESCRIPT,
      exports: { './package.json': './package.json', './unstable/sync': './sync.mjs' },
    }),
  );
  const syncFile = path.join(tsDir, 'sync.mjs');
  writeFileSync(syncFile, FAKE_SYNC);
  return { repoRoot, syncFile };
}

const eventsOf = (module: unknown): unknown =>
  typeof module === 'object' && module !== null && 'events' in module ? module.events : null;

const M = 'gitnexus/src/m.ts';
const TOOL = 'gitnexus/tools/helper.ts';
const TEST = 'gitnexus/test/unit/m.test.ts';

const library = (name: string, container: string | null): CalleeInfo => ({
  origin: 'library',
  name,
  container,
  file: null,
  declarationEnd: null,
  isClass: false,
  reason: '',
});

/** Library members the fake checker knows, by the identifier naming them. */
const LIBRARY: Record<string, CalleeInfo> = {
  round: library('Math.round', 'Math'),
  extname: library('path.extname', 'path'),
  RegExp: library('RegExp', null),
  match: library('String.match', 'String'),
  set: library('Map.set', 'Map'),
  get: library('Map.get', 'Map'),
  has: library('ReadonlySet.has', 'ReadonlySet'),
};

interface FunctionInfo {
  file: string;
  name: string;
  line: number;
  column: number;
  end: number;
  params: { name: string; type: string }[];
}

/** Every named function of the modules: `function f`, `const f = (…) =>`. */
function functionsOf(modules: Record<string, string>): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  for (const [file, source] of Object.entries(modules)) {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    traverse(ast, {
      Function(path) {
        const node = path.node;
        const parent = path.parent;
        const name = t.isFunctionDeclaration(node)
          ? node.id?.name
          : t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)
            ? parent.id.name
            : undefined;
        if (name === undefined) return;
        const declaration = t.isVariableDeclarator(parent) ? parent : node;
        out.push({
          file,
          name,
          line: node.loc?.start.line ?? 0,
          column: node.loc?.start.column ?? 0,
          end: declaration.end ?? 0,
          params: node.params.map((param) => ({
            name: t.isIdentifier(param) ? param.name : '?',
            type:
              t.isIdentifier(param) && t.isTSTypeAnnotation(param.typeAnnotation)
                ? source.slice(
                    param.typeAnnotation.typeAnnotation.start ?? 0,
                    param.typeAnnotation.typeAnnotation.end ?? 0,
                  )
                : 'unknown',
          })),
        });
      },
    });
  }
  return out;
}

/** A checker that resolves names to the modules' functions, then to {@link LIBRARY}. */
function fakeChecker(modules: Record<string, string>, version = '7.0.2'): ValueFlowChecker {
  const functions = functionsOf(modules);
  const resolveAt = (_file: string, _offset: number, name: string): CalleeInfo => {
    const fn = functions.find((entry) => entry.name === name);
    if (fn !== undefined) {
      return {
        origin: 'repo',
        name,
        container: null,
        file: fn.file,
        declarationEnd: fn.end,
        isClass: false,
        reason: '',
      };
    }
    return LIBRARY[name] ?? { ...library(name, null), origin: 'unresolved', reason: 'unknown' };
  };
  return {
    version,
    tsconfig: 'gitnexus/tsconfig.test.json',
    resolveAt,
    resolveEntry: (file, offset, name, argIndex) => {
      const fn = functions.find((entry) => entry.name === name);
      const param = fn?.params[argIndex];
      return {
        callee: resolveAt(file, offset, name),
        param:
          param === undefined
            ? null
            : {
                index: argIndex,
                name: param.name,
                type: param.type,
                anyOrUnknown: param.type === 'any' || param.type === 'unknown',
                literalMembers: [],
              },
        paramReason: param === undefined ? 'no parameter' : '',
      };
    },
    close: () => undefined,
  };
}

/** One REACHING_DEF edge of function `fn`: `binding` defined on `defLine`, used on `useLines`. */
function rd(
  fns: readonly FunctionInfo[],
  fn: string,
  binding: string,
  defLine: number,
  ...useLines: number[]
): RdEdge {
  const info = fns.find((entry) => entry.name === fn) as FunctionInfo;
  const block = `BasicBlock:${info.file}:${info.line}:${info.column}`;
  return {
    src: `${block}:0`,
    dst: `${block}:1`,
    reason: encodeReachingDefReasonPairs(
      binding,
      useLines.map((useLine) => ({ defLine, useLine })),
    ),
  };
}

interface World {
  modules: Record<string, string>;
  /** REACHING_DEF edges, built from the modules' functions. */
  edges: (fns: FunctionInfo[]) => RdEdge[];
  /** CALL_SUMMARY return-flow params by function name. */
  summaries?: Record<string, number[]>;
  /** The two test bodies (one statement each); the value is the first `2.4` / `2.5`. */
  tests?: readonly string[];
  mutate?: string[];
  layer?: PdgLayerState;
  truncated?: boolean;
  checker?: OpenCheckerResult;
}

/** The bind side of one test line: discarded values at every number literal. */
function sideOf(source: string, line: number): BindSide {
  const text = source.split('\n')[line - 1];
  const discarded: DiscardedValue[] = [];
  const pattern = /\b\d+(\.\d+)?\b|'[a-z]+'/g;
  let position = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const literal = match[0];
    const isString = literal.startsWith("'");
    discarded.push({
      position: position++,
      kind: isString ? 'string' : 'number',
      value: isString ? literal.slice(1, -1) : literal,
      location: { file: TEST, line, column: match.index },
      origin: 'literal',
    });
  }
  return { file: TEST, source, fn: { start: 0, end: source.length }, discarded };
}

async function run(world: World): Promise<StaticValueFlowRun> {
  const fns = functionsOf(world.modules);
  const [first, second] = world.tests ?? ['expect(f(2.4)).toBe(2);', 'expect(f(2.5)).toBe(3);'];
  const source = `${first}\n${second}`;
  const edges: PdgEdgeSource = {
    layerState: async () => world.layer ?? 'ready',
    reachingDefs: async (file, fnLine) => ({
      edges: world
        .edges(fns)
        .filter((edge) => edge.src.startsWith(`BasicBlock:${file}:${fnLine}:`)),
      truncated: world.truncated ?? false,
    }),
    callSummary: async (_file, _startLine, name) => world.summaries?.[name] ?? null,
  };
  const pair: ValueFlowPair = {
    a: 'a',
    b: 'b',
    sides: [sideOf(source, 1), sideOf(source, 2)],
    mutate: world.mutate ?? [M],
  };
  return staticValueFlow([pair], {
    read: (file) => world.modules[file] ?? null,
    indexPrefix: '',
    edges,
    checker: world.checker ?? { status: 'ready', checker: fakeChecker(world.modules) },
  });
}

/** The pair's verdict in comparable form. */
async function verdict(world: World): Promise<unknown> {
  const result = await run(world);
  const pair = result.pairs[0];
  return {
    status: pair.status,
    reasons: pair.reasons,
    opaque: pair.opaqueSinks.map((site) => `${site.callee}@${site.line}`),
    degraded: result.degraded,
    trail: pair.sinks.map(
      (sink) => `${sink.depth}:${sink.class}:${sink.what}@${sink.location.line}`,
    ),
  };
}

const lines = (...rows: string[]): string => rows.join('\n');

describe('staticValueFlow: sinks through the walk', () => {
  it.each([
    {
      title: 'Math.round vetoes (design §8 adversarial)',
      world: {
        modules: {
          [M]: lines('export function f(raw: number) {', '  return Math.round(raw);', '}'),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'raw', 1, 2)],
      },
      want: {
        status: 'veto',
        reasons: ['opaque: Math.round (library) at gitnexus/src/m.ts:2'],
        opaque: ['Math.round@2'],
        degraded: [],
        trail: ['1:opaque:Math.round@2'],
      },
    },
    {
      title: 'repo arithmetic is clean',
      world: {
        modules: {
          [M]: lines('export function f(a: number, b = 1) {', '  return a + b;', '}'),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'a', 1, 2), rd(fns, 'f', 'b', 1, 2)],
      },
      want: {
        status: 'clean',
        reasons: [],
        opaque: [],
        degraded: [],
        trail: ['1:repo-code:arithmetic +@2', '1:pass-through:return@2'],
      },
    },
    {
      title: 'a Map.set and Map.get round trip into a comparison is clean',
      world: {
        modules: {
          [M]: lines(
            'export function f(v: number) {',
            '  const m = new Map<string, number>();',
            "  m.set('k', v);",
            "  return m.get('k') > 3;",
            '}',
          ),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'v', 1, 3), rd(fns, 'f', 'm', 2, 3, 4)],
      },
      want: {
        status: 'clean',
        reasons: [],
        opaque: [],
        degraded: [],
        trail: [
          '1:pass-through:Map.set@3',
          '1:table-read:Map.get read-back@4',
          '1:repo-code:comparison >@4',
        ],
      },
    },
    {
      title: 'new RegExp(v) vetoes as a regex use',
      world: {
        modules: { [M]: lines('export function f(v: string) {', '  return new RegExp(v);', '}') },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'v', 1, 2)],
        tests: ["expect(f('ab')).toBeTruthy();", "expect(f('cd')).toBeTruthy();"],
      },
      want: {
        status: 'veto',
        reasons: ['opaque: RegExp (regex) at gitnexus/src/m.ts:2'],
        opaque: ['RegExp@2'],
        degraded: [],
        trail: ['1:opaque:RegExp@2'],
      },
    },
    {
      title: 'v.match(...) vetoes as a regex use',
      world: {
        modules: {
          [M]: lines('export function f(v: string) {', '  return v.match(/a/) !== null;', '}'),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'v', 1, 2)],
        tests: ["expect(f('ab')).toBeTruthy();", "expect(f('cd')).toBeTruthy();"],
      },
      want: {
        status: 'veto',
        reasons: ['opaque: String.match (regex) at gitnexus/src/m.ts:2'],
        opaque: ['String.match@2'],
        degraded: [],
        trail: ['1:opaque:String.match@2'],
      },
    },
    {
      title: 'the opaque path.extname use vetoes its statement although === is repo code',
      world: {
        modules: {
          [M]: lines(
            'export function f(v: string) {',
            "  if (path.extname(v) === '.ts') {",
            '    return 1;',
            '  }',
            '  return 0;',
            '}',
          ),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'v', 1, 2)],
        tests: ["expect(f('ab')).toBe(1);", "expect(f('cd')).toBe(1);"],
      },
      want: {
        status: 'veto',
        reasons: ['opaque: path.extname (library) at gitnexus/src/m.ts:2'],
        opaque: ['path.extname@2'],
        degraded: [],
        trail: ['1:opaque:path.extname@2'],
      },
    },
    {
      title: 'a derived binding is walked under its own name',
      world: {
        modules: {
          [M]: lines(
            'export function f(opts: { ratio: number }) {',
            '  const { ratio } = opts;',
            '  return Math.round(ratio);',
            '}',
          ),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'opts', 1, 2), rd(fns, 'f', 'ratio', 2, 3)],
        tests: ['expect(f({ ratio: 2.4 })).toBe(2);', 'expect(f({ ratio: 2.5 })).toBe(3);'],
      },
      want: {
        status: 'veto',
        reasons: ['opaque: Math.round (library) at gitnexus/src/m.ts:3'],
        opaque: ['Math.round@3'],
        degraded: [],
        trail: ['1:opaque:Math.round@3'],
      },
    },
    {
      title: 'a table read through Set.has is clean',
      world: {
        modules: {
          [M]: lines(
            "const WORDS: ReadonlySet<string> = new Set(['class', 'enum']);",
            'export function f(word: string) {',
            '  return WORDS.has(word);',
            '}',
          ),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'word', 2, 3)],
        tests: ["expect(f('ab')).toBe(false);", "expect(f('cd')).toBe(false);"],
      },
      want: {
        status: 'clean',
        reasons: [],
        opaque: [],
        degraded: [],
        trail: ['1:table-read:ReadonlySet.has@3'],
      },
    },
  ])('$title', async ({ world, want }) => {
    expect(await verdict(world)).toEqual(want);
  });
});

describe('staticValueFlow: repo calls, CALL_SUMMARY and the depth cap', () => {
  const chain = (depth: number): string =>
    Array.from({ length: depth }, (_, index) =>
      index === depth - 1
        ? `export function g${index + 1}(v: number) { return v + 1; }`
        : `export function g${index + 1}(v: number) { return g${index + 2}(v); }`,
    ).join('\n');
  const chainEdges = (depth: number) => (fns: FunctionInfo[]) =>
    Array.from({ length: depth }, (_, index) =>
      rd(fns, `g${index + 1}`, 'v', index + 1, index + 1),
    );
  const chainTests: readonly string[] = ['expect(g1(2.4)).toBe(1);', 'expect(g1(2.5)).toBe(1);'];

  it.each([
    {
      title: 'four call levels are walked to the end',
      world: { modules: { [M]: chain(4) }, edges: chainEdges(4), tests: chainTests },
      want: {
        status: 'clean',
        reasons: [],
        opaque: [],
        degraded: [],
        trail: [
          '1:repo-code:call g2@1',
          '2:repo-code:call g3@2',
          '3:repo-code:call g4@3',
          '4:repo-code:arithmetic +@4',
          '4:pass-through:return@4',
          '3:pass-through:return@3',
          '2:pass-through:return@2',
          '1:pass-through:return@1',
        ],
      },
    },
    {
      title: 'a fifth call level hits the depth cap',
      world: { modules: { [M]: chain(5) }, edges: chainEdges(5), tests: chainTests },
      want: {
        status: 'unknown',
        reasons: ['unknown: g5 (depth-cap) at gitnexus/src/m.ts:4'],
        opaque: [],
        degraded: [],
        trail: [
          '1:repo-code:call g2@1',
          '2:repo-code:call g3@2',
          '3:repo-code:call g4@3',
          '4:repo-code:call g5@4',
          '4:unknown:g5@4',
        ],
      },
    },
    {
      title: 'a value returned unchanged and compared by the caller continues there (clean)',
      world: {
        modules: {
          [M]: lines(
            'export function id(x: number) {',
            '  return x;',
            '}',
            'export function f(v: number) {',
            '  return id(v) > 3;',
            '}',
          ),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'id', 'x', 1, 2), rd(fns, 'f', 'v', 4, 5)],
        summaries: { id: [0] },
      },
      want: {
        status: 'clean',
        reasons: [],
        opaque: [],
        degraded: [],
        trail: ['1:repo-code:call id@5', '2:pass-through:return@2', '1:repo-code:comparison >@5'],
      },
    },
    {
      title: 'CALL_SUMMARY continues the walk in the caller into an opaque sink',
      world: {
        modules: {
          [M]: lines(
            'const WORDS: ReadonlySet<number> = new Set([1, 2]);',
            'export function known(x: number) {',
            '  return WORDS.has(x);',
            '}',
            'export function f(v: number) {',
            '  return Math.round(known(v));',
            '}',
          ),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'known', 'x', 2, 3), rd(fns, 'f', 'v', 5, 6)],
        summaries: { known: [0] },
      },
      want: {
        status: 'veto',
        reasons: ['opaque: Math.round (library) at gitnexus/src/m.ts:6'],
        opaque: ['Math.round@6'],
        degraded: [],
        trail: [
          '1:repo-code:call known@6',
          '2:table-read:ReadonlySet.has@3',
          '1:opaque:Math.round@6',
        ],
      },
    },
    {
      title: 'without a return flow the caller does not continue with the result',
      world: {
        modules: {
          [M]: lines(
            'const WORDS: ReadonlySet<number> = new Set([1, 2]);',
            'export function known(x: number) {',
            '  return WORDS.has(x);',
            '}',
            'export function f(v: number) {',
            '  return Math.round(known(v));',
            '}',
          ),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'known', 'x', 2, 3), rd(fns, 'f', 'v', 5, 6)],
        summaries: { known: [] },
      },
      want: {
        status: 'clean',
        reasons: [],
        opaque: [],
        degraded: [],
        trail: ['1:repo-code:call known@6', '2:table-read:ReadonlySet.has@3'],
      },
    },
    {
      title: 'repo code outside the mutated files is unknown, not clean',
      world: {
        modules: {
          [M]: lines('export function f(v: number) {', '  return helper(v);', '}'),
          [TOOL]: lines('export function helper(x: number) {', '  return x + 1;', '}'),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'v', 1, 2), rd(fns, 'helper', 'x', 1, 2)],
      },
      want: {
        status: 'unknown',
        reasons: [
          'unknown: helper (repo code outside the mutated files: gitnexus/tools/helper.ts) at gitnexus/src/m.ts:2',
        ],
        opaque: [],
        degraded: [],
        trail: ['1:unknown:helper@2'],
      },
    },
  ])('$title', async ({ world, want }) => {
    expect(await verdict(world)).toEqual(want);
  });
});

describe('staticValueFlow: unknown and degraded', () => {
  const ROUND = lines('export function f(raw: number) {', '  return Math.round(raw);', '}');
  const roundEdges = (fns: FunctionInfo[]) => [rd(fns, 'f', 'raw', 1, 2)];

  it.each([
    {
      title: 'only expected values differ (expected-only)',
      world: {
        modules: { [M]: ROUND },
        edges: roundEdges,
        tests: ["expect(f(7)).toContain('alpha');", "expect(f(7)).toContain('beta');"],
      },
      want: { status: 'unknown', reasons: ['expected-only'], opaque: [], degraded: [], trail: [] },
    },
    {
      title: 'an entry parameter typed any is unknown',
      world: {
        modules: { [M]: lines('export function f(raw: any) {', '  return raw + 1;', '}') },
        edges: roundEdges,
      },
      want: {
        status: 'unknown',
        reasons: ['entry f#0: parameter raw is typed any'],
        opaque: [],
        degraded: [],
        trail: [],
      },
    },
    {
      title: 'a truncated function query is unknown',
      world: { modules: { [M]: ROUND }, edges: roundEdges, truncated: true },
      want: {
        status: 'unknown',
        reasons: ['unknown: f (pdg query truncated) at gitnexus/src/m.ts:1'],
        opaque: [],
        degraded: [],
        trail: ['1:unknown:f@1'],
      },
    },
    {
      title: 'a use the PDG does not report is unknown',
      world: { modules: { [M]: ROUND }, edges: () => [] },
      want: {
        status: 'unknown',
        reasons: ['unknown: raw (no REACHING_DEF use) at gitnexus/src/m.ts:2'],
        opaque: [],
        degraded: [],
        trail: ['1:unknown:raw@2'],
      },
    },
    {
      title: 'a value captured by a closure is unknown',
      world: {
        modules: {
          [M]: lines(
            'export function f(v: number, xs: number[]) {',
            '  return xs.map((x) => x + v);',
            '}',
          ),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'xs', 1, 2)],
      },
      want: {
        status: 'unknown',
        reasons: ['unknown: v (captured by a closure) at gitnexus/src/m.ts:2'],
        opaque: [],
        degraded: [],
        trail: ['1:unknown:v@2'],
      },
    },
    {
      title: 'a compound assignment carries the value to its later uses',
      world: {
        modules: {
          [M]: lines('export function f(v: number) {', '  v += 1;', '  return Math.round(v);', '}'),
        },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'v', 1, 2), rd(fns, 'f', 'v', 2, 3)],
      },
      want: {
        status: 'veto',
        reasons: ['opaque: Math.round (library) at gitnexus/src/m.ts:3'],
        opaque: ['Math.round@3'],
        degraded: [],
        trail: ['1:repo-code:arithmetic +=@2', '1:opaque:Math.round@3'],
      },
    },
    {
      title: 'a PDG def on a line that assigns nothing is unknown, not skipped',
      world: {
        modules: { [M]: ROUND },
        edges: (fns: FunctionInfo[]) => [rd(fns, 'f', 'raw', 2, 2)],
      },
      want: {
        status: 'unknown',
        reasons: [
          'unknown: raw (pdg def on line 2 is not an assignment of the binding) at gitnexus/src/m.ts:1',
        ],
        opaque: [],
        degraded: [],
        trail: ['1:unknown:raw@1'],
      },
    },
    {
      title: 'TypeScript 7.0.3 degrades the run and every value-differing pair is unknown',
      world: {
        modules: { [M]: ROUND },
        edges: roundEdges,
        checker: { status: 'checker-version', version: '7.0.3' } as const,
      },
      want: {
        status: 'unknown',
        reasons: ['checker-version'],
        opaque: [],
        degraded: ['checker-version'],
        trail: [],
      },
    },
    {
      title: 'a missing PDG layer degrades the run and every value-differing pair is vetoed',
      world: { modules: { [M]: ROUND }, edges: roundEdges, layer: 'no-layer' as const },
      want: {
        status: 'veto',
        reasons: ['no-pdg-layer'],
        opaque: [],
        degraded: ['no-pdg-layer'],
        trail: [],
      },
    },
  ])('$title', async ({ world, want }) => {
    expect(await verdict(world)).toEqual(want);
  });

  it('needs no check when the discarded values are equal, even on a degraded run', async () => {
    const result = await run({
      modules: { [M]: ROUND },
      edges: roundEdges,
      layer: 'no-layer',
      tests: ['expect(f(2.4)).toBe(2);', 'expect(f(2.4)).toBe(2);'],
    });
    expect([result.pairs[0].status, result.degraded]).toEqual(['not-required', ['no-pdg-layer']]);
  });

  it.each(['7.0.3', '7.1.0', '6.0.2'])(
    'openChecker refuses TypeScript %s before starting the server',
    async (version) => {
      expect([PINNED_TYPESCRIPT, await openChecker({ repoRoot: '.', version })]).toEqual([
        '7.0.2',
        { status: 'checker-version', version },
      ]);
    },
  );

  it('closes the checker server when its project fails to open', async () => {
    const { repoRoot, syncFile } = fakeTypescript();
    const result = await openChecker({ repoRoot, version: PINNED_TYPESCRIPT });
    const events = eventsOf(await import(syncFile));
    expect([result, events]).toEqual([
      { status: 'error', error: 'checker failed to open: project failed to open' },
      ['open', 'close'],
    ]);
  });

  it('records the entry with its parameter type for the reviewer', async () => {
    const result = await run({ modules: { [M]: ROUND }, edges: roundEdges });
    expect(
      result.pairs[0].entries.map((entry) => ({
        callee: entry.callee,
        argIndex: entry.argIndex,
        declaration: entry.declaration,
        param: entry.param?.type,
      })),
    ).toEqual([{ callee: 'f', argIndex: 0, declaration: `${M}#f`, param: 'number' }]);
  });
});
