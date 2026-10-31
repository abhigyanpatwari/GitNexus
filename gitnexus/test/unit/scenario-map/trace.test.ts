/**
 * Locks the value-flow trace run (U11, R9, KTD11 "Trace", design §5.3a step 4) without spawning
 * Vitest: the documented wrap list and the mapping of U10's opaque-sink callees (storage reads
 * stay unwrapped); the safe, bounded serialisation of receivers and arguments; the call-site rule
 * (production frames only, engine-internal calls skipped); the recorder on in-process calls
 * through a sandbox object, never the real globals (per-test calls, receivers, arguments and
 * counts at the production call site, pass-through behaviour); the pure pair comparison
 * (`receiver-differs`, `args-differ`, `asymmetric-sites`, `asymmetric-counts`, and the
 * inconclusive reasons); the run-level validity that fails every pair closed (`trace-run-invalid`:
 * a baseline or traced run that did not end `survived`, an unhandled error, an outside-test
 * failure, an unwrapped entry or a recorder error); and the run's orchestration through an
 * injected `runVitest`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceFixtureRoots } from '../../../tools/scenario-map/value-flow/trace-fixtures.js';
import type { PrepareOptions, PrepareReport } from '../../../tools/mutation/prepare/prepare.js';
import type { OutcomeClass } from '../../../tools/mutation/runner/classify-outcome.js';
import { scriptPath } from '../../../tools/scenario-map/path-coverage/records.js';
import { buildRunManifest } from '../../../tools/scenario-map/mutation/run-group.js';
import type {
  VitestRunOptions,
  VitestRunResult,
} from '../../../tools/scenario-map/mutation/vitest-run.js';
import {
  BASE_WRAP_LIST,
  isStorageRead,
  wrapListOf,
  wrapTargetOfCallee,
  type WrapEntry,
} from '../../../tools/scenario-map/value-flow/builtins.js';
import {
  LONG_STRING,
  RAW_TRACE_SCHEMA_VERSION,
  SHORT_VALUE,
  TRACE_KEY,
  TraceRecorder,
  VALUE_NODE_BUDGET,
  callSiteOf,
  productionResolver,
  serializeValue,
  valueKey,
  writeRawTrace,
  type CurrentTest,
  type RawTestTrace,
  type RawTraceCall,
  type RawTraceRecord,
  type TraceContext,
  type TraceOverflow,
} from '../../../tools/scenario-map/value-flow/trace-records.js';
import {
  TRACE_SETUP_FILE,
  compareTracePair,
  runTrace,
  traceLayout,
  traceRunIssues,
  tracesOf,
  type TestTrace,
  type TraceRunDeps,
} from '../../../tools/scenario-map/value-flow/trace.js';

const SITE = 'gitnexus/src/x.ts:12:10';
const OTHER_SITE = 'gitnexus/src/x.ts:20:5';
const PACKAGE_FILE = 'test/unit/a.test.ts';
const A = `${PACKAGE_FILE}#d > a`;
const B = `${PACKAGE_FILE}#d > b`;

// ── Wrap list ──────────────────────────────────────────────────────────────

describe('wrap list', () => {
  it('wraps each documented group, prototype methods included', () => {
    const apis = new Set(BASE_WRAP_LIST.map((entry) => entry.api));
    expect(
      [
        'Math.round',
        'Math.max',
        'String.prototype.toUpperCase',
        'String.prototype.localeCompare',
        'String.prototype.normalize',
        'String.prototype.padStart',
        'String.prototype.replaceAll',
        'String.prototype.codePointAt',
        'String.prototype.repeat',
        'RegExp.prototype.test',
        'RegExp.prototype.exec',
        'String.prototype.match',
        'String.prototype.matchAll',
        'String.prototype.search',
        'parseInt',
        'parseFloat',
        'Number',
        'Number.prototype.toFixed',
        'Number.prototype.toPrecision',
        'Number.prototype.toString',
        'JSON.parse',
        'JSON.stringify',
        'Intl.NumberFormat',
        'Intl.Collator.prototype.compare',
        'Intl.DateTimeFormat.prototype.format',
        'Date',
        'Date.UTC',
        'Date.prototype.getUTCDate',
        'Date.prototype.setMonth',
        'Array.prototype.sort',
      ].filter((api) => !apis.has(api)),
    ).toEqual([]);
  });

  it('never wraps a storage or table read', () => {
    expect(BASE_WRAP_LIST.filter((entry) => isStorageRead(entry.api))).toEqual([]);
  });

  it('lists each api once, with the bound getters of Intl as getters', () => {
    const apis = BASE_WRAP_LIST.map((entry) => entry.api);
    expect(new Set(apis).size).toBe(apis.length);
    expect(
      BASE_WRAP_LIST.filter((entry) => entry.kind === 'bound-getter').map((entry) => entry.api),
    ).toEqual([
      'Intl.Collator.prototype.compare',
      'Intl.DateTimeFormat.prototype.format',
      'Intl.NumberFormat.prototype.format',
    ]);
  });

  it.each([
    ['String.trim', 'String.prototype.trim'],
    ['ReadonlyArray.join', 'Array.prototype.join'],
    ['NumberConstructor.isFinite', 'Number.isFinite'],
    ['DateConstructor.UTC', 'Date.UTC'],
    ['Math.max', 'Math.max'],
    ['__global.URL', 'URL'],
    ['parseInt', 'parseInt'],
    ['NumberFormat.format', 'Intl.NumberFormat.prototype.format'],
  ])('maps the opaque-sink callee %s to %s', (callee, api) => {
    expect(wrapTargetOfCallee(callee)).toMatchObject({
      kind: 'target',
      entry: { api, group: 'opaque-sink' },
    });
  });

  it.each([
    ['Map.set', 'storage read'],
    ['ReadonlySet.has', 'storage read'],
    ['WeakMap.get', 'storage read'],
    ['Array.push', 'storage read'],
    ['ReadonlyArray.unshift', 'storage read'],
    ['BaseLogger.warn', 'not a global built-in'],
    ['load', 'not a global built-in'],
  ])('skips the opaque-sink callee %s (%s)', (callee, reason) => {
    expect(wrapTargetOfCallee(callee)).toEqual({ kind: 'skip', callee, reason });
  });

  it('adds new opaque sinks once, after the base list, and lists the skipped ones', () => {
    const list = wrapListOf(['Array.join', 'String.trim', 'Array.join', 'Map.set', 'URL']);
    expect(list.added).toEqual(['Array.prototype.join', 'URL']);
    expect(list.skipped).toEqual([{ callee: 'Map.set', reason: 'storage read' }]);
    expect(list.entries.slice(BASE_WRAP_LIST.length).map((entry) => entry.api)).toEqual(list.added);
  });
});

// ── Serialisation ──────────────────────────────────────────────────────────

class Box {
  constructor(public readonly value: number) {}
}

const cyclic = (): Record<string, unknown> => {
  const node: Record<string, unknown> = { name: 'n' };
  node.self = node;
  return node;
};

const throwingGetter = (): object =>
  Object.defineProperty({ plain: 1 }, 'trap', {
    enumerable: true,
    get: (): never => {
      throw new Error('a getter ran');
    },
  });

describe('serializeValue', () => {
  it.each([
    ['a number', 2.4, '2.4'],
    ['negative zero', -0, '-0'],
    ['NaN', Number.NaN, 'NaN'],
    ['a bigint', 10n, '10n'],
    ['a string', 'José', '"José"'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['an argument list', [24, 'x', true], '[24,"x",true]'],
    ['a sparse array', [1, , 3], '[1,<hole>,3]'],
    ['a plain object', { a: 1, b: [2] }, '{"a":1,"b":[2]}'],
    ['a class instance', new Box(3), 'Box{"value":3}'],
    ['a date', new Date(0), 'Date(0)'],
    ['a regex with its lastIndex', /a|b/gi, '/a|b/gi@0'],
    ['a map', new Map([['k', 1]]), 'Map{"k"=>1}'],
    ['a set', new Set([1, 2]), 'Set{1,2}'],
    ['a function', function named(): void {}, '[Function named]'],
    ['a cycle', cyclic(), '{"name":"n","self":[Circular]}'],
    ['an accessor, without running it', throwingGetter(), '{"plain":1,"trap":<accessor>}'],
  ])('serialises %s completely', (_title, value, text) => {
    expect(serializeValue(value)).toEqual({ text, complete: true });
  });

  it('names known objects by token', () => {
    expect(serializeValue([Math], new Map<object, string>([[Math, 'Math']])).text).toBe('[[Math]]');
  });

  it('compares captured repository Dirents independently of their temporary root', async () => {
    const fs = await import('node:fs');
    const roots = [tempDir(), tempDir()];
    for (const root of roots) fs.writeFileSync(path.join(root, 'main.ts'), 'export const n = 1;');
    const entries = roots.map((root) => fs.readdirSync(root, { withFileTypes: true }));
    const names = new Map(roots.map((root) => [root.replace(/\\/g, '/'), 'fixture:0:same-bytes']));
    expect(serializeValue(entries[0], new Map(), names)).toEqual(
      serializeValue(entries[1], new Map(), names),
    );
    // Arbitrary strings and lookalike objects can be meaningful application inputs.
    expect(serializeValue(roots[0], new Map(), names)).not.toEqual(
      serializeValue(roots[1], new Map(), names),
    );
    expect(serializeValue({ parentPath: roots[0] }, new Map(), names)).not.toEqual(
      serializeValue({ parentPath: roots[1] }, new Map(), names),
    );
    expect(serializeValue(entries[0])).not.toEqual(serializeValue(entries[1]));
    names.set(roots[1].replace(/\\/g, '/'), 'fixture:0:different-bytes');
    expect(serializeValue(entries[0], new Map(), names)).not.toEqual(
      serializeValue(entries[1], new Map(), names),
    );
  });

  it('keeps fixture bytes, layout, aliases, and incomplete captures visible in trace identity', () => {
    const a = tempDir(),
      b = tempDir();
    for (const root of [a, b]) writeFileSync(path.join(root, 'main.ts'), 'export const n = 1;');
    const left = new TraceFixtureRoots(),
      right = new TraceFixtureRoots();
    left.capture(a);
    right.capture(b);
    const key = (roots: TraceFixtureRoots, root: string) =>
      roots.roots.get(root.replace(/\\/g, '/'));
    expect(key(left, a)).toBe(key(right, b));
    left.capture(b);
    expect(key(left, a)).not.toBe(key(left, b));
    writeFileSync(path.join(b, 'main.ts'), 'export const n = 2;');
    right.capture(b);
    expect(key(left, a)).not.toBe(key(right, b));
    writeFileSync(path.join(b, 'huge.ts'), 'x'.repeat(200_000));
    right.capture(b);
    expect(key(right, b)).toBeUndefined();
    left.clear();
    expect(left.roots.size).toBe(0);
  });

  it('serialises an Intl instance by its resolved options', () => {
    expect(serializeValue(new Intl.NumberFormat('en-US')).text).toMatch(
      /^Intl\.NumberFormat\(\{"locale":"en-US",/,
    );
  });

  it('digests a long string, equal for equal text and different otherwise', () => {
    const [a, b, c] = ['x'.repeat(LONG_STRING + 1), 'x'.repeat(LONG_STRING + 1), 'y'.repeat(300)];
    expect(serializeValue(a).text).toMatch(/^str\(201\)#[0-9a-f]{32}$/);
    expect(serializeValue(a).text).toBe(serializeValue(b).text);
    expect(serializeValue(a).text).not.toBe(serializeValue(c).text);
  });

  it.each([
    ['an array over the node budget', Array.from({ length: VALUE_NODE_BUDGET + 1 }, () => 0)],
    ['a proxy', new Proxy({}, {})],
    ['a nesting deeper than the limit', JSON.parse(`${'['.repeat(40)}${']'.repeat(40)}`)],
  ])('marks %s incomplete', (_title, value) => {
    expect(serializeValue(value).complete).toBe(false);
  });

  it('stores a long text as a digest plus a preview', () => {
    const text = `"${'z'.repeat(SHORT_VALUE)}"`;
    expect(valueKey('"short"')).toBe('"short"');
    expect(valueKey(text)).toMatch(/^#[0-9a-f]{32}\(402\) "z+…$/);
  });
});

// ── Call sites ─────────────────────────────────────────────────────────────

const PREPARED = '/work/trace/prepared';
const resolve = productionResolver(PREPARED, []);
const frame = (file: string | null): { file: string | null } => ({ file });

describe('call sites', () => {
  it.each([
    ['a production frame', [frame(`${PREPARED}/gitnexus/src/x.ts`)], false, 'gitnexus/src/x.ts'],
    [
      'an engine frame, then production',
      [frame(null), frame(`${PREPARED}/gitnexus/src/x.ts`)],
      false,
      'gitnexus/src/x.ts',
    ],
    [
      'an engine frame inside a wrapped built-in',
      [frame(null), frame(`${PREPARED}/gitnexus/src/x.ts`)],
      true,
      null,
    ],
    [
      'a callback frame inside a wrapped built-in',
      [frame(`${PREPARED}/gitnexus/src/x.ts`), frame(null)],
      true,
      'gitnexus/src/x.ts',
    ],
    [
      'a node_modules frame only',
      [frame('file:///repo/gitnexus/node_modules/lib/index.js')],
      false,
      null,
    ],
    [
      'a node_modules frame above a production frame',
      [frame(`${PREPARED}/gitnexus/node_modules/lib/a.js`), frame(`${PREPARED}/gitnexus/src/x.ts`)],
      false,
      null,
    ],
    ['a test frame', [frame(`${PREPARED}/gitnexus/test/unit/a.test.ts`)], false, null],
    ['no frame', [], false, null],
  ])('%s', (_title, frames, inside, repoPath) => {
    expect(callSiteOf(frames, inside, resolve)?.repoPath ?? null).toBe(repoPath);
  });

  it.each([
    [`${PREPARED}/gitnexus/src/core/a.ts`, 'gitnexus/src/core/a.ts'],
    [`file://${PREPARED}/gitnexus/src/core/a.ts`, 'gitnexus/src/core/a.ts'],
    [`${PREPARED}/gitnexus/relocated/gitnexus-shared/src/b.ts`, 'gitnexus-shared/src/b.ts'],
    [`${PREPARED}/gitnexus/src/core/a.test.ts`, null],
    [`${PREPARED}/gitnexus/tools/scenario-map/types.ts`, null],
    [`${PREPARED}/gitnexus/src/core/types.d.ts`, null],
    ['/elsewhere/gitnexus/src/a.ts', null],
    ['node:internal/x', null],
  ])('resolves the script %s to %s', (script, repoPath) => {
    expect(resolve(script)).toBe(repoPath);
  });

  it('accepts the src/ subtree of an extra root (controls mode)', () => {
    const fixture = 'gitnexus/test/fixtures/mutation-scenario-map';
    const controls = productionResolver(PREPARED, [fixture]);
    expect(controls(`${PREPARED}/${fixture}/src/math-round.ts`)).toBe(
      `${fixture}/src/math-round.ts`,
    );
    expect(controls(`${PREPARED}/${fixture}/math-round.case.ts`)).toBeNull();
  });
});

// ── Recorder ───────────────────────────────────────────────────────────────

const SELF = scriptPath(fileURLToPath(import.meta.url));

interface Sandbox {
  Math: { round: (value: number) => number };
  Number: {
    prototype: { toFixed: (this: number, digits?: number) => string };
    parseInt: (text: string, radix?: number) => number;
  };
  String: {
    prototype: { trimStart: (this: string) => string; trimLeft: (this: string) => string };
  };
  Map: { prototype: { set: Map<unknown, unknown>['set'] } };
  JSON: { stringify: (value: unknown) => string };
  Array: { prototype: { sort: <T>(this: T[], compare?: (a: T, b: T) => number) => T[] } };
  Intl: { NumberFormat: { prototype: object } };
  parseInt: (text: string, radix?: number) => number;
  Box: typeof Box;
}

const BOX_ENTRY: WrapEntry = {
  api: 'Box',
  owner: [],
  key: 'Box',
  kind: 'function',
  group: 'opaque-sink',
};

function sandboxOf(): Sandbox {
  const numberFormat = Object.create(null) as object;
  const format = Reflect.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format');
  Reflect.defineProperty(numberFormat, 'format', format ?? { value: undefined });
  return {
    Math: { round: Math.round },
    Number: { prototype: { toFixed: Number.prototype.toFixed }, parseInt },
    String: {
      prototype: { trimStart: String.prototype.trimStart, trimLeft: String.prototype.trimStart },
    },
    Map: { prototype: { set: Map.prototype.set } },
    JSON: { stringify: JSON.stringify },
    Array: { prototype: { sort: Array.prototype.sort } },
    Intl: { NumberFormat: { prototype: numberFormat } },
    parseInt,
    Box,
  };
}

interface Installed {
  sandbox: Sandbox;
  recorder: TraceRecorder;
  use: (id: string | null, concurrent?: boolean) => void;
  traceOf: (id: string) => RawTestTrace | undefined;
}

/** A recorder over a fresh sandbox, whose calls from this file count as `gitnexus/src/x.ts`. */
function installed(production: (script: string) => string | null = selfAsProduction): Installed {
  let current: CurrentTest | null = null;
  const recorder = new TraceRecorder({ currentTest: () => current, production });
  const sandbox = sandboxOf();
  recorder.install(sandbox, [...BASE_WRAP_LIST, BOX_ENTRY]);
  return {
    sandbox,
    recorder,
    use: (id, concurrent = false) => {
      current = id === null ? null : { id, concurrent };
    },
    traceOf: (id) => recorder.record('/x/a.test.ts').tests.find((test) => test.taskId === id),
  };
}

function selfAsProduction(script: string): string | null {
  return scriptPath(script) === SELF ? 'gitnexus/src/x.ts' : null;
}

// One call site each: every call through a helper shares the helper's site.
const roundAt = (sandbox: Sandbox, value: number): number => sandbox.Math.round(value);
const scaledFixed = (sandbox: Sandbox, stars: number): string =>
  sandbox.Number.prototype.toFixed.call(stars * 10, 1);
const otherFixed = (sandbox: Sandbox, value: number): string =>
  sandbox.Number.prototype.toFixed.call(value, 2);

const toTestTrace = (id: string, raw: RawTestTrace | undefined): TestTrace => ({
  id,
  baseline: 'survived',
  traced: 'survived',
  recorded: raw !== undefined,
  concurrent: raw?.concurrent ?? false,
  overflow: raw?.overflow ?? [],
  calls: raw?.calls ?? [],
});

/** The sandbox's (wrapped) `format` getter read on `nf`. */
const boundFormat = (sandbox: Sandbox, nf: Intl.NumberFormat): unknown =>
  Reflect.getOwnPropertyDescriptor(sandbox.Intl.NumberFormat.prototype, 'format')?.get?.call(nf);

const callBound = (format: unknown, value: number): unknown =>
  typeof format === 'function' ? Reflect.apply(format, undefined, [value]) : null;

const messageOf = (run: () => unknown): string => {
  try {
    run();
    return 'no error';
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : 'non-error';
  }
};

describe('TraceRecorder', () => {
  it('records the receiver, arguments and count per test at the production call site', () => {
    const { sandbox, use, traceOf } = installed();
    use('a');
    roundAt(sandbox, 2.4);
    roundAt(sandbox, 2.4);
    use('b');
    roundAt(sandbox, 2.5);
    const [a, b] = [traceOf('a'), traceOf('b')];
    expect(a?.calls).toEqual([
      {
        site: expect.stringMatching(/^gitnexus\/src\/x\.ts:\d+:\d+$/),
        api: 'Math.round',
        receiver: '[Math]',
        args: '[2.4]',
        count: 2,
      },
    ]);
    expect(b?.calls.map((call) => [call.args, call.count])).toEqual([['[2.5]', 1]]);
    expect(b?.calls[0].site).toBe(a?.calls[0].site);
  });

  it('vetoes Math.round reached with 2.4 and 2.5', () => {
    const { sandbox, use, traceOf } = installed();
    use('a');
    roundAt(sandbox, 2.4);
    use('b');
    roundAt(sandbox, 2.5);
    const pair = compareTracePair(toTestTrace('a', traceOf('a')), toTestTrace('b', traceOf('b')));
    expect([pair.status, pair.reasons]).toEqual(['veto', ['args-differ']]);
  });

  it('vetoes the derived receivers 24 and 25 of toFixed with equal arguments', () => {
    const { sandbox, use, traceOf } = installed();
    use('a');
    scaledFixed(sandbox, 2.4);
    use('b');
    scaledFixed(sandbox, 2.5);
    const pair = compareTracePair(toTestTrace('a', traceOf('a')), toTestTrace('b', traceOf('b')));
    expect(traceOf('a')?.calls.map((call) => [call.api, call.receiver, call.args])).toEqual([
      ['Number.prototype.toFixed', '24', '[1]'],
    ]);
    expect([pair.status, pair.reasons]).toEqual(['veto', ['receiver-differs']]);
  });

  it('keeps identical traces clean and tells a second site apart', () => {
    const { sandbox, use, traceOf } = installed();
    use('a');
    scaledFixed(sandbox, 2.4);
    use('b');
    scaledFixed(sandbox, 2.4);
    use('c');
    scaledFixed(sandbox, 2.4);
    otherFixed(sandbox, 2.4);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => toTestTrace(id, traceOf(id)));
    expect(compareTracePair(a, b).status).toBe('clean');
    expect(compareTracePair(a, c).reasons).toEqual(['asymmetric-sites']);
  });

  it('records nothing outside a test or from a frame that is not production', () => {
    const outside = installed();
    outside.use(null);
    roundAt(outside.sandbox, 1.5);
    const foreign = installed(() => null);
    foreign.use('a');
    roundAt(foreign.sandbox, 1.5);
    expect(outside.recorder.record('/x/a.test.ts').tests).toEqual([]);
    expect(foreign.traceOf('a')).toBeUndefined();
  });

  it('never wraps or records Map.prototype.set', () => {
    const { sandbox, use, traceOf } = installed();
    use('a');
    Reflect.apply(sandbox.Map.prototype.set, new Map(), ['k', 1]);
    expect(sandbox.Map.prototype.set).toBe(Map.prototype.set);
    expect(traceOf('a')).toBeUndefined();
  });

  it('records a callback that runs inside a wrapped built-in at its own site', () => {
    const { sandbox, use, traceOf } = installed();
    use('a');
    sandbox.Array.prototype.sort.call(
      [3.2, 1.6],
      (x, y) => roundAt(sandbox, x) - roundAt(sandbox, y),
    );
    expect(
      traceOf('a')
        ?.calls.map((call) => call.api)
        .sort(),
    ).toEqual(['Array.prototype.sort', 'Math.round', 'Math.round']);
  });

  it('starts a test over on each attempt and flags a concurrent test', () => {
    const { sandbox, recorder, use, traceOf } = installed();
    use('a');
    recorder.testStarted({ id: 'a', concurrent: false });
    roundAt(sandbox, 1);
    recorder.testStarted({ id: 'a', concurrent: false });
    roundAt(sandbox, 2);
    use('b', true);
    roundAt(sandbox, 3);
    expect(traceOf('a')).toMatchObject({ attempts: 2, calls: [{ args: '[2]', count: 1 }] });
    expect(traceOf('b')?.concurrent).toBe(true);
  });

  it('marks a test whose argument is over budget incomplete', () => {
    const { sandbox, use, traceOf } = installed();
    use('a');
    sandbox.JSON.stringify(Array.from({ length: VALUE_NODE_BUDGET + 1 }, () => 0));
    expect(traceOf('a')?.overflow).toEqual(['value']);
  });

  it('gives aliases the same wrapper and keeps one wrapper per bound Intl function', () => {
    const { sandbox, use, traceOf } = installed();
    const nf = new Intl.NumberFormat('en-US');
    const format = boundFormat(sandbox, nf);
    use('a');
    const text = callBound(format, 1234.5);
    expect(sandbox.String.prototype.trimLeft).toBe(sandbox.String.prototype.trimStart);
    expect(sandbox.Number.parseInt).toBe(sandbox.parseInt);
    expect(boundFormat(sandbox, nf)).toBe(format);
    expect(text).toBe(nf.format(1234.5));
    expect(traceOf('a')?.calls.map((call) => [call.api, call.receiver, call.args])).toEqual([
      [
        'Intl.NumberFormat.prototype.format',
        expect.stringMatching(/^Intl\.NumberFormat\(\{"locale":"en-US",/),
        '[1234.5]',
      ],
    ]);
  });

  it.each([
    ['Math.round', (s: Sandbox) => s.Math.round(2.5), () => Math.round(2.5)],
    ['toFixed', (s: Sandbox) => s.Number.prototype.toFixed.call(24, 1), () => (24).toFixed(1)],
    [
      'trimStart',
      (s: Sandbox) => s.String.prototype.trimStart.call('  x'),
      () => '  x'.trimStart(),
    ],
    ['parseInt', (s: Sandbox) => s.parseInt('17', 8), () => parseInt('17', 8)],
    [
      'JSON.stringify',
      (s: Sandbox) => s.JSON.stringify({ a: [1] }),
      () => JSON.stringify({ a: [1] }),
    ],
    ['new on a constructor', (s: Sandbox) => new s.Box(4).value, () => new Box(4).value],
  ])('passes %s through unchanged', (_title, wrapped, original) => {
    const { sandbox, use } = installed();
    use('a');
    expect(wrapped(sandbox)).toEqual(original());
  });

  it('keeps errors, instanceof, name, length and the native source text', () => {
    const { sandbox, use } = installed();
    use('a');
    const wrapped = sandbox.Number.prototype.toFixed;
    expect(messageOf(() => wrapped.call(1, 101))).toBe(messageOf(() => (1).toFixed(101)));
    expect(new sandbox.Box(1)).toBeInstanceOf(Box);
    expect([wrapped.name, wrapped.length]).toEqual(['toFixed', 1]);
    expect(Function.prototype.toString.call(sandbox.Math.round)).toContain('[native code]');
  });

  it('records a new call with a constructor receiver', () => {
    const { sandbox, use, traceOf } = installed();
    use('a');
    new sandbox.Box(7);
    expect(traceOf('a')?.calls.map((call) => [call.api, call.receiver, call.args])).toEqual([
      ['Box', '<new Box>', '[7]'],
    ]);
  });
});

// ── Comparison ─────────────────────────────────────────────────────────────

const call = (
  api: string,
  site: string,
  receiver: string,
  args: string,
  count = 1,
): RawTraceCall => ({ site, api, receiver, args, count });

/** Overrides of a {@link TestTrace}; readonly so `as const` tables fit. */
type TraceExtra = Readonly<Partial<Omit<TestTrace, 'overflow'>>> & {
  readonly overflow?: readonly TraceOverflow[];
};

const trace = (id: string, calls: RawTraceCall[], extra: TraceExtra = {}): TestTrace => ({
  id,
  baseline: 'survived',
  traced: 'survived',
  recorded: true,
  concurrent: false,
  calls,
  ...extra,
  overflow: [...(extra.overflow ?? [])],
});

const ROUND = (args: string, count = 1): RawTraceCall =>
  call('Math.round', SITE, '[Math]', args, count);
const FIXED = (receiver: string, site = OTHER_SITE): RawTraceCall =>
  call('Number.prototype.toFixed', site, receiver, '[1]');

describe('compareTracePair', () => {
  it.each([
    [
      'Math.round reached with 2.4 and 2.5',
      [ROUND('[2.4]')],
      [ROUND('[2.5]')],
      {},
      'veto',
      ['args-differ'],
    ],
    ['the same site with equal arguments', [ROUND('[2.4]')], [ROUND('[2.4]')], {}, 'clean', []],
    [
      'toFixed reached with receivers 24 and 25',
      [FIXED('24')],
      [FIXED('25')],
      {},
      'veto',
      ['receiver-differs'],
    ],
    [
      'identical traces over several sites',
      [ROUND('[2]'), FIXED('20')],
      [ROUND('[2]'), FIXED('20')],
      {},
      'clean',
      [],
    ],
    [
      'toFixed at a site test B never reaches',
      [ROUND('[2]'), FIXED('20')],
      [ROUND('[2]')],
      {},
      'veto',
      ['asymmetric-sites'],
    ],
    [
      'a site A calls twice and B once',
      [ROUND('[2]', 2)],
      [ROUND('[2]')],
      {},
      'veto',
      ['asymmetric-counts'],
    ],
    [
      'the same values used a different number of times',
      [ROUND('[1]', 2), ROUND('[2]')],
      [ROUND('[1]'), ROUND('[2]', 2)],
      {},
      'veto',
      ['asymmetric-counts'],
    ],
    [
      'the same receivers and arguments paired differently',
      [FIXED('1', SITE), call('Number.prototype.toFixed', SITE, '2', '[2]')],
      [
        call('Number.prototype.toFixed', SITE, '1', '[2]'),
        call('Number.prototype.toFixed', SITE, '2', '[1]'),
      ],
      {},
      'veto',
      ['args-differ'],
    ],
    [
      'a test that passes at baseline and fails under tracing',
      [ROUND('[2]')],
      [ROUND('[2]')],
      { traced: 'killed-by-test:assertion' },
      'inconclusive',
      ['trace-changed-outcome'],
    ],
    ['a test without a record', [], [], { recorded: false }, 'inconclusive', ['trace-missing']],
    [
      'a test that did not run',
      [],
      [],
      { baseline: null, traced: null },
      'inconclusive',
      ['trace-missing'],
    ],
    ['a concurrent test', [], [], { concurrent: true }, 'inconclusive', ['trace-unattributable']],
    ['an incomplete trace', [], [], { overflow: ['calls'] }, 'inconclusive', ['trace-overflow']],
    [
      'differing arguments and a changed outcome',
      [ROUND('[2.4]')],
      [ROUND('[2.5]')],
      { traced: 'killed-by-test:runtime' },
      'inconclusive',
      ['args-differ', 'trace-changed-outcome'],
    ],
  ] as const)('%s', (_title, callsA, callsB, extraB, status, reasons) => {
    const pair = compareTracePair(trace(A, [...callsA]), trace(B, [...callsB], extraB));
    expect([pair.status, pair.reasons]).toEqual([status, reasons]);
  });

  it.each([
    ['a clean pair', [ROUND('[2]')], [ROUND('[2]')], ['trace-run-invalid']],
    [
      'a vetoed pair, its veto reasons kept',
      [ROUND('[2.4]')],
      [ROUND('[2.5]')],
      ['args-differ', 'trace-run-invalid'],
    ],
  ] as const)(
    'makes %s inconclusive when the run is invalid',
    (_title, callsA, callsB, reasons) => {
      const pair = compareTracePair(trace(A, [...callsA]), trace(B, [...callsB]), [
        'traced run error/infrastructure',
      ]);
      expect([pair.status, pair.reasons]).toEqual(['inconclusive', reasons]);
    },
  );

  it('reports the differing site with both sides', () => {
    const pair = compareTracePair(trace(A, [FIXED('24')]), trace(B, [FIXED('25'), ROUND('[1]')]));
    expect(pair.sharedSites).toBe(1);
    expect(pair.differences).toEqual([
      {
        site: SITE,
        api: 'Math.round',
        reasons: ['asymmetric-sites'],
        a: null,
        b: { count: 1, receivers: ['[Math]'], args: ['[1]'] },
      },
      {
        site: OTHER_SITE,
        api: 'Number.prototype.toFixed',
        reasons: ['receiver-differs'],
        a: { count: 1, receivers: ['24'], args: ['[1]'] },
        b: { count: 1, receivers: ['25'], args: ['[1]'] },
      },
    ]);
  });
});

// ── Join and run ───────────────────────────────────────────────────────────

const PACKAGE_DIR = '/work/trace/prepared/gitnexus';

function vitestResult(
  outcomes: readonly [OutcomeClass | null, OutcomeClass | null],
  wallClockMs = 100,
): VitestRunResult {
  return {
    tests: [A, B].map((id, index) => ({
      id,
      taskId: `t_${index}`,
      fullName: id.split('#')[1],
      location: { line: index + 1, column: 3 },
      state:
        outcomes[index] === null ? 'missing' : outcomes[index] === 'survived' ? 'passed' : 'failed',
      outcome: outcomes[index],
      message: null,
    })),
    status: 'survived',
    outcome: 'survived',
    reason: null,
    outsideTest: [],
    problems: [],
    unhandledErrors: [],
    wallClockMs,
  };
}

const rawRecord = (
  packageDir: string,
  tests: RawTestTrace[],
  extra: Partial<Pick<RawTraceRecord, 'unavailable' | 'errors'>> = {},
): RawTraceRecord => ({
  schemaVersion: RAW_TRACE_SCHEMA_VERSION,
  file: `${packageDir}/${PACKAGE_FILE}`,
  wrapped: ['Math.round'],
  unavailable: [],
  errors: [],
  tests,
  ...extra,
});

const rawTest = (taskId: string, calls: RawTraceCall[]): RawTestTrace => ({
  taskId,
  concurrent: false,
  attempts: 1,
  overflow: [],
  calls,
});

describe('traceRunIssues', () => {
  it('finds nothing in two survived runs without wrap problems', () => {
    const run = vitestResult(['survived', 'survived']);
    expect(
      traceRunIssues({ baseline: run, traced: run, wrap: { unavailable: [], errors: [] } }),
    ).toEqual([]);
  });

  it('fails a run with a selection problem and a failing test closed', () => {
    const baseline: VitestRunResult = {
      ...vitestResult(['survived', null]),
      status: 'error',
      outcome: 'invalid',
      reason: 'requested test was not collected',
      problems: ['requested test "b" was not collected'],
    };
    const traced: VitestRunResult = {
      ...vitestResult(['survived', 'killed-by-test:assertion']),
      status: 'killed',
      outcome: 'killed-by-test:assertion',
    };
    expect(traceRunIssues({ baseline, traced, wrap: { unavailable: [], errors: [] } })).toEqual([
      'baseline run error/invalid: requested test was not collected',
      'baseline run: requested test "b" was not collected',
      'traced run killed/killed-by-test:assertion',
    ]);
  });
});

describe('tracesOf', () => {
  it('makes a pair inconclusive when a test passes at baseline and fails under tracing', () => {
    const tests = tracesOf({
      ids: [A, B],
      baseline: vitestResult(['survived', 'survived']),
      traced: vitestResult(['survived', 'killed-by-test:assertion']),
      records: [rawRecord(PACKAGE_DIR, [rawTest('t_0', []), rawTest('t_1', [])])],
      packageDir: PACKAGE_DIR,
    });
    const pair = compareTracePair(tests[0], tests[1]);
    expect([pair.status, pair.reasons]).toEqual(['inconclusive', ['trace-changed-outcome']]);
  });

  it('joins the calls by file and task id, and marks a test without a record missing', () => {
    const tests = tracesOf({
      ids: [A, B],
      baseline: vitestResult(['survived', 'survived']),
      traced: vitestResult(['survived', 'survived']),
      records: [rawRecord(PACKAGE_DIR, [rawTest('t_0', [ROUND('[2]')])])],
      packageDir: PACKAGE_DIR,
    });
    expect(tests.map((test) => [test.id, test.recorded, test.calls.length])).toEqual([
      [A, true, 1],
      [B, false, 0],
    ]);
  });
});

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scenario-trace-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeTree(root: string, extra: string): void {
  const files: Record<string, string> = {
    'gitnexus/node_modules/vitest/package.json': JSON.stringify({ version: '5.0.5' }),
    'gitnexus/node_modules/@stryker-mutator/core/package.json': JSON.stringify({
      version: '10.0.0',
    }),
    'gitnexus/src/x.ts': `export const x = 1;\n${extra}`,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

interface FakeRun {
  deps: TraceRunDeps;
  calls: VitestRunOptions[];
  provided: [string, unknown][];
}

interface FakeRunOptions {
  /** The prepared copy differs from the run manifest. */
  foreignCopy?: boolean;
  /** Run-level overrides of the baseline and the traced run. */
  baseline?: Partial<VitestRunResult>;
  traced?: Partial<VitestRunResult>;
  /** Unwrapped entries and recorder errors of the raw record. */
  record?: Partial<Pick<RawTraceRecord, 'unavailable' | 'errors'>>;
}

const isTraceContext = (value: unknown): value is TraceContext =>
  typeof value === 'object' && value !== null && 'outDir' in value && 'wrap' in value;

const lastWrappedApi = (context: unknown): string | null =>
  isTraceContext(context) ? (context.wrap.at(-1)?.api ?? null) : null;

/** Fake runs: the traced one writes the given calls for A and B through the provided context. */
function fakeRun(
  callsA: RawTraceCall[],
  callsB: RawTraceCall[],
  world: FakeRunOptions = {},
): FakeRun {
  const calls: VitestRunOptions[] = [];
  const provided: [string, unknown][] = [];
  let clock = 0;
  const deps: TraceRunDeps = {
    prepare: (options: PrepareOptions): PrepareReport => {
      writeTree(options.outDir, world.foreignCopy === true ? '// changed\n' : '');
      return {
        version: 1,
        repoRoot: options.repoRoot,
        outDir: options.outDir,
        packageDir: path.join(options.outDir, 'gitnexus'),
        relocatedShared: '',
        pathMap: [],
        copiedFiles: 3,
        blanked: [],
        failed: [],
      };
    },
    runVitest: async (options: VitestRunOptions): Promise<VitestRunResult> => {
      calls.push(options);
      options.provide?.({
        provide: (key: string, value: unknown): void => void provided.push([key, value]),
      });
      const context = provided.map(([, value]) => value).find(isTraceContext);
      const records =
        context === undefined
          ? []
          : [
              rawRecord(
                options.packageDir,
                [rawTest('t_0', callsA), rawTest('t_1', callsB)],
                world.record,
              ),
            ];
      for (const record of records)
        writeRawTrace(context?.outDir ?? '', 'trace-1-a-a.test.ts.json', record);
      const first = calls.length === 1;
      return {
        ...vitestResult(['survived', 'survived'], first ? 100 : 150),
        ...(first ? world.baseline : world.traced),
      };
    },
    now: () => (clock += 1000),
  };
  return { deps, calls, provided };
}

async function runWith(
  fake: FakeRun,
  opaqueCallees: readonly string[] = [],
  maxWorkers: number | undefined = undefined,
) {
  const manifestRoot = tempDir();
  writeTree(manifestRoot, '');
  const manifest = buildRunManifest({
    preparedRoot: manifestRoot,
    mode: { kind: 'normal' },
    tests: [A, B],
  });
  const workDir = tempDir();
  const result = await runTrace(
    { repoRoot: tempDir(), workDir, manifest, pairs: [{ a: A, b: B }], opaqueCallees, maxWorkers },
    fake.deps,
  );
  return { result, workDir };
}

describe('runTrace', () => {
  it('retains failed-test diagnostics while keeping an invalid run inconclusive', async () => {
    const baseline: VitestRunResult = {
      ...vitestResult(['killed-by-test:assertion', 'survived']),
      status: 'killed',
      outcome: 'killed-by-test:assertion',
    };
    baseline.tests[0].message = 'expected an existing index';
    const { result } = await runWith(fakeRun([], [], { baseline }));
    expect(result.baseline?.failures).toEqual([
      { id: A, outcome: 'killed-by-test:assertion', message: 'expected an existing index' },
    ]);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.pairs[0].status).toBe('inconclusive');
  });

  it('runs sibling tests in both passes while comparing only the candidate tests', async () => {
    const manifestRoot = tempDir();
    writeTree(manifestRoot, '');
    const sibling = `${PACKAGE_FILE}#suite setup in an earlier test`;
    const baseline = vitestResult(['survived', 'survived']);
    baseline.tests.push({
      ...baseline.tests[0],
      id: sibling,
      taskId: 'sibling-task',
      fullName: 'suite setup in an earlier test',
    });
    const fake = fakeRun([ROUND('[2]')], [ROUND('[2]')], { baseline });
    const skipped = `${PACKAGE_FILE}#platform-specific test`;
    const unrelated = 'test/unit/unrelated.test.ts#unrelated';
    const manifest = buildRunManifest({
      preparedRoot: manifestRoot,
      mode: { kind: 'normal' },
      tests: [A, B, sibling, skipped, unrelated],
    });
    const result = await runTrace(
      {
        repoRoot: tempDir(),
        workDir: tempDir(),
        manifest,
        pairs: [{ a: A, b: B }],
        // A candidate erroneously marked skipped must still fail closed if it does not run.
        skippedTestIds: [skipped, A],
        opaqueCallees: [],
      },
      fake.deps,
    );
    expect(fake.calls.map((call) => [...call.testIds].sort())).toEqual([
      [A, B, sibling].sort(),
      [A, B, sibling].sort(),
    ]);
    expect(result.tests.map((test) => test.id)).toEqual([A, B]);
    expect(result.pairs.map((pair) => pair.status)).toEqual(['clean']);
    expect(fake.provided.find(([key]) => key === TRACE_KEY)?.[1]).toMatchObject({
      taskIds: ['t_0', 't_1'],
    });
  });

  it('runs a baseline and a traced run of the same tests and vetoes differing calls', async () => {
    const fake = fakeRun([ROUND('[2.4]')], [ROUND('[2.5]')]);
    const { result, workDir } = await runWith(fake, ['Array.join', 'Map.set']);
    const context = fake.provided.find(([key]) => key === TRACE_KEY)?.[1];
    expect(fake.calls.map((options) => [options.testIds, options.setupFiles ?? []])).toEqual([
      [[A, B], []],
      [[A, B], [TRACE_SETUP_FILE]],
    ]);
    expect(context).toMatchObject({ outDir: traceLayout(workDir).rawDir, extraRoots: [] });
    expect(lastWrappedApi(context)).toBe('Array.prototype.join');
    expect(result).toMatchObject({
      status: 'ran',
      overhead: 1.5,
      wrap: {
        added: ['Array.prototype.join'],
        skipped: [{ callee: 'Map.set', reason: 'storage read' }],
        unavailable: [],
        errors: [],
      },
      issues: [],
    });
    expect(result.pairs.map((pair) => [pair.status, pair.reasons])).toEqual([
      ['veto', ['args-differ']],
    ]);
  });

  it('bounds the baseline and the traced run by the worker bound it is given', async () => {
    const fake = fakeRun([ROUND('[2]')], [ROUND('[2]')]);
    await runWith(fake, [], 3);
    expect(fake.calls.map((options) => options.maxWorkers)).toEqual([3, 3]);
  });

  it('keeps identical traces of a valid run clean', async () => {
    const { result } = await runWith(fakeRun([ROUND('[2]')], [ROUND('[2]')]));
    expect([result.issues, result.pairs.map((pair) => [pair.status, pair.reasons])]).toEqual([
      [],
      [['clean', []]],
    ]);
  });

  it.each([
    [
      'a traced run with an unhandled error (infrastructure)',
      {
        traced: {
          status: 'error',
          outcome: 'infrastructure',
          reason: 'unhandled error during the run: Error: boom',
          unhandledErrors: ['Error: boom'],
        },
      },
      [
        'traced run error/infrastructure: unhandled error during the run: Error: boom',
        'traced run: unhandled error: Error: boom',
      ],
    ],
    [
      'a traced run whose selected tests use retry (inconclusive)',
      {
        traced: {
          status: 'error',
          outcome: 'inconclusive',
          reason: 'selected tests use retry: d > a',
        },
      },
      ['traced run error/inconclusive: selected tests use retry: d > a'],
    ],
    [
      'a baseline with a failure outside any test',
      {
        baseline: {
          status: 'killed',
          outcome: 'killed-outside-test:hook',
          outsideTest: [
            {
              file: PACKAGE_FILE,
              suiteTaskId: undefined,
              outcome: 'killed-outside-test:hook',
              attributedTo: [],
              message: 'afterAll failed',
            },
          ],
        },
      },
      [
        'baseline run killed/killed-outside-test:hook',
        `baseline run: killed-outside-test:hook outside a test in ${PACKAGE_FILE}`,
      ],
    ],
    [
      'a wrap-list entry a worker could not wrap',
      { record: { unavailable: [{ api: 'Intl.DisplayNames', reason: 'missing' }] } },
      ['not wrapped: Intl.DisplayNames (missing)'],
    ],
    [
      'a recorder error outside any test',
      { record: { errors: ['TypeError: no stack'] } },
      ['trace error: TypeError: no stack'],
    ],
  ] as const satisfies readonly (readonly [string, FakeRunOptions, readonly string[]])[])(
    'makes every pair inconclusive after %s',
    async (_title, world, issues) => {
      const { result } = await runWith(fakeRun([ROUND('[2]')], [ROUND('[2]')], world));
      expect([
        result.status,
        result.issues,
        result.pairs.map((pair) => [pair.status, pair.reasons]),
      ]).toEqual(['ran', issues, [['inconclusive', ['trace-run-invalid']]]]);
    },
  );

  it('runs nothing when the copy does not match the run manifest', async () => {
    const fake = fakeRun([], [], { foreignCopy: true });
    const { result } = await runWith(fake);
    expect(fake.calls).toEqual([]);
    expect([
      result.status,
      result.detail?.startsWith('manifest mismatch: changed: gitnexus/src/x.ts'),
    ]).toEqual(['not-run', true]);
    expect(result.pairs.map((pair) => [pair.status, pair.reasons])).toEqual([
      ['inconclusive', ['trace-not-run']],
    ]);
  });
});
