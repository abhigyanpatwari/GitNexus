/**
 * Structured-clone safety for the worker result boundary (#2112).
 *
 * A parse worker delivers its accumulated result to the main thread via
 * `parentPort.postMessage(...)`. Node serializes that payload with the
 * structured-clone algorithm SYNCHRONOUSLY on the worker thread, and it
 * THROWS a `DataCloneError` the instant it meets a value it can't serialize —
 * a function, a symbol, a Promise, a WeakMap, etc. The reporter of #2112 hit
 * exactly this: a node record whose `properties` carried an own-enumerable
 * value pointing at a native function (`function toString() { [native code] }
 * could not be cloned`). One such value aborted the entire parse phase,
 * because the worker re-posts the throw as `{type:'error'}` which the pool
 * counts as a worker death — and under `GITNEXUS_WORKER_POOL_SIZE=1` the same
 * graph re-throws on every respawn until the slot's budget is exhausted.
 *
 * This module is the safety net. It runs ONLY after a real clone failure on
 * the fast-path post (zero overhead on healthy runs), and rewrites the
 * boundary-crossing arrays so the result becomes cloneable: a non-cloneable
 * value inside a plain extraction record is dropped (the record is otherwise
 * kept — strictly-missing data, never wrong), and a `ParsedFile` that can't be
 * made cloneable is dropped whole so scope-resolution re-derives it on the
 * main thread (where there is no clone boundary) with intact edge data.
 *
 * Language-neutral by construction: it keys on value shape and field name
 * only, never on a language (AGENTS.md shared-pipeline rule). The strip
 * semantics mirror what the store path's `JSON.stringify` already silently
 * drops, so store / no-store / cold / warm runs converge on the same graph.
 */

/** A file whose parse result was sanitized or dropped at the clone boundary. */
export interface SkippedPath {
  /** Best-effort source path of the offending record (or `(unknown)`). */
  path: string;
  /** Human-readable reason, e.g. "dropped 1 non-serializable value from nodes". */
  reason: string;
}

/**
 * True iff `value` survives Node's structured-clone algorithm (the same
 * algorithm `postMessage` uses). This is the authoritative probe — it matches
 * the real failure exactly, including Map/Set/Date/RegExp/TypedArray support,
 * so it never false-positives on the `Scope` Maps that clone fine.
 */
export function isStructuredCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

// ── Compile-time boundary guard (#2143) ─────────────────────────────────────
// The runtime net above is the production backstop; this is its compile-time
// complement. The worker result is plain data EXCEPT a few `unknown`-typed
// sinks (a node's `properties` bag, the provider `extractTemplateConstraints` /
// `collectCaptureSideChannel` hook returns). `unknown` lets a non-serializable
// value (a function, a leaked tree-sitter `SyntaxNode`, …) pass with no
// compile-time guard — that is the structural hole #2112 leaked through. Typing
// those producers as `Cloneable<T>` turns such a leak into a compile error at
// the source site instead of a runtime DataCloneError far downstream.

/** The leaf values the structured-clone algorithm copies verbatim. */
type CloneablePrimitive = undefined | null | boolean | number | bigint | string;

/**
 * Maps `T` to itself when every value reachable from it is structured-clone
 * safe, and to a type containing `never` at the first offending property
 * otherwise. A function or symbol — the values `postMessage` rejects — becomes
 * `never`, so a struct carrying one is no longer assignable to its own
 * `Cloneable<T>` and `assertCloneable` rejects it, naming the bad key.
 *
 * Implemented as a homomorphic mapped type (`{ [K in keyof T]: … }`) so it
 * preserves `interface` shapes and `readonly` modifiers and works WITHOUT
 * requiring the payload types to carry an index signature — sidestepping the
 * "closed interface is not assignable to a recursive index-signature type" wall
 * that blocked the value-typed-`Cloneable` approach (#2143). `Map`/`Set`/array
 * containers recurse into their element types; `Date`/`RegExp` are clone-safe
 * leaves.
 */
/** True iff `T` is `any` (the canonical `IsAny` probe: only `any` satisfies `0 extends 1 & T`). */
type IsAny<T> = 0 extends 1 & T ? true : false;

export type Cloneable<T> =
  IsAny<T> extends true
    ? never // an `any`-typed member defeats the guard — reject it like `unknown` (both → never)
    : T extends CloneablePrimitive | Date | RegExp
      ? T
      : T extends (...args: never[]) => unknown
        ? never
        : T extends symbol
          ? never
          : T extends ReadonlyMap<infer K, infer V>
            ? ReadonlyMap<Cloneable<K>, Cloneable<V>>
            : T extends ReadonlySet<infer U>
              ? ReadonlySet<Cloneable<U>>
              : T extends readonly (infer U)[]
                ? T extends unknown[]
                  ? Cloneable<U>[]
                  : readonly Cloneable<U>[]
                : T extends object
                  ? { [K in keyof T]: Cloneable<T[K]> }
                  : never;

/**
 * Identity at runtime (zero cost — returns its argument unchanged); a
 * compile-time assertion that `value` is structured-clone safe. Wrap a
 * producer that feeds an `unknown` worker-result sink:
 *
 *   collectCaptureSideChannel: (filePath) => assertCloneable(collectFoo(filePath))
 *
 * If `collectFoo`'s return type ever gains a non-cloneable member (a function, a
 * `SyntaxNode`, …) the call fails to compile, pointing at the offending key.
 *
 * The parameter is a conditional type rather than an `extends Cloneable<T>`
 * constraint because a self-referential constraint (`T extends Cloneable<T>`)
 * is a "circular constraint" error in TypeScript. For a clone-safe `T` the
 * parameter resolves to `T` (call type-checks as a plain identity); for an
 * unsafe `T` it resolves to `Cloneable<T>` (which has `never` at the bad key),
 * so the argument is rejected.
 */
export function assertCloneable<T>(value: T extends Cloneable<T> ? T : Cloneable<T>): T {
  return value as T;
}

/**
 * Recursion cap for the module's own traversal. An over-deep subtree is treated
 * as non-cloneable rather than recursing to a stack overflow — without this, a
 * deeply-nested record would throw `RangeError` inside the sanitizer and (since
 * the recovery path is the safety net) re-arm the very cascade #2112 fixes. Set
 * far below the observed ~3000-frame overflow and far above any real
 * parse-result record (extraction records are shallow plain data). Note: this
 * caps the module's recursion only; `structuredClone`'s own internal recursion
 * (the `isStructuredCloneable` probe of non-plain objects) is bounded by that
 * helper's catch-all, which turns a probe-side `RangeError` into a
 * non-cloneable verdict — so do not narrow that catch.
 */
const MAX_CLONE_DEPTH = 200;

/**
 * True iff `key` is a canonical array-index string (`"0"`, `"1"`, … `< 2^32-1`)
 * — i.e. one of the slots the numeric index loop already visits. Everything
 * else returned by `Object.keys(array)` is a NON-index own-enumerable property
 * (`arr.meta = …`), which the structured-clone algorithm ALSO serializes (and
 * throws on if non-cloneable). The array branches of `containsNonCloneable` and
 * `stripNonCloneable` use this to scan those extra keys in lockstep.
 */
function isArrayIndexKey(key: string): boolean {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === key;
}

/**
 * Non-allocating scan: returns true on the FIRST value structured-clone would
 * reject. Used to decide whether an array (or element) needs rewriting at all,
 * so clean arrays keep their referential identity and pay no copy cost.
 */
function containsNonCloneable(value: unknown, seen: WeakSet<object>, depth = 0): boolean {
  const t = typeof value;
  if (t === 'function' || t === 'symbol') return true;
  if (value === null || t !== 'object') return false;
  // Depth bound: treat an over-deep subtree as non-cloneable (the element is
  // then stripped/dropped) instead of overflowing the stack.
  if (depth >= MAX_CLONE_DEPTH) return true;
  const obj = value as object;
  // Cycles clone fine; don't recurse into one twice.
  if (seen.has(obj)) return false;
  // Structured-clone-native containers carry no non-cloneable payload of their
  // own; their *contents* still need scanning (a Map value could be a fn).
  if (obj instanceof Date || obj instanceof RegExp) return false;
  // Buffers/views usually clone, but a DETACHED one is rejected by
  // structuredClone — probe rather than wave it through. No byteLength
  // heuristic: a legitimately empty `new Uint8Array(0)` also has byteLength 0
  // yet clones fine, so a length check would false-positive.
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) return !isStructuredCloneable(obj);
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (containsNonCloneable(obj[i], seen, depth + 1)) return true;
    }
    // structuredClone also serializes an array's NON-index own-enumerable
    // properties and throws on a non-cloneable one — scan them too (lockstep
    // with stripNonCloneable's array branch; see isArrayIndexKey).
    for (const key of Object.keys(obj)) {
      if (isArrayIndexKey(key)) continue;
      let child: unknown;
      try {
        child = (obj as unknown as Record<string, unknown>)[key];
      } catch {
        return true; // a throwing getter can't be serialized either
      }
      if (containsNonCloneable(child, seen, depth + 1)) return true;
    }
    return false;
  }
  if (obj instanceof Map) {
    for (const [k, v] of obj) {
      if (containsNonCloneable(k, seen, depth + 1) || containsNonCloneable(v, seen, depth + 1))
        return true;
    }
    return false;
  }
  if (obj instanceof Set) {
    for (const v of obj) {
      if (containsNonCloneable(v, seen, depth + 1)) return true;
    }
    return false;
  }
  // A non-plain object (Promise, WeakMap, class instance with internal slots)
  // that structured clone can't handle: detect via the authoritative probe.
  // Plain objects fall through to a property scan (cheap, no allocation).
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    if (!isStructuredCloneable(obj)) return true;
    return false;
  }
  for (const key of Object.keys(obj)) {
    let child: unknown;
    try {
      child = (obj as Record<string, unknown>)[key];
    } catch {
      // A getter that throws can't be serialized either — treat as non-cloneable.
      return true;
    }
    if (containsNonCloneable(child, seen, depth + 1)) return true;
  }
  return false;
}

/**
 * State carried through a strip pass. `stripped` counts dropped values for the
 * skip report; `seen` memoizes each visited object to its stripped COPY (not a
 * bare visited-set) so a DAG-aliased subtree — the same object reached via two
 * paths — is sanitized once and shared, never over-dropped, and cycles
 * terminate by returning the in-progress copy.
 */
interface StripCtx {
  stripped: number;
  seen: Map<object, unknown>;
  /**
   * Dotted key paths (relative to the element root) of every value that was
   * stripped/dropped — e.g. `properties.toString`, `meta.data[3]`. Surfaced in
   * the skip reason so the offending property is named precisely, which is what
   * lets a still-unpinned leak be located from a single log line (#2112).
   */
  keys: string[];
}

/** Record a strip at `path` (root → `(root)`); keeps the count + key path in sync. */
function recordStrip(ctx: StripCtx, path: string): void {
  ctx.stripped++;
  ctx.keys.push(path === '' ? '(root)' : path);
}

/**
 * Deep-copy `value`, replacing any value structured-clone would reject with
 * `undefined` (which clones fine). Preserves primitives, arrays, plain
 * objects, and the structured-clone-native containers (Date, RegExp, Map,
 * Set, ArrayBuffer, TypedArray). Rebuilds only what it must — clean leaves are
 * returned by reference. `path` is the dotted key path of `value` (for the
 * diagnostic record).
 */
function stripNonCloneable(value: unknown, ctx: StripCtx, depth = 0, path = ''): unknown {
  const t = typeof value;
  if (t === 'function' || t === 'symbol') {
    recordStrip(ctx, path);
    return undefined;
  }
  if (value === null || t !== 'object') return value;
  // Depth bound (mirrors containsNonCloneable): drop an over-deep subtree to
  // `undefined` (itself cloneable, and a legal property value / array element)
  // rather than overflowing the stack.
  if (depth >= MAX_CLONE_DEPTH) {
    recordStrip(ctx, path);
    return undefined;
  }
  const obj = value as object;
  // Memoized? Return the SAME stripped copy (preserves DAG shape; terminates
  // cycles by returning the in-progress copy inserted before recursing below).
  if (ctx.seen.has(obj)) return ctx.seen.get(obj);
  // Leaf-like values: returned by reference, but still memoize the decision so
  // a second alias resolves identically.
  if (obj instanceof Date || obj instanceof RegExp) {
    ctx.seen.set(obj, value);
    return value;
  }
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
    // Keep a live buffer/view (even an empty one); drop a detached one, which
    // structuredClone rejects. The probe is exact — no byteLength heuristic.
    if (!isStructuredCloneable(obj)) {
      recordStrip(ctx, path);
      ctx.seen.set(obj, undefined);
      return undefined;
    }
    ctx.seen.set(obj, value);
    return value;
  }
  // Containers: allocate the empty copy, memoize it BEFORE recursing, then fill
  // — so a cycle/alias that re-enters gets this in-progress copy.
  if (Array.isArray(obj)) {
    const out: unknown[] = [];
    ctx.seen.set(obj, out);
    for (let i = 0; i < obj.length; i++)
      out.push(stripNonCloneable(obj[i], ctx, depth + 1, `${path}[${i}]`));
    // Carry NON-index own-enumerable props through the same strip (lockstep
    // with containsNonCloneable): structuredClone serializes them, so a
    // non-cloneable one must be stripped rather than left to throw on re-post.
    for (const key of Object.keys(obj)) {
      if (isArrayIndexKey(key)) continue;
      const childPath = `${path}.${key}`;
      let child: unknown;
      try {
        child = (obj as unknown as Record<string, unknown>)[key];
      } catch {
        recordStrip(ctx, childPath);
        continue;
      }
      (out as unknown as Record<string, unknown>)[key] = stripNonCloneable(
        child,
        ctx,
        depth + 1,
        childPath,
      );
    }
    return out;
  }
  if (obj instanceof Map) {
    // Scope limit (acceptable): object keys aren't identity-preserved across
    // stripping. Parse-result Maps are primitive-keyed, so this never bites.
    const out = new Map();
    ctx.seen.set(obj, out);
    for (const [k, v] of obj)
      out.set(
        stripNonCloneable(k, ctx, depth + 1, `${path}<key>`),
        stripNonCloneable(v, ctx, depth + 1, `${path}<map>`),
      );
    return out;
  }
  if (obj instanceof Set) {
    const out = new Set();
    ctx.seen.set(obj, out);
    for (const v of obj) out.add(stripNonCloneable(v, ctx, depth + 1, `${path}<set>`));
    return out;
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    // Non-plain object that the probe already flagged as non-cloneable and
    // that we can't safely reconstruct (Promise, WeakMap, class instance with
    // internal slots). Drop it whole — memoize the decision so aliases agree.
    if (!isStructuredCloneable(obj)) {
      recordStrip(ctx, path);
      ctx.seen.set(obj, undefined);
      return undefined;
    }
    ctx.seen.set(obj, value);
    return value;
  }
  const out: Record<string, unknown> = {};
  ctx.seen.set(obj, out);
  for (const key of Object.keys(obj)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    let child: unknown;
    try {
      child = (obj as Record<string, unknown>)[key];
    } catch {
      // A getter that throws is non-serializable — drop the property.
      recordStrip(ctx, childPath);
      continue;
    }
    out[key] = stripNonCloneable(child, ctx, depth + 1, childPath);
  }
  return out;
}

/** Keys checked (top-level and one level deep) to attribute a record to a file. */
const DEFAULT_PATH_KEYS = ['filePath', 'path', 'file'] as const;

/** Read `obj[key]`, returning undefined if the access throws (throwing getter / Proxy trap). */
function safeGet(obj: Record<string, unknown>, key: string): unknown {
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

/** Read a path key off a child object (one level deep); never throws. */
function pathFromChild(child: unknown, pathKeys: readonly string[]): string | undefined {
  if (child === null || typeof child !== 'object') return undefined;
  const crec = child as Record<string, unknown>;
  for (const pk of pathKeys) {
    const v = safeGet(crec, pk);
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Best-effort source-path extraction for reporting; never throws. Reads are
 * defensive (a throwing getter / Proxy trap on a path-attribution key must not
 * escape and abandon the sanitize — it would re-arm the fail-closed cascade).
 */
function findFilePath(element: unknown, pathKeys: readonly string[]): string | undefined {
  if (element === null || typeof element !== 'object') return undefined;
  const rec = element as Record<string, unknown>;
  // Top level first — a ParsedFile carries `filePath` here.
  for (const key of pathKeys) {
    const v = safeGet(rec, key);
    if (typeof v === 'string') return v;
  }
  // Known child next — a ParsedNode carries its path at `properties.filePath`.
  // Prefer it over the generic sweep so attribution is deterministic when a
  // sibling child also happens to carry a path-like key.
  const fromProps = pathFromChild(safeGet(rec, 'properties'), pathKeys);
  if (fromProps !== undefined) return fromProps;
  // Generic one-level sweep as the fallback for other shapes.
  let keys: string[];
  try {
    keys = Object.keys(rec);
  } catch {
    return undefined; // a Proxy ownKeys trap that throws — give up on attribution
  }
  for (const key of keys) {
    if (key === 'properties') continue; // already checked above
    const fromChild = pathFromChild(safeGet(rec, key), pathKeys);
    if (fromChild !== undefined) return fromChild;
  }
  return undefined;
}

export interface MakeCloneSafeOptions {
  /**
   * Array field names whose offending elements are DROPPED whole rather than
   * stripped in place (e.g. `parsedFiles` — its `captureSideChannel` drives
   * edge resolution, so a stripped-and-delivered file would ship WRONG edges;
   * dropping it lets scope-resolution re-derive it on the main thread).
   */
  dropWholeElement: ReadonlySet<string>;
  /** Field names to skip entirely (e.g. the `skippedPaths` field itself). */
  skipFields?: ReadonlySet<string>;
  /** Keys to probe for a file path when attributing a skip. */
  pathKeys?: readonly string[];
}

/**
 * Make a worker result's boundary-crossing array fields structured-cloneable,
 * mutating `result` in place. Only arrays that actually contain a
 * non-cloneable value are rewritten; everything else keeps referential
 * identity. Returns the list of affected file paths for reporting.
 *
 * Call this after ANY failure of the fast-path post — a `DataCloneError`, OR a
 * throwing getter's own error surfaced by structuredClone (the caller in
 * `post-result.ts` recovers on any throw, not only `DataCloneError`).
 */
export function makeWorkerResultCloneSafe(
  result: Record<string, unknown>,
  options: MakeCloneSafeOptions,
): { skipped: SkippedPath[] } {
  const pathKeys = options.pathKeys ?? DEFAULT_PATH_KEYS;
  const skipped: SkippedPath[] = [];

  for (const field of Object.keys(result)) {
    if (options.skipFields?.has(field)) continue;
    const value = result[field];
    if (!Array.isArray(value)) continue;

    const dropWhole = options.dropWholeElement.has(field);
    // `out` is built lazily — only once a dirty element appears — by copying the
    // clean prefix, so a fully-clean array is never rebuilt and keeps its
    // referential identity (no field reassignment). A dirty element is scanned
    // (containsNonCloneable) and then stripped (stripNonCloneable): two passes,
    // deliberately. The non-allocating pre-scan is exactly what lets CLEAN
    // elements stay by reference (zero-copy) — replacing it with an
    // always-allocating strip would regress that. This whole path is
    // failure-path-only (the fast post already threw), so the second pass over
    // the rare dirty element is acceptable.
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const element = value[i];
      try {
        if (!containsNonCloneable(element, new WeakSet())) {
          if (out) out.push(element);
          continue;
        }
        if (!out) out = value.slice(0, i); // first dirty element: copy clean prefix
        const path = findFilePath(element, pathKeys) ?? '(unknown)';
        if (dropWhole) {
          skipped.push({ path, reason: `dropped non-serializable ${field} entry` });
          continue;
        }
        const ctx: StripCtx = { stripped: 0, seen: new Map(), keys: [] };
        const cleaned = stripNonCloneable(element, ctx);
        // Last-resort guard: if stripping functions/symbols still left something
        // structured-clone rejects, drop the element rather than re-throw.
        if (isStructuredCloneable(cleaned)) {
          out.push(cleaned);
          // Name the offending key path(s) so the leak is locatable from the log
          // (e.g. "from nodes: properties.toString") — not just the array field.
          const at = ctx.keys.slice(0, 3).join(', ');
          const more = ctx.keys.length > 3 ? `, …+${ctx.keys.length - 3}` : '';
          skipped.push({
            path,
            reason: `stripped ${ctx.stripped} non-serializable value(s) from ${field}: ${at}${more}`,
          });
        } else {
          skipped.push({ path, reason: `dropped unsalvageable ${field} entry` });
        }
      } catch {
        // A throw DURING this element's scan/strip — a Proxy with a throwing
        // `getPrototypeOf`/`ownKeys` trap reached by Object.getPrototypeOf /
        // Object.keys, or any other structural-enumeration throw. Drop the
        // element rather than let the throw escape to postResultCloneSafe's
        // fail-closed {type:'error'} (which under POOL_SIZE=1 re-arms the
        // cascade this net prevents). One pathological element can't sink the
        // whole result.
        if (!out) out = value.slice(0, i);
        skipped.push({ path: '(unknown)', reason: `dropped ${field} entry (sanitizer error)` });
      }
    }
    if (out) result[field] = out;
  }

  // Final safety gate. The loop above only rewrites ARRAY fields, so a future
  // non-array result sink (a nested object / Map) — or an array field whose own
  // non-index property the element loop didn't reach — could still hold a
  // non-cloneable value and throw on the re-post. Make "the returned result is
  // structured-cloneable" a hard postcondition: strip any remaining offending
  // field in place. Failure-path-only and a no-op once the result is already
  // clean (the per-field probe short-circuits every clean field).
  if (!isStructuredCloneable(result)) {
    for (const field of Object.keys(result)) {
      if (options.skipFields?.has(field)) continue;
      if (isStructuredCloneable(result[field])) continue;
      const ctx: StripCtx = { stripped: 0, seen: new Map(), keys: [] };
      result[field] = stripNonCloneable(result[field], ctx);
      const at = ctx.keys.slice(0, 3).join(', ');
      skipped.push({
        path: '(result)',
        reason: `stripped ${ctx.stripped} non-serializable value(s) from ${field}${at ? `: ${at}` : ''}`,
      });
    }
  }

  return { skipped };
}
