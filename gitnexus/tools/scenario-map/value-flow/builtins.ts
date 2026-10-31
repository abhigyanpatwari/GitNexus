/**
 * The trace run's wrap list (U11, R9, KTD11 "Trace", design §5.3a step 4 and §11): the
 * value-sensitive built-ins whose calls from production frames trace.setup.ts records, and the
 * mapping that adds the opaque sinks the static check found (U10 pdg-walk.ts `opaqueSinks`).
 * Pure data and pure functions; the worker (trace-records.ts) and the parent (trace.ts) share it.
 *
 * Base list ({@link BASE_WRAP_LIST}), by group:
 *  - `math`: every `Math` function except `random` (it takes no input);
 *  - `string`: the `String.prototype` transforms and comparisons `toUpperCase`, `toLowerCase`,
 *    `toLocaleUpperCase`, `toLocaleLowerCase`, `normalize`, `localeCompare`, `trim`,
 *    `trimStart`, `trimEnd`, `padStart`, `padEnd`, `slice`, `substring`, `substr`, `replace`,
 *    `replaceAll`, `split`, `at`, `charAt`, `charCodeAt`, `codePointAt`, `startsWith`,
 *    `endsWith`, `includes`, `indexOf`, `lastIndexOf`, `repeat`;
 *  - `regexp`: `RegExp.prototype.test` and `exec`, and the regex uses of strings
 *    `String.prototype.match`, `matchAll` and `search`;
 *  - `number`: `parseInt`, `parseFloat` (the same functions as `Number.parseInt`/`parseFloat`,
 *    which share the wrapper), the `Number` constructor (`Number(x)` and `new Number(x)`), and
 *    `Number.prototype.toFixed`, `toPrecision`, `toExponential`, `toString`, `toLocaleString`;
 *  - `json`: `JSON.parse`, `JSON.stringify`;
 *  - `intl`: the `Intl` constructors `Collator`, `DateTimeFormat`, `NumberFormat`, `PluralRules`,
 *    `RelativeTimeFormat`, `ListFormat`, `Segmenter`, `DisplayNames`; the bound-function getters
 *    `Collator.prototype.compare`, `DateTimeFormat.prototype.format` and
 *    `NumberFormat.prototype.format` (the bound function is wrapped, once per instance, so
 *    `nf.format === nf.format` still holds); and the methods `formatToParts`, `formatRange`,
 *    `formatRangeToParts`, `select`, `selectRange`, `segment` and `of` where they exist;
 *  - `date`: the `Date` constructor (call and `new`), `Date.UTC`, `Date.parse`, every
 *    `Date.prototype` getter and setter (`getTime`, `getUTCDate`, `setMonth` …) and its
 *    formatters (`toISOString`, `toJSON`, `toString`, `toUTCString`, `toDateString`,
 *    `toTimeString`, `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`);
 *  - `sort`: `Array.prototype.sort` and `toSorted`. The call is recorded with its receiver (the
 *    elements the engine orders) and comparator; a comparator's own calls of wrapped built-ins
 *    are recorded at their sites.
 * Aliases of a wrapped function on `globalThis`, `Number`, `String.prototype` and
 * `Date.prototype` (`trimLeft`, `trimRight`, `toGMTString`, `Number.parseInt`) get the same
 * wrapper, so identities between them hold.
 *
 * Never wrapped (design §5.3a): storage and table reads into built-in containers, `push` and
 * `unshift` of arrays and every method of `Map`, `Set`, `WeakMap` and `WeakSet`
 * ({@link isStorageRead}). An opaque sink of one of them is skipped.
 *
 * Dynamic additions ({@link wrapListOf}): U10 names a library callee by the TypeScript checker's
 * display name (`String.trim`, `NumberConstructor.isFinite`, `Math.max`, `__global.URL`,
 * `parseInt`, `NumberFormat.format`); {@link wrapTargetOfCallee} maps it to the runtime property
 * (`String.prototype.trim`, `Number.isFinite`, `Math.max`, `URL`, `parseInt`,
 * `Intl.NumberFormat.prototype.format`). A free callee must be a known global function or
 * constructor. A callee that names no global built-in (a Node or package API such as
 * `BaseLogger.warn` or an imported `load`) is skipped with a reason: the static check already
 * vetoes it as opaque.
 *
 * Library only.
 */

/** Why an entry is wrapped: a base group, or `opaque-sink` for a U10 addition. */
export type WrapGroup =
  | 'math'
  | 'string'
  | 'regexp'
  | 'number'
  | 'json'
  | 'intl'
  | 'date'
  | 'sort'
  | 'opaque-sink';

/**
 * `function`: the property holds a function (a method, a static, a global function or a
 * constructor); it is replaced by a pass-through proxy that records calls and `new` calls.
 * `bound-getter`: an accessor whose getter returns a bound function (the `Intl` `format` and
 * `compare` getters); the returned function is wrapped, with the instance as the receiver.
 */
export type WrapKind = 'function' | 'bound-getter';

export interface WrapEntry {
  /** Runtime name: `Math.round`, `String.prototype.trim`, `parseInt`, `Date`. */
  api: string;
  /** Property path from the global object to the owner: `['String', 'prototype']`; `[]`. */
  owner: string[];
  /** The property of the owner. */
  key: string;
  kind: WrapKind;
  group: WrapGroup;
}

const entry = (
  group: WrapGroup,
  owner: readonly string[],
  key: string,
  kind: WrapKind = 'function',
): WrapEntry => ({
  api: [...owner, key].join('.'),
  owner: [...owner],
  key,
  kind,
  group,
});

const MATH_FUNCTIONS = [
  'abs',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'ceil',
  'clz32',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'floor',
  'fround',
  'hypot',
  'imul',
  'log',
  'log10',
  'log1p',
  'log2',
  'max',
  'min',
  'pow',
  'round',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
] as const;

const STRING_METHODS = [
  'toUpperCase',
  'toLowerCase',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'normalize',
  'localeCompare',
  'trim',
  'trimStart',
  'trimEnd',
  'padStart',
  'padEnd',
  'slice',
  'substring',
  'substr',
  'replace',
  'replaceAll',
  'split',
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'startsWith',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'repeat',
] as const;

const STRING_REGEX_METHODS = ['match', 'matchAll', 'search'] as const;

const NUMBER_METHODS = [
  'toFixed',
  'toPrecision',
  'toExponential',
  'toString',
  'toLocaleString',
] as const;

const INTL_CONSTRUCTORS = [
  'Collator',
  'DateTimeFormat',
  'NumberFormat',
  'PluralRules',
  'RelativeTimeFormat',
  'ListFormat',
  'Segmenter',
  'DisplayNames',
] as const;

/** `Intl` prototype members: getters that return a bound function, and plain methods. */
const INTL_MEMBERS: readonly (readonly [string, string, WrapKind])[] = [
  ['Collator', 'compare', 'bound-getter'],
  ['DateTimeFormat', 'format', 'bound-getter'],
  ['DateTimeFormat', 'formatToParts', 'function'],
  ['DateTimeFormat', 'formatRange', 'function'],
  ['DateTimeFormat', 'formatRangeToParts', 'function'],
  ['NumberFormat', 'format', 'bound-getter'],
  ['NumberFormat', 'formatToParts', 'function'],
  ['NumberFormat', 'formatRange', 'function'],
  ['NumberFormat', 'formatRangeToParts', 'function'],
  ['PluralRules', 'select', 'function'],
  ['PluralRules', 'selectRange', 'function'],
  ['RelativeTimeFormat', 'format', 'function'],
  ['RelativeTimeFormat', 'formatToParts', 'function'],
  ['ListFormat', 'format', 'function'],
  ['ListFormat', 'formatToParts', 'function'],
  ['Segmenter', 'segment', 'function'],
  ['DisplayNames', 'of', 'function'],
];

const DATE_FIELDS = [
  'Date',
  'Day',
  'FullYear',
  'Hours',
  'Milliseconds',
  'Minutes',
  'Month',
  'Seconds',
] as const;

const DATE_METHODS: readonly string[] = [
  ...DATE_FIELDS.flatMap((field) => [`get${field}`, `getUTC${field}`]),
  'getTime',
  'getTimezoneOffset',
  ...DATE_FIELDS.filter((field) => field !== 'Day').flatMap((field) => [
    `set${field}`,
    `setUTC${field}`,
  ]),
  'setTime',
  'toISOString',
  'toJSON',
  'toString',
  'toUTCString',
  'toDateString',
  'toTimeString',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
];

/** The documented base wrap list (module header), in group order. */
export const BASE_WRAP_LIST: readonly WrapEntry[] = Object.freeze([
  ...MATH_FUNCTIONS.map((key) => entry('math', ['Math'], key)),
  ...STRING_METHODS.map((key) => entry('string', ['String', 'prototype'], key)),
  entry('regexp', ['RegExp', 'prototype'], 'test'),
  entry('regexp', ['RegExp', 'prototype'], 'exec'),
  ...STRING_REGEX_METHODS.map((key) => entry('regexp', ['String', 'prototype'], key)),
  entry('number', [], 'parseInt'),
  entry('number', [], 'parseFloat'),
  entry('number', [], 'Number'),
  ...NUMBER_METHODS.map((key) => entry('number', ['Number', 'prototype'], key)),
  entry('json', ['JSON'], 'parse'),
  entry('json', ['JSON'], 'stringify'),
  ...INTL_CONSTRUCTORS.map((key) => entry('intl', ['Intl'], key)),
  ...INTL_MEMBERS.map(([type, key, kind]) => entry('intl', ['Intl', type, 'prototype'], key, kind)),
  entry('date', [], 'Date'),
  entry('date', ['Date'], 'UTC'),
  entry('date', ['Date'], 'parse'),
  ...DATE_METHODS.map((key) => entry('date', ['Date', 'prototype'], key)),
  entry('sort', ['Array', 'prototype'], 'sort'),
  entry('sort', ['Array', 'prototype'], 'toSorted'),
]);

/** Owners whose other properties may alias a wrapped function (module header). */
export const ALIAS_OWNERS: readonly (readonly string[])[] = Object.freeze([
  [],
  ['Number'],
  ['String', 'prototype'],
  ['Date', 'prototype'],
]);

// ── Storage reads ──────────────────────────────────────────────────────────

const CONTAINERS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const ARRAY_STORAGE = new Set(['push', 'unshift']);

/**
 * True for a storage or table read into a built-in container (design §5.3a): any method of
 * `Map`, `Set`, `WeakMap`, `WeakSet` (prototype or static), or `Array.prototype.push`/`unshift`.
 * Takes a runtime api name ({@link WrapEntry.api}).
 */
export function isStorageRead(api: string): boolean {
  const parts = api.split('.');
  if (CONTAINERS.has(parts[0]) && parts.length > 1) return true;
  return parts.length === 3 && parts[0] === 'Array' && parts[1] === 'prototype'
    ? ARRAY_STORAGE.has(parts[2])
    : false;
}

// ── Checker callee names ───────────────────────────────────────────────────

/** Global objects that are namespaces: their members are statics. */
const NAMESPACES = new Set(['Math', 'JSON', 'Reflect', 'Atomics', 'Intl']);

/** Instance interfaces of lib.*.d.ts, with the constructor whose prototype holds the members. */
const INSTANCE_INTERFACES = new Map<string, readonly string[]>([
  ...[
    'String',
    'Number',
    'Boolean',
    'BigInt',
    'Symbol',
    'Array',
    'Date',
    'RegExp',
    'Map',
    'WeakMap',
    'Set',
    'WeakSet',
    'Promise',
    'Error',
    'Function',
    'Object',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
  ].map((name): [string, readonly string[]] => [name, [name]]),
  ['ReadonlyArray', ['Array']],
  ['ReadonlyMap', ['Map']],
  ['ReadonlySet', ['Set']],
  ...INTL_CONSTRUCTORS.map((name): [string, readonly string[]] => [name, ['Intl', name]]),
  ...INTL_CONSTRUCTORS.map((name): [string, readonly string[]] => [`Intl.${name}`, ['Intl', name]]),
]);

/** Global functions a free callee may name; constructors come from the instance interfaces. */
const GLOBAL_FUNCTIONS = new Set([
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
  'escape',
  'unescape',
  'atob',
  'btoa',
  'structuredClone',
]);

const isGlobalFunction = (name: string): boolean =>
  GLOBAL_FUNCTIONS.has(name) || (INSTANCE_INTERFACES.get(name)?.length ?? 0) === 1;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const BOUND_GETTERS = new Set(
  INTL_MEMBERS.filter(([, , kind]) => kind === 'bound-getter').map(
    ([type, key]) => `Intl.${type}.prototype.${key}`,
  ),
);

export type CalleeTarget =
  | { kind: 'target'; entry: WrapEntry }
  | { kind: 'skip'; callee: string; reason: string };

/**
 * The runtime property a U10 opaque-sink callee names (module header), as an `opaque-sink`
 * entry, or why it is skipped: `storage read` ({@link isStorageRead}), `not a global
 * built-in` (an unknown container or a malformed name).
 */
export function wrapTargetOfCallee(callee: string): CalleeTarget {
  const skip = (reason: string): CalleeTarget => ({ kind: 'skip', callee, reason });
  const dot = callee.lastIndexOf('.');
  const container = dot < 0 ? null : callee.slice(0, dot);
  const key = dot < 0 ? callee : callee.slice(dot + 1);
  if (!IDENTIFIER.test(key)) return skip('not a global built-in');
  let owner: readonly string[] | null = null;
  if (container === null || container === '__global' || container === 'globalThis') {
    owner = isGlobalFunction(key) ? [] : null;
  } else if (NAMESPACES.has(container)) owner = [container];
  else if (container.endsWith('Constructor')) {
    const name = container.slice(0, -'Constructor'.length);
    const instance = INSTANCE_INTERFACES.get(name);
    owner = instance === undefined ? null : instance;
  } else {
    const instance = INSTANCE_INTERFACES.get(container);
    owner = instance === undefined ? null : [...instance, 'prototype'];
  }
  if (owner === null) return skip('not a global built-in');
  const api = [...owner, key].join('.');
  if (isStorageRead(api)) return skip('storage read');
  const kind: WrapKind = BOUND_GETTERS.has(api) ? 'bound-getter' : 'function';
  return { kind: 'target', entry: entry('opaque-sink', owner, key, kind) };
}

export interface WrapList {
  /** The base list, then each added opaque sink once, in callee order. */
  entries: WrapEntry[];
  /** Apis added for opaque sinks that the base list does not hold. */
  added: string[];
  /** Opaque-sink callees that are not wrapped, each once, with the reason. */
  skipped: { callee: string; reason: string }[];
}

/** The base list plus U10's opaque-sink callees ({@link wrapTargetOfCallee}). */
export function wrapListOf(opaqueCallees: readonly string[] = []): WrapList {
  const entries = [...BASE_WRAP_LIST];
  const known = new Set(entries.map((item) => item.api));
  const added: string[] = [];
  const skipped: { callee: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const callee of opaqueCallees) {
    if (seen.has(callee)) continue;
    seen.add(callee);
    const target = wrapTargetOfCallee(callee);
    if (target.kind === 'skip') {
      skipped.push({ callee: target.callee, reason: target.reason });
      continue;
    }
    if (known.has(target.entry.api)) continue;
    known.add(target.entry.api);
    entries.push(target.entry);
    added.push(target.entry.api);
  }
  return { entries, added, skipped };
}
