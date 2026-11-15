/**
 * Locks the value-flow sink classification (U10, R9, KTD11 rules 2–4, design §5.3a step 3)
 * without a PDG or a checker: the parameter `v` of a function `f` in a small production module is
 * climbed from each reference to its consumers, with a fake callee resolver keyed by the callee's
 * source text. Covers the design's classes and order (repo code, supported table read,
 * pass-through, opaque, unknown), the statement rule (`if (path.extname(v) === '.ts')` is vetoed
 * although `===` is repo code), regex uses, the storage exemption with its read-back, derived
 * bindings (KTD11 rule 3) and repo calls outside the pair's mutated files.
 */
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { scanSupportedTables } from '../../../tools/scenario-map/mutation/row-deletion.js';
import {
  statementClass,
  verdictOf,
  walkUp,
  type CalleeInfo,
  type ClassifyContext,
  type Sink,
  type TableSupport,
  type WalkUpResult,
} from '../../../tools/scenario-map/value-flow/sinks.js';

const FILE = 'gitnexus/src/m.ts';
const OTHER = 'gitnexus/src/other.ts';
const OUTSIDE = 'gitnexus/tools/helper.ts';

const library = (name: string, container: string | null): CalleeInfo => ({
  origin: 'library',
  name,
  container,
  file: null,
  declarationEnd: null,
  isClass: false,
  reason: '',
});
const repo = (name: string, file: string): CalleeInfo => ({
  origin: 'repo',
  name,
  container: null,
  file,
  declarationEnd: 0,
  isClass: false,
  reason: '',
});

/** Callee source text → what the checker would say. */
const CALLEES: Record<string, CalleeInfo> = {
  'Math.round': library('Math.round', 'Math'),
  'path.extname': library('path.extname', null),
  RegExp: library('RegExp', null),
  'v.match': library('String.match', 'String'),
  'v.split': library('String.split', 'String'),
  'RESERVED.has': library('ReadonlySet.has', 'ReadonlySet'),
  'WRITTEN.has': library('Set.has', 'Set'),
  'seen.has': library('Set.has', 'Set'),
  'm.set': library('Map.set', 'Map'),
  'm.get': library('Map.get', 'Map'),
  'out.push': library('Array.push', 'Array'),
  'this.items.push': library('Array.push', 'Array'),
  '(v * 10).toFixed': library('Number.toFixed', 'Number'),
  add: repo('add', OTHER),
  helper: repo('helper', OUTSIDE),
};

interface Classified {
  results: WalkUpResult[];
  ctx: ClassifyContext;
}

/** Walks every reference of `name` in function `f` of `source`. */
function classify(source: string, name = 'v'): Classified {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  let fn: NodePath<t.Function> | undefined;
  traverse(ast, {
    Function(path) {
      const id = path.isFunctionDeclaration() ? path.node.id?.name : undefined;
      if (fn === undefined && id === 'f') fn = path;
    },
  });
  const found = fn as NodePath<t.Function>;
  const tables = new Map<string, TableSupport>();
  for (const [binding, constructs] of scanSupportedTables(FILE, source) ?? new Map()) {
    tables.set(binding, { supported: constructs.length === 0, constructs });
  }
  const ctx: ClassifyContext = {
    file: FILE,
    fn: found,
    resolve: (site) => {
      const callee = site.node.callee;
      const text = source.slice(callee.start ?? 0, callee.end ?? 0);
      return (
        CALLEES[text] ?? {
          ...library(text, null),
          origin: 'unresolved',
          reason: 'not in the fake checker',
        }
      );
    },
    inScope: (file) => file === FILE || file === OTHER,
    tables,
  };
  const binding = found.scope.getBinding(name);
  const references = binding?.referencePaths ?? [];
  return { results: references.map((reference) => walkUp(reference, ctx)), ctx };
}

const sinksOf = (results: readonly WalkUpResult[]): Sink[] =>
  results.flatMap((result) => result.sinks);
const render = (sinks: readonly Sink[]): string[] =>
  sinks.map(
    (sink) => `${sink.class}: ${sink.what}${sink.reason === '' ? '' : ` (${sink.reason})`}`,
  );

describe('walkUp: sink classes', () => {
  it.each([
    {
      title: 'Math.round is opaque (design §8 adversarial)',
      source: 'export function f(v: number) { return Math.round(v); }',
      verdict: 'veto',
      sinks: ['opaque: Math.round (library)'],
    },
    {
      title: 'repo arithmetic and the return are clean',
      source: 'export function f(v: number, w: number) { return v + w; }',
      verdict: 'clean',
      sinks: ['repo-code: arithmetic +', 'pass-through: return'],
    },
    {
      title: 'a comparison ends the climb',
      source: 'export function f(v: number) { if (v < 0) { return 0; } return 1; }',
      verdict: 'clean',
      sinks: ['repo-code: comparison <'],
    },
    {
      title: 'a template literal is repo code',
      source: 'export function f(v: string) { return `${v}-1`; }',
      verdict: 'clean',
      sinks: ['repo-code: template', 'pass-through: return'],
    },
    {
      title: 'new RegExp(v) is a regex use',
      source: 'export function f(v: string) { return new RegExp(v); }',
      verdict: 'veto',
      sinks: ['opaque: RegExp (regex)'],
    },
    {
      title: 'v.match(...) is a regex use',
      source: 'export function f(v: string) { return v.match(/x/) !== null; }',
      verdict: 'veto',
      sinks: ['opaque: String.match (regex)'],
    },
    {
      title: 'split with a regex argument is a regex use',
      source: 'export function f(v: string) { return v.split(/,/); }',
      verdict: 'veto',
      sinks: ['opaque: String.split (regex)'],
    },
    {
      title: 'a derived value reaching toFixed is opaque',
      source: 'export function f(v: number) { return (v * 10).toFixed(1); }',
      verdict: 'veto',
      sinks: ['repo-code: arithmetic *', 'opaque: Number.toFixed (library)'],
    },
    {
      title: 'Set.has on a supported module table is a table read',
      source:
        "const RESERVED = new Set(['class', 'enum']);\nexport function f(v: string) { return RESERVED.has(v); }",
      verdict: 'clean',
      sinks: ['table-read: ReadonlySet.has'],
    },
    {
      title: 'a key read of a supported object table is a table read',
      source: 'const T = { a: 1, b: 2, c: 3 };\nexport function f(v: string) { return T[v]; }',
      verdict: 'clean',
      sinks: ['table-read: key read'],
    },
    {
      title: 'Set.has on a table the module writes is unknown',
      source:
        "const WRITTEN = new Set(['a', 'b']);\nWRITTEN.add('c');\nexport function f(v: string) { return WRITTEN.has(v); }",
      verdict: 'unknown',
      sinks: ['unknown: Set.has (unsupported table: write)'],
    },
    {
      title: 'a key read of a parameter object is unknown',
      source: 'export function f(v: string, o: Record<string, number>) { return o[v]; }',
      verdict: 'unknown',
      sinks: ['unknown: key read (not a supported table)'],
    },
    {
      title: 'a repo call in the mutated files is repo code',
      source: 'export function f(v: number) { add(v, 1); }',
      verdict: 'clean',
      sinks: ['repo-code: call add'],
    },
    {
      title: 'a repo call outside the mutated files is unknown',
      source: 'export function f(v: number) { helper(v); }',
      verdict: 'unknown',
      sinks: ['unknown: helper (repo code outside the mutated files: gitnexus/tools/helper.ts)'],
    },
    {
      title: 'an unresolved callee is unknown',
      source: 'export function f(v: number, g: (x: number) => void) { g(v); }',
      verdict: 'unknown',
      sinks: ['unknown: g (unresolved callee: not in the fake checker)'],
    },
    {
      title: 'a store into a property is unknown',
      source: 'export function f(v: number, o: { x: number }) { o.x = v; }',
      verdict: 'unknown',
      sinks: ['unknown: property write (stored into a property)'],
    },
    {
      title: 'a value captured by a closure is unknown',
      source: 'export function f(v: number, xs: number[]) { xs.forEach((x) => x + v); }',
      verdict: 'unknown',
      sinks: ['repo-code: arithmetic +', 'unknown: function (captured or defaulted by a function)'],
    },
    {
      title: 'a push into a container of the caller is unknown',
      source: 'export function f(v: number, out: number[]) { out.push(v); }',
      verdict: 'unknown',
      sinks: [
        'pass-through: Array.push',
        'unknown: Array.push (stored into a container of the caller)',
      ],
    },
    {
      title: 'a push into a property container is unknown',
      source: 'export function f(v: number) { this.items.push(v); }',
      verdict: 'unknown',
      sinks: ['unknown: Array.push (stored into an untracked container)'],
    },
  ])('$title', ({ source, verdict, sinks }) => {
    const { results } = classify(source);
    expect({ verdict: verdictOf(sinksOf(results)), sinks: render(sinksOf(results)) }).toEqual({
      verdict,
      sinks,
    });
  });
});

describe('walkUp: the statement rule', () => {
  it('vetoes `if (path.extname(v) === ".ts")` on the opaque use although === is repo code', () => {
    const { results } = classify(
      "export function f(v: string) { if (path.extname(v) === '.ts') { return 1; } return 0; }",
    );
    const sinks = sinksOf(results);
    expect({ statement: statementClass(sinks), sinks: render(sinks) }).toEqual({
      statement: 'opaque',
      sinks: ['opaque: path.extname (library)'],
    });
  });

  it.each([
    {
      title: 'an opaque use outweighs a clean one',
      classes: ['repo-code', 'opaque'],
      worst: 'opaque',
    },
    {
      title: 'an unknown use outweighs a clean one',
      classes: ['table-read', 'unknown'],
      worst: 'unknown',
    },
    {
      title: 'an opaque use outweighs an unknown one',
      classes: ['unknown', 'opaque'],
      worst: 'opaque',
    },
    { title: 'clean uses stay clean', classes: ['repo-code', 'pass-through'], worst: 'repo-code' },
  ] as const)('$title', ({ classes, worst }) => {
    const sinks: Sink[] = classes.map((cls) => ({
      class: cls,
      what: cls,
      reason: '',
      location: { file: FILE, line: 1, column: 0 },
    }));
    expect(statementClass(sinks)).toBe(worst);
  });
});

describe('walkUp: derived bindings and storage', () => {
  it('walks `const { ratio } = opts` under the name ratio (KTD11 rule 3)', () => {
    const source =
      'export function f(opts: { ratio: number }) {\n  const { ratio } = opts;\n  return Math.round(ratio);\n}';
    const { results, ctx } = classify(source, 'opts');
    const derived = results.flatMap((result) => result.derived);
    const followed = derived.flatMap((entry) =>
      entry.binding.referencePaths.map((reference) => walkUp(reference, ctx, entry.kind)),
    );
    expect({
      derived: derived.map((entry) => [entry.name, entry.kind, entry.lines.start]),
      sinks: render(sinksOf(followed)),
      verdict: verdictOf(sinksOf([...results, ...followed])),
    }).toEqual({
      derived: [['ratio', 'value', 2]],
      sinks: ['opaque: Math.round (library)'],
      verdict: 'veto',
    });
  });

  it('classifies Map.set then Map.get into a comparison as storage and table read', () => {
    const source = [
      'export function f(v: number, k: string) {',
      '  const m = new Map<string, number>();',
      '  m.set(k, v);',
      '  if (m.get(k) > 3) { return 1; }',
      '  return 0;',
      '}',
    ].join('\n');
    const { results, ctx } = classify(source);
    const derived = results.flatMap((result) => result.derived);
    const readBack = derived.flatMap((entry) =>
      entry.binding.referencePaths
        .filter((reference) => (reference.node.loc?.start.line ?? 0) > 3)
        .map((reference) => walkUp(reference, ctx, entry.kind)),
    );
    const sinks = sinksOf([...results, ...readBack]);
    expect({
      derived: derived.map((entry) => [entry.name, entry.kind]),
      sinks: render(sinks),
      verdict: verdictOf(sinks),
    }).toEqual({
      derived: [['m', 'container']],
      sinks: ['pass-through: Map.set', 'table-read: Map.get read-back', 'repo-code: comparison >'],
      verdict: 'clean',
    });
  });

  it('records the repo call the walk descends into, with the argument position', () => {
    const { results } = classify('export function f(v: number) { return add(1, v); }');
    expect(
      results.flatMap((result) =>
        result.calls.map((call) => [call.callee.name, call.argIndex, call.call.node.type]),
      ),
    ).toEqual([['add', 1, 'CallExpression']]);
  });
});
