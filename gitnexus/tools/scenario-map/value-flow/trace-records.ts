/**
 * Worker side of the value-flow trace (U11, R9, KTD11 "Trace", design §5.3a step 4): the recorder
 * trace.setup.ts installs, the raw per-file record it writes, and the pure pieces they are built
 * from. trace.ts reads the records and compares them per pair.
 *
 *  - {@link TraceRecorder.install} replaces each wrap-list entry (builtins.ts) on a root object
 *    (the global object in the worker; a sandbox object in unit tests) by a pass-through proxy:
 *    `Reflect.apply`/`Reflect.construct` on the original with the caller's receiver, arguments
 *    and `new.target`, so results, exceptions, `name`, `length`, own properties and the
 *    `[native code]` text of `Function.prototype.toString` are unchanged. A bound-function getter
 *    (the `Intl` `format`/`compare`) returns one wrapper per bound function, so its identity per
 *    instance holds. Aliases (builtins.ts `ALIAS_OWNERS`) share the wrapper. Nothing is restored.
 *  - Each call, while a test is current (the injected {@link CurrentTest}, from
 *    `TestRunner.getCurrentTest()` in the worker), captures V8's structured stack below the proxy
 *    and picks the call site with {@link callSiteOf}: the first frame with a script (engine
 *    frames such as `Array.map` are skipped) must be a production file (KTD7, through the injected
 *    resolver: {@link productionResolver} maps the prepared copy back through the path map). A
 *    call made by library code (`node_modules`), test code or tooling is ignored, and so is a
 *    call the engine makes itself while another wrapped built-in runs (the `exec` calls of
 *    `replace`, the `toJSON` call of `JSON.stringify`); a callback that runs inside one (a sort
 *    comparator) is recorded at its own site. The site is `<repo path>:<line>:<column>`, mapped
 *    to the source by the worker's `Error.prepareStackTrace` (Vitest's source-map support) when
 *    there is one, else the generated position.
 *  - The receiver (`this`; `<new Name>` for a `new` call; `[Math]`-style tokens for the global
 *    object and the wrapped owners) and the argument list are serialised by {@link serializeValue}:
 *    canonical text without running user code (no getter, `toJSON`, `toString` or proxy trap is
 *    invoked; accessors print as `<accessor>`), strings over {@link LONG_STRING} characters as a
 *    digest, and texts over {@link SHORT_VALUE} characters as a digest plus a preview. A value
 *    over the node or depth budget, or holding a proxy, marks the test's trace incomplete
 *    (`value`), never equal. Private fields and closure state are not visible (accepted limit).
 *  - Calls aggregate per test into `(site, api, receiver, args) → count`; past
 *    {@link TEST_CALL_BUDGET} distinct keys the trace is incomplete (`calls`). A recorder error is
 *    swallowed, never thrown into the test, and marks the test (`recorder`). Each attempt
 *    (repeat or retry, {@link TraceRecorder.testStarted}) starts over: the last attempt counts.
 *
 * Self-contained: node builtins plus the path map and the production predicate, so the worker
 * loads nothing heavy before the test file.
 */
import { createHash } from 'node:crypto';
import { Dirent, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import { buildPathMap, toRepoPath } from '../../mutation/prepare/path-map.js';
import { scriptPath } from '../path-coverage/records.js';
import { productionFilePredicate } from '../types.js';
import { ALIAS_OWNERS, type WrapEntry } from './builtins.js';

/** provide/inject key of the hook's context (trace.ts provides it). */
export const TRACE_KEY = 'gitnexusScenarioTrace';
export const RAW_TRACE_SCHEMA_VERSION = 1;
/** File name prefix of the raw records in {@link TraceContext.outDir}. */
export const RAW_TRACE_PREFIX = 'trace-';

/** Strings longer than this serialise as a digest. */
export const LONG_STRING = 200;
/** Canonical texts longer than this are stored as a digest plus a preview. */
export const SHORT_VALUE = 400;
/** Objects, array items and map entries one value may visit. */
export const VALUE_NODE_BUDGET = 10_000;
/** Deepest nesting serialised. */
export const VALUE_DEPTH_LIMIT = 32;
/** Distinct `(site, api, receiver, args)` keys one test may record. */
export const TEST_CALL_BUDGET = 20_000;
/** Stack frames captured per call: enough to pass engine frames, cheap to take. */
export const FRAME_LIMIT = 12;
const MAX_ERRORS = 20;
const PREVIEW = 120;

export interface TraceContext {
  /** Absolute directory the raw records are written to. */
  outDir: string;
  /** Absolute POSIX prepared root (holding `gitnexus/`), as the workers see it. */
  preparedRoot: string;
  /** Extra path-map roots (controls mode). */
  extraRoots: string[];
  /** The wrap list (builtins.ts `wrapListOf`). */
  wrap: WrapEntry[];
}

declare module 'vitest' {
  interface ProvidedContext {
    gitnexusScenarioTrace: TraceContext;
  }
}

// ── Records ────────────────────────────────────────────────────────────────

export interface RawTraceCall {
  /** `<repo path>:<line>:<column>` of the production frame that made the call. */
  site: string;
  /** The wrapped api ({@link WrapEntry.api}). */
  api: string;
  /** Serialised receiver ({@link valueKey}). */
  receiver: string;
  /** Serialised argument list ({@link valueKey}). */
  args: string;
  count: number;
}

/** Why a test's trace is incomplete. */
export type TraceOverflow = 'value' | 'calls' | 'recorder';

export interface RawTestTrace {
  taskId: string;
  /** The task ran concurrently: the current test does not attribute its calls. */
  concurrent: boolean;
  /** Attempts seen (repeats and retries); the calls are the last one's. */
  attempts: number;
  /** Sorted; empty when the trace is complete. */
  overflow: TraceOverflow[];
  /** Sorted by site, api, receiver, args. */
  calls: RawTraceCall[];
}

/** One test file's raw record, written by trace.setup.ts when the file's run ends. */
export interface RawTraceRecord {
  schemaVersion: typeof RAW_TRACE_SCHEMA_VERSION;
  /** Absolute POSIX test file path. */
  file: string;
  /** Apis wrapped in this worker, in wrap-list order. */
  wrapped: string[];
  /** Wrap-list entries that could not be wrapped here (missing, not a function, frozen). */
  unavailable: { api: string; reason: string }[];
  /** Recorder errors, first {@link MAX_ERRORS}. */
  errors: string[];
  tests: RawTestTrace[];
}

// ── Values ─────────────────────────────────────────────────────────────────

/** A function value, called through `Reflect.apply`. */
export type Callable = (this: unknown, ...args: unknown[]) => unknown;

const isCallable = (value: unknown): value is Callable => typeof value === 'function';
const isObjectLike = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

// Originals captured when this module loads, before anything is wrapped.
const quote = JSON.stringify;
const dateGetTime = Date.prototype.getTime;
const mapForEach = Map.prototype.forEach;
const setForEach = Set.prototype.forEach;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const booleanValueOf = Boolean.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;
const getterOf = (owner: object, key: PropertyKey): Callable | null => {
  const get = Reflect.getOwnPropertyDescriptor(owner, key)?.get;
  return isCallable(get) ? get : null;
};
const regexpSource = getterOf(RegExp.prototype, 'source');
const regexpFlags = getterOf(RegExp.prototype, 'flags');
const symbolDescription = getterOf(Symbol.prototype, 'description');
const typedArrayPrototype: object = Reflect.getPrototypeOf(Uint8Array.prototype) ?? {};
const typedArrayTag = getterOf(typedArrayPrototype, Symbol.toStringTag);
const typedArrayBuffer = getterOf(typedArrayPrototype, 'buffer');
const typedArrayOffset = getterOf(typedArrayPrototype, 'byteOffset');
const typedArrayLength = getterOf(typedArrayPrototype, 'byteLength');
const INTL_TYPES = [
  'Collator',
  'DateTimeFormat',
  'NumberFormat',
  'PluralRules',
  'RelativeTimeFormat',
  'ListFormat',
  'Segmenter',
  'DisplayNames',
] as const;
/** `Intl` prototypes, with their names and original `resolvedOptions` (a brand-checked read). */
const intlTypes = new Map<object, { name: string; resolve: Callable }>(
  INTL_TYPES.flatMap((name): [object, { name: string; resolve: Callable }][] => {
    const type: unknown = Reflect.get(Intl, name);
    const prototype: unknown = isObjectLike(type) ? Reflect.get(type, 'prototype') : undefined;
    const resolve: unknown = isObjectLike(prototype)
      ? Reflect.get(prototype, 'resolvedOptions')
      : undefined;
    return isObjectLike(prototype) && isCallable(resolve)
      ? [[prototype, { name: `Intl.${name}`, resolve }]]
      : [];
  }),
);

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

const stringDigests = new Map<string, string>();
const STRING_DIGEST_CACHE = 4096;

/** `str(<length>)#<digest>` of a long string; cached, V8 keeps a string's hash. */
function longString(value: string): string {
  let digest = stringDigests.get(value);
  if (digest === undefined) {
    if (stringDigests.size >= STRING_DIGEST_CACHE) stringDigests.clear();
    digest = sha256(value).slice(0, 32);
    stringDigests.set(value, digest);
  }
  return `str(${value.length})#${digest}`;
}

export interface Serialized {
  text: string;
  /** False when a budget was hit or a proxy was met: the text does not decide equality. */
  complete: boolean;
}

interface WalkState {
  known: ReadonlyMap<object, string>;
  fixtureRoots: ReadonlyMap<string, string>;
  seen: Set<object>;
  nodes: number;
  complete: boolean;
}

const nameOf = (fn: object): string => {
  const name: unknown = Reflect.getOwnPropertyDescriptor(fn, 'name')?.value;
  return typeof name === 'string' ? name : '';
};

/** The name of an object's class from its prototype's own `constructor`; `null` for none. */
function classNameOf(value: object): string | null {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype === null) return null;
  if (types.isProxy(prototype)) return '?';
  const constructor: unknown = Reflect.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  return isCallable(constructor) ? nameOf(constructor) : '?';
}

function walk(value: unknown, state: WalkState, depth: number): string {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Object.is(value, -0) ? '-0' : `${value}`;
    case 'bigint':
      return `${value}n`;
    case 'string':
      return value.length > LONG_STRING ? longString(value) : quote(value);
    case 'symbol': {
      const description: unknown =
        symbolDescription === null ? undefined : Reflect.apply(symbolDescription, value, []);
      return `Symbol(${typeof description === 'string' ? quote(description) : ''})`;
    }
    default:
      break;
  }
  if (value === null) return 'null';
  if (!isObjectLike(value)) return '?';
  const known = state.known.get(value);
  if (known !== undefined) return `[${known}]`;
  if (types.isProxy(value)) {
    state.complete = false;
    return '[Proxy]';
  }
  if (typeof value === 'function') return `[Function ${nameOf(value)}]`;
  if (state.seen.has(value)) return '[Circular]';
  state.nodes += 1;
  if (depth >= VALUE_DEPTH_LIMIT || state.nodes > VALUE_NODE_BUDGET) {
    state.complete = false;
    return '…';
  }
  state.seen.add(value);
  try {
    return walkObject(value, state, depth);
  } finally {
    state.seen.delete(value);
  }
}

function ownEntries(
  value: object,
  state: WalkState,
  depth: number,
  skip: (key: string) => boolean = () => false,
): string[] {
  const parts: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && skip(key)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true) continue;
    const label = typeof key === 'symbol' ? `[${walk(key, state, depth + 1)}]` : quote(key);
    const item =
      'value' in descriptor &&
      (key === 'parentPath' || key === 'path') &&
      Reflect.getPrototypeOf(value) === Dirent.prototype
        ? fixtureDirectory(descriptor.value, state.fixtureRoots)
        : descriptor.value;
    const text = 'value' in descriptor ? walk(item, state, depth + 1) : '<accessor>';
    parts.push(`${label}:${text}`);
  }
  return parts;
}

/** Only native directory-entry metadata under a fully captured input root is relocatable. */
function fixtureDirectory(value: unknown, roots: ReadonlyMap<string, string>): unknown {
  if (typeof value !== 'string') return value;
  const directory = value.replace(/\\/g, '/');
  let match = '';
  for (const root of roots.keys())
    if ((directory === root || directory.startsWith(`${root}/`)) && root.length > match.length)
      match = root;
  return match ? `<${roots.get(match)}>${directory.slice(match.length)}` : value;
}

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

function walkArray(value: unknown[], state: WalkState, depth: number): string {
  const length: unknown = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
  const size = typeof length === 'number' ? length : 0;
  const items: string[] = [];
  for (let index = 0; index < size; index += 1) {
    state.nodes += 1;
    if (state.nodes > VALUE_NODE_BUDGET) {
      state.complete = false;
      items.push('…');
      break;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, `${index}`);
    items.push(
      descriptor === undefined
        ? '<hole>'
        : 'value' in descriptor
          ? walk(descriptor.value, state, depth + 1)
          : '<accessor>',
    );
  }
  if (!state.complete) return `[${items.join(',')}]`;
  const extra = ownEntries(value, state, depth, (key) => ARRAY_INDEX.test(key));
  return `[${items.join(',')}]${extra.length > 0 ? `{${extra.join(',')}}` : ''}`;
}

function walkTypedArray(value: object): string {
  const tag: unknown = typedArrayTag === null ? undefined : Reflect.apply(typedArrayTag, value, []);
  const buffer: unknown =
    typedArrayBuffer === null ? undefined : Reflect.apply(typedArrayBuffer, value, []);
  const offset: unknown =
    typedArrayOffset === null ? undefined : Reflect.apply(typedArrayOffset, value, []);
  const length: unknown =
    typedArrayLength === null ? undefined : Reflect.apply(typedArrayLength, value, []);
  const bytes =
    types.isAnyArrayBuffer(buffer) && typeof offset === 'number' && typeof length === 'number'
      ? new Uint8Array(buffer, offset, length)
      : new Uint8Array(0);
  return `${String(tag)}(${bytes.length})#${sha256(bytes).slice(0, 32)}`;
}

function walkObject(value: object, state: WalkState, depth: number): string {
  if (types.isDate(value)) return `Date(${Reflect.apply(dateGetTime, value, [])})`;
  if (types.isRegExp(value)) {
    const source = regexpSource === null ? '' : Reflect.apply(regexpSource, value, []);
    const flags = regexpFlags === null ? '' : Reflect.apply(regexpFlags, value, []);
    const lastIndex: unknown = Reflect.getOwnPropertyDescriptor(value, 'lastIndex')?.value;
    return `/${String(source)}/${String(flags)}@${walk(lastIndex, state, depth + 1)}`;
  }
  if (types.isNumberObject(value))
    return `Number(${walk(Reflect.apply(numberValueOf, value, []), state, depth)})`;
  if (types.isStringObject(value))
    return `String(${walk(Reflect.apply(stringValueOf, value, []), state, depth)})`;
  if (types.isBooleanObject(value))
    return `Boolean(${walk(Reflect.apply(booleanValueOf, value, []), state, depth)})`;
  if (types.isBigIntObject(value))
    return `BigInt(${walk(Reflect.apply(bigintValueOf, value, []), state, depth)})`;
  if (types.isSymbolObject(value)) return '[Symbol object]';
  if (Array.isArray(value)) return walkArray(value, state, depth);
  if (types.isTypedArray(value)) return walkTypedArray(value);
  if (types.isAnyArrayBuffer(value)) {
    const bytes = new Uint8Array(value);
    return `ArrayBuffer(${bytes.length})#${sha256(bytes).slice(0, 32)}`;
  }
  if (types.isMap(value)) {
    const entries: string[] = [];
    Reflect.apply(mapForEach, value, [
      (item: unknown, key: unknown): void => {
        entries.push(`${walk(key, state, depth + 1)}=>${walk(item, state, depth + 1)}`);
      },
    ]);
    return `Map{${entries.join(',')}}`;
  }
  if (types.isSet(value)) {
    const entries: string[] = [];
    Reflect.apply(setForEach, value, [
      (item: unknown): void => {
        entries.push(walk(item, state, depth + 1));
      },
    ]);
    return `Set{${entries.join(',')}}`;
  }
  if (types.isPromise(value)) return '[Promise]';
  if (types.isWeakMap(value)) return '[WeakMap]';
  if (types.isWeakSet(value)) return '[WeakSet]';
  const prototype = Reflect.getPrototypeOf(value);
  const intl = prototype === null ? undefined : intlTypes.get(prototype);
  if (intl !== undefined) {
    try {
      return `${intl.name}(${walk(Reflect.apply(intl.resolve, value, []), state, depth + 1)})`;
    } catch {
      state.complete = false;
      return `${intl.name}(?)`;
    }
  }
  const className = classNameOf(value);
  const label = className === 'Object' ? '' : className === null ? '[null]' : className;
  const message: unknown = types.isNativeError(value)
    ? Reflect.getOwnPropertyDescriptor(value, 'message')?.value
    : undefined;
  const head = typeof message === 'string' ? `${label}(${quote(message)})` : label;
  return `${head}{${ownEntries(value, state, depth).join(',')}}`;
}

/**
 * Canonical text of a value (module header). Never runs user code and never throws: a value the
 * walk cannot read is `[Unserializable]` and incomplete. `known` names objects by token.
 */
export function serializeValue(
  value: unknown,
  known: ReadonlyMap<object, string> = new Map(),
  fixtureRoots: ReadonlyMap<string, string> = new Map(),
): Serialized {
  const state: WalkState = { known, fixtureRoots, seen: new Set(), nodes: 0, complete: true };
  try {
    return { text: walk(value, state, 0), complete: state.complete };
  } catch {
    return { text: '[Unserializable]', complete: false };
  }
}

/** The stored form of a canonical text: itself when short, else a digest plus a preview. */
export const valueKey = (text: string): string =>
  text.length <= SHORT_VALUE
    ? text
    : `#${sha256(text).slice(0, 32)}(${text.length}) ${text.slice(0, PREVIEW)}…`;

// ── Call sites ─────────────────────────────────────────────────────────────

/** A stack frame as {@link callSiteOf} reads it: the script, or null for an engine frame. */
export interface FrameLike {
  file: string | null;
}

/**
 * The frame that made a wrapped call (module header): null when the engine made the call while
 * another wrapped built-in ran (`inside` and the first frame has no script), when no frame has a
 * script, or when the first one with a script is not a production file. `production` maps a
 * script to its repo path, or null.
 */
export function callSiteOf<T extends FrameLike>(
  frames: readonly T[],
  inside: boolean,
  production: (file: string) => string | null,
): { frame: T; repoPath: string } | null {
  if (frames.length === 0 || (inside && frames[0].file === null)) return null;
  const first = frames.find((frame) => frame.file !== null);
  if (first === undefined || first.file === null) return null;
  const repoPath = production(first.file);
  return repoPath === null ? null : { frame: first, repoPath };
}

/**
 * The production resolver of a prepared copy: a script (absolute path or `file:` URL) under the
 * prepared root, outside `node_modules`, translated through the path map, that the KTD7
 * predicate accepts, gives its repo path; anything else null.
 */
export function productionResolver(
  preparedRoot: string,
  extraRoots: readonly string[],
): (script: string) => string | null {
  const root = preparedRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const pathMap = buildPathMap(extraRoots);
  const isProduction = productionFilePredicate(extraRoots);
  return (script: string): string | null => {
    const file = scriptPath(script);
    if (file === null || file.includes('/node_modules/')) return null;
    const relative = path.posix.relative(root, file);
    if (relative === '' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
      return null;
    }
    try {
      const repoPath = toRepoPath(relative, pathMap);
      return isProduction(repoPath) ? repoPath : null;
    } catch {
      return null;
    }
  };
}

interface V8Frame extends FrameLike {
  line: number | null;
  column: number | null;
  callSite: NodeJS.CallSite;
}

const toV8Frame = (callSite: NodeJS.CallSite): V8Frame => ({
  file: callSite.getFileName() ?? null,
  line: callSite.getLineNumber(),
  column: callSite.getColumnNumber(),
  callSite,
});

const isCallSite = (value: unknown): value is NodeJS.CallSite =>
  isObjectLike(value) && isCallable(Reflect.get(value, 'getFileName'));

/** V8's structured frames below `skip` (exclusive), at most {@link FRAME_LIMIT}. */
function captureFrames(skip: (...args: never[]) => unknown): V8Frame[] {
  const savedPrepare = Error.prepareStackTrace;
  const savedLimit = Error.stackTraceLimit;
  const holder: { stack?: unknown } = {};
  let stack: unknown;
  Error.stackTraceLimit = FRAME_LIMIT;
  Error.prepareStackTrace = (_error, callSites): unknown => callSites;
  try {
    Error.captureStackTrace(holder, skip);
    stack = holder.stack;
  } finally {
    Error.prepareStackTrace = savedPrepare;
    Error.stackTraceLimit = savedLimit;
  }
  return Array.isArray(stack) ? stack.filter(isCallSite).map(toV8Frame) : [];
}

const MAPPED_POSITION = /:(\d+):(\d+)\)?\s*$/;

/** `<line>:<column>` of a frame through the worker's source-mapping `prepareStackTrace`. */
function positionOf(frame: V8Frame): string {
  const generated = `${frame.line ?? 0}:${frame.column ?? 0}`;
  const prepare = Error.prepareStackTrace;
  if (prepare === undefined) return generated;
  try {
    const text: unknown = prepare(new Error(), [frame.callSite]);
    const match = typeof text === 'string' ? MAPPED_POSITION.exec(text) : null;
    return match === null ? generated : `${match[1]}:${match[2]}`;
  } catch {
    return generated;
  }
}

// ── Recorder ───────────────────────────────────────────────────────────────

export interface CurrentTest {
  /** Vitest task id. */
  id: string;
  concurrent: boolean;
}

export interface RecorderDeps {
  /** The running test, or null outside any test. */
  currentTest: () => CurrentTest | null;
  /** Repo path of a production script, else null ({@link productionResolver}). */
  production: (script: string) => string | null;
  /** Current attempt's repository roots, identified by exact captured bytes and layout. */
  fixtureRoots?: ReadonlyMap<string, string>;
}

interface TestState {
  concurrent: boolean;
  attempts: number;
  overflow: Set<TraceOverflow>;
  calls: Map<string, RawTraceCall>;
}

const newTest = (concurrent: boolean, attempts: number): TestState => ({
  concurrent,
  attempts,
  overflow: new Set(),
  calls: new Map(),
});

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const callOrder = (a: RawTraceCall, b: RawTraceCall): number =>
  byText(a.site, b.site) ||
  byText(a.api, b.api) ||
  byText(a.receiver, b.receiver) ||
  byText(a.args, b.args);

/** Records wrapped calls per test (module header); one instance per worker. */
export class TraceRecorder {
  readonly #deps: RecorderDeps;
  readonly #tests = new Map<string, TestState>();
  readonly #known = new Map<object, string>();
  readonly #proxies = new Map<Callable, Callable>();
  readonly #production = new Map<string, string | null>();
  readonly #positions = new Map<string, string>();
  readonly #wrapped: string[] = [];
  readonly #unavailable: { api: string; reason: string }[] = [];
  readonly #errors: string[] = [];
  #busy = false;
  #inside = 0;

  constructor(deps: RecorderDeps) {
    this.#deps = deps;
  }

  /** Wraps each entry on `root` (module header); entries that cannot be wrapped are listed. */
  install(root: object, entries: readonly WrapEntry[]): void {
    this.#known.set(root, 'globalThis');
    for (const entry of entries) {
      const reason = this.#installOne(root, entry);
      if (reason === null) this.#wrapped.push(entry.api);
      else this.#unavailable.push({ api: entry.api, reason });
    }
    for (const ownerPath of ALIAS_OWNERS) {
      const owner = resolveOwner(root, ownerPath);
      if (owner === null) continue;
      for (const key of Reflect.ownKeys(owner)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
        const value: unknown = descriptor?.value;
        const proxy = isCallable(value) ? this.#proxies.get(value) : undefined;
        if (descriptor !== undefined && proxy !== undefined) {
          Reflect.defineProperty(owner, key, { ...descriptor, value: proxy });
        }
      }
    }
  }

  #installOne(root: object, entry: WrapEntry): string | null {
    const owner = resolveOwner(root, entry.owner);
    if (owner === null) return 'no owner';
    if (entry.owner.length > 0) this.#known.set(owner, entry.owner.join('.'));
    const descriptor = Reflect.getOwnPropertyDescriptor(owner, entry.key);
    if (descriptor === undefined) return 'missing';
    if (entry.kind === 'bound-getter') {
      const get = descriptor.get;
      if (!isCallable(get)) return 'not a getter';
      const wrappedGet = this.#boundGetter(get, entry.api);
      return Reflect.defineProperty(owner, entry.key, { ...descriptor, get: wrappedGet })
        ? null
        : 'not configurable';
    }
    const original: unknown = descriptor.value;
    if (!isCallable(original)) return 'not a function';
    const proxy = this.#proxyFor(original, entry.api, null);
    if (!Reflect.defineProperty(owner, entry.key, { ...descriptor, value: proxy })) {
      return 'not configurable';
    }
    this.#known.set(original, entry.api);
    this.#known.set(proxy, entry.api);
    return null;
  }

  /** A getter returning one wrapper per bound function, with the instance as the receiver. */
  #boundGetter(get: Callable, api: string): Callable {
    const wrappers = new WeakMap<Callable, Callable>();
    const recorder = this;
    return function (this: unknown): unknown {
      const bound: unknown = Reflect.apply(get, this, []);
      if (!isCallable(bound)) return bound;
      let wrapper = wrappers.get(bound);
      if (wrapper === undefined) {
        const instance = this;
        wrapper = recorder.#proxyFor(bound, api, { instance });
        wrappers.set(bound, wrapper);
      }
      return wrapper;
    };
  }

  /** The pass-through proxy of `original`; one per original function. */
  #proxyFor(original: Callable, api: string, bound: { instance: unknown } | null): Callable {
    const cached = bound === null ? this.#proxies.get(original) : undefined;
    if (cached !== undefined) return cached;
    const recorder = this;
    const apply = (target: Callable, thisArg: unknown, args: unknown[]): unknown => {
      const receiver = bound === null ? thisArg : bound.instance;
      recorder.#observe(api, () => recorder.#serialize(receiver), args, apply);
      recorder.#inside += 1;
      try {
        return Reflect.apply(target, thisArg, args);
      } finally {
        recorder.#inside -= 1;
      }
    };
    const construct = (target: Callable, args: unknown[], newTarget: Callable): object => {
      const receiver = (): Serialized => recorder.#newReceiver(newTarget);
      recorder.#observe(api, receiver, args, construct);
      recorder.#inside += 1;
      try {
        return Reflect.construct(target, args, newTarget);
      } finally {
        recorder.#inside -= 1;
      }
    };
    const handler: ProxyHandler<Callable> = { apply, construct };
    const proxy = new Proxy(original, handler);
    if (bound === null) this.#proxies.set(original, proxy);
    return proxy;
  }

  /** `<new Name>`; a foreign proxy as `new.target` is not read (its traps would run). */
  #newReceiver(newTarget: Callable): Serialized {
    const known = this.#known.get(newTarget);
    if (known !== undefined) return { text: `<new ${known}>`, complete: true };
    return types.isProxy(newTarget)
      ? { text: '<new [Proxy]>', complete: false }
      : { text: `<new ${nameOf(newTarget)}>`, complete: true };
  }

  #serialize(value: unknown): Serialized {
    return serializeValue(value, this.#known, this.#deps.fixtureRoots);
  }

  #productionOf(file: string): string | null {
    let repoPath = this.#production.get(file);
    if (repoPath === undefined) {
      repoPath = this.#deps.production(file);
      this.#production.set(file, repoPath);
    }
    return repoPath;
  }

  #observe(
    api: string,
    receiver: () => Serialized,
    args: unknown[],
    skip: (...args: never[]) => unknown,
  ): void {
    if (this.#busy) return;
    this.#busy = true;
    let test: CurrentTest | null = null;
    try {
      test = this.#deps.currentTest();
      if (test === null) return;
      const chosen = callSiteOf(captureFrames(skip), this.#inside > 0, (file) =>
        this.#productionOf(file),
      );
      if (chosen === null) return;
      const { frame } = chosen;
      const at = `${frame.file ?? ''}:${frame.line ?? 0}:${frame.column ?? 0}`;
      let position = this.#positions.get(at);
      if (position === undefined) {
        position = positionOf(frame);
        this.#positions.set(at, position);
      }
      const recv = receiver();
      const list = this.#serialize(args);
      this.#add(test, {
        site: `${chosen.repoPath}:${position}`,
        api,
        receiver: valueKey(recv.text),
        args: valueKey(list.text),
        complete: recv.complete && list.complete,
      });
    } catch (error) {
      this.#fail(test, error);
    } finally {
      this.#busy = false;
    }
  }

  #state(test: CurrentTest): TestState {
    let state = this.#tests.get(test.id);
    if (state === undefined) {
      state = newTest(test.concurrent, 0);
      this.#tests.set(test.id, state);
    }
    return state;
  }

  #add(
    test: CurrentTest,
    call: { site: string; api: string; receiver: string; args: string; complete: boolean },
  ): void {
    const state = this.#state(test);
    if (!call.complete) state.overflow.add('value');
    const key = `${call.site}\u0001${call.api}\u0001${call.receiver}\u0001${call.args}`;
    const existing = state.calls.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    if (state.calls.size >= TEST_CALL_BUDGET) {
      state.overflow.add('calls');
      return;
    }
    const { site, api, receiver, args } = call;
    state.calls.set(key, { site, api, receiver, args, count: 1 });
  }

  #fail(test: CurrentTest | null, error: unknown): void {
    if (test !== null) this.#state(test).overflow.add('recorder');
    if (this.#errors.length < MAX_ERRORS) {
      this.#errors.push(error instanceof Error ? `${error.name}: ${error.message}` : 'error');
    }
  }

  /** An attempt of a test starts (repeat or retry): its calls start over. */
  testStarted(test: CurrentTest): void {
    const previous = this.#tests.get(test.id);
    this.#tests.set(test.id, newTest(test.concurrent, (previous?.attempts ?? 0) + 1));
  }

  record(file: string): RawTraceRecord {
    return {
      schemaVersion: RAW_TRACE_SCHEMA_VERSION,
      file: file.replace(/\\/g, '/'),
      wrapped: [...this.#wrapped],
      unavailable: this.#unavailable.map((item) => ({ ...item })),
      errors: [...this.#errors],
      tests: [...this.#tests].map(
        ([taskId, state]): RawTestTrace => ({
          taskId,
          concurrent: state.concurrent,
          attempts: state.attempts,
          overflow: [...state.overflow].sort(byText),
          calls: [...state.calls.values()].map((call) => ({ ...call })).sort(callOrder),
        }),
      ),
    };
  }
}

/** The object at `ownerPath` below `root` (each step an own or inherited property). */
function resolveOwner(root: object, ownerPath: readonly string[]): object | null {
  let current: object = root;
  for (const key of ownerPath) {
    const next: unknown = Reflect.get(current, key);
    if (!isObjectLike(next)) return null;
    current = next;
  }
  return current;
}

// ── Output ─────────────────────────────────────────────────────────────────

/** Name of a test file's raw record; the pid keeps a re-run file apart. */
export function rawTraceName(file: string, pid: number, digest: string): string {
  return `${RAW_TRACE_PREFIX}${pid}-${digest}-${path.posix.basename(file.replace(/\\/g, '/'))}.json`;
}

/** Writes a raw record atomically (temporary dot-file, then rename), compact. */
export function writeRawTrace(dir: string, name: string, record: RawTraceRecord): void {
  const target = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(record));
  renameSync(temp, target);
}
