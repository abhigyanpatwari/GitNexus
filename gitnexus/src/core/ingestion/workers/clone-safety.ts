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

/**
 * True iff `err` is the `DataCloneError` `postMessage` throws on a
 * non-serializable payload. Matches by name (the error is a `DOMException`
 * named `DataCloneError` in Node) with a message fallback for robustness.
 */
export function isDataCloneError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'DataCloneError') return true;
  return typeof err.message === 'string' && err.message.includes('could not be cloned');
}

/**
 * Non-allocating scan: returns true on the FIRST value structured-clone would
 * reject. Used to decide whether an array (or element) needs rewriting at all,
 * so clean arrays keep their referential identity and pay no copy cost.
 */
function containsNonCloneable(value: unknown, seen: WeakSet<object>): boolean {
  const t = typeof value;
  if (t === 'function' || t === 'symbol') return true;
  if (value === null || t !== 'object') return false;
  const obj = value as object;
  // Cycles clone fine; don't recurse into one twice.
  if (seen.has(obj)) return false;
  // Structured-clone-native containers carry no non-cloneable payload of their
  // own; their *contents* still need scanning (a Map value could be a fn).
  if (obj instanceof Date || obj instanceof RegExp) return false;
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) return false;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (containsNonCloneable(obj[i], seen)) return true;
    }
    return false;
  }
  if (obj instanceof Map) {
    for (const [k, v] of obj) {
      if (containsNonCloneable(k, seen) || containsNonCloneable(v, seen)) return true;
    }
    return false;
  }
  if (obj instanceof Set) {
    for (const v of obj) {
      if (containsNonCloneable(v, seen)) return true;
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
    if (containsNonCloneable((obj as Record<string, unknown>)[key], seen)) return true;
  }
  return false;
}

/** Counter carried through a strip pass so the caller can report what was lost. */
interface StripCtx {
  stripped: number;
  seen: WeakSet<object>;
}

/**
 * Deep-copy `value`, replacing any value structured-clone would reject with
 * `undefined` (which clones fine). Preserves primitives, arrays, plain
 * objects, and the structured-clone-native containers (Date, RegExp, Map,
 * Set, ArrayBuffer, TypedArray). Rebuilds only what it must — clean leaves are
 * returned by reference.
 */
function stripNonCloneable(value: unknown, ctx: StripCtx): unknown {
  const t = typeof value;
  if (t === 'function' || t === 'symbol') {
    ctx.stripped++;
    return undefined;
  }
  if (value === null || t !== 'object') return value;
  const obj = value as object;
  if (ctx.seen.has(obj)) return value;
  if (obj instanceof Date || obj instanceof RegExp) return value;
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) return value;
  ctx.seen.add(obj);
  if (Array.isArray(obj)) {
    return obj.map((v) => stripNonCloneable(v, ctx));
  }
  if (obj instanceof Map) {
    const out = new Map();
    for (const [k, v] of obj) out.set(stripNonCloneable(k, ctx), stripNonCloneable(v, ctx));
    return out;
  }
  if (obj instanceof Set) {
    const out = new Set();
    for (const v of obj) out.add(stripNonCloneable(v, ctx));
    return out;
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    // Non-plain object that the probe already flagged as non-cloneable and
    // that we can't safely reconstruct (Promise, WeakMap, class instance with
    // internal slots). Drop it whole.
    if (!isStructuredCloneable(obj)) {
      ctx.stripped++;
      return undefined;
    }
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    out[key] = stripNonCloneable((obj as Record<string, unknown>)[key], ctx);
  }
  return out;
}

/** Keys checked (top-level and one level deep) to attribute a record to a file. */
const DEFAULT_PATH_KEYS = ['filePath', 'path', 'file'] as const;

/** Best-effort source-path extraction for reporting; never throws. */
function findFilePath(element: unknown, pathKeys: readonly string[]): string | undefined {
  if (element === null || typeof element !== 'object') return undefined;
  const rec = element as Record<string, unknown>;
  for (const key of pathKeys) {
    if (typeof rec[key] === 'string') return rec[key] as string;
  }
  // One level deep — ParsedNode carries its path at `properties.filePath`.
  for (const key of Object.keys(rec)) {
    const child = rec[key];
    if (child !== null && typeof child === 'object') {
      const crec = child as Record<string, unknown>;
      for (const pk of pathKeys) {
        if (typeof crec[pk] === 'string') return crec[pk] as string;
      }
    }
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
 * Call this ONLY after a real `DataCloneError` on the fast-path post.
 */
export function makeWorkerResultCloneSafe<T extends Record<string, unknown>>(
  result: T,
  options: MakeCloneSafeOptions,
): { skipped: SkippedPath[] } {
  const pathKeys = options.pathKeys ?? DEFAULT_PATH_KEYS;
  const skipped: SkippedPath[] = [];

  for (const field of Object.keys(result)) {
    if (options.skipFields?.has(field)) continue;
    const value = result[field];
    if (!Array.isArray(value)) continue;
    if (!containsNonCloneable(value, new WeakSet())) continue;

    const dropWhole = options.dropWholeElement.has(field);
    const out: unknown[] = [];
    for (const element of value) {
      if (!containsNonCloneable(element, new WeakSet())) {
        out.push(element);
        continue;
      }
      const path = findFilePath(element, pathKeys) ?? '(unknown)';
      if (dropWhole) {
        skipped.push({ path, reason: `dropped non-serializable ${field} entry` });
        continue;
      }
      const ctx: StripCtx = { stripped: 0, seen: new WeakSet() };
      const cleaned = stripNonCloneable(element, ctx);
      // Last-resort guard: if stripping functions/symbols still left something
      // structured-clone rejects, drop the element rather than re-throw.
      if (isStructuredCloneable(cleaned)) {
        out.push(cleaned);
        skipped.push({
          path,
          reason: `stripped ${ctx.stripped} non-serializable value(s) from ${field}`,
        });
      } else {
        skipped.push({ path, reason: `dropped unsalvageable ${field} entry` });
      }
    }
    (result as Record<string, unknown>)[field] = out;
  }

  return { skipped };
}
