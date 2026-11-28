/**
 * Fault class of a failed MCP tool call: the caller's mistake (`client`) or a
 * failure of the server, its engine or its storage (`server`).
 *
 * The class is attached where an error is born — a non-enumerable mark on the
 * error object, or a report into the per-call scope when a tool turns a caught
 * error into an `{ error }` result. It is not derived from the message text:
 * engines and wrappers phrase messages freely, so a typo and a storage failure
 * can read alike while their origins never do. The one exception is a native
 * engine error from the caller's own cypher statement, whose class comes from
 * the engine exception category the engine puts at the start of its message
 * (see the read pool's category table).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type FaultClass = 'client' | 'server';

/** The class an engine exception category gives, or `unrecognized` for none known. */
export type EngineFault = FaultClass | 'unrecognized';

/** Where a native query failed: preparing the statement or running it. */
export type QueryStage = 'prepare' | 'execute';

const FAULT_CLASS = Symbol.for('gitnexus.faultClass');
const QUERY_STAGE = Symbol.for('gitnexus.queryStage');
const ENGINE_FAULT = Symbol.for('gitnexus.engineFault');
const MAX_CAUSE_DEPTH = 5;

/**
 * Set a mark once: a later mark on the same value does not replace the first.
 * Frozen and non-extensible values are left unmarked.
 */
function setMark(value: unknown, key: symbol, mark: string): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  try {
    if (Object.prototype.hasOwnProperty.call(value, key) || !Object.isExtensible(value)) return;
    Object.defineProperty(value, key, { value: mark, enumerable: false, configurable: true });
  } catch {
    // A proxy or exotic object refused the property; the value stays unmarked.
  }
}

/**
 * Read a mark from the value itself, then along its `cause` chain: the value's
 * own mark wins over any mark further down the chain. Never throws: a throwing
 * `cause` getter or proxy trap reads as unmarked.
 */
function readMark(value: unknown, key: symbol): string | undefined {
  try {
    let current = value;
    for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
      if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
        return undefined;
      }
      const own = Object.getOwnPropertyDescriptor(current, key);
      if (own && typeof own.value === 'string') return own.value;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Fall through: an unreadable value has no mark.
  }
  return undefined;
}

/**
 * Mark `value` with a fault class and return it unchanged otherwise. Message,
 * name, code, stack and JSON serialization stay the same.
 */
export function markFault<T>(value: T, fault: FaultClass): T {
  setMark(value, FAULT_CLASS, fault);
  return value;
}

/** An `Error` the caller can fix by changing the call. */
export function clientError(message: string, options?: ErrorOptions): Error {
  return markFault(new Error(message, options), 'client');
}

/** Filesystem error codes that the path itself causes, whoever opens it. */
const CLIENT_PATH_ERROR_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'ENAMETOOLONG',
  'ELOOP',
  'EINVAL',
  'ERR_INVALID_ARG_VALUE',
]);

/**
 * Mark an error from opening a path the caller supplied: a missing, malformed
 * or wrong-kind path is a client fault, decided by `code`. Permission, I/O and
 * descriptor-limit errors, and errors without a code, stay unmarked and so
 * classify as server faults.
 */
export function markPathFault<T>(err: T): T {
  let code: unknown;
  try {
    code = (err as { code?: unknown } | null)?.code;
  } catch {
    return err;
  }
  return typeof code === 'string' && CLIENT_PATH_ERROR_CODES.has(code)
    ? markFault(err, 'client')
    : err;
}

/** The fault class marked on `value`, or else on the nearest error in its `cause` chain. */
export function faultOf(value: unknown): FaultClass | undefined {
  const mark = readMark(value, FAULT_CLASS);
  return mark === 'client' || mark === 'server' ? mark : undefined;
}

export function markQueryStage<T>(value: T, stage: QueryStage): T {
  setMark(value, QUERY_STAGE, stage);
  return value;
}

export function queryStageOf(value: unknown): QueryStage | undefined {
  const stage = readMark(value, QUERY_STAGE);
  return stage === 'prepare' || stage === 'execute' ? stage : undefined;
}

/**
 * Mark an error the database engine raised while preparing or running a
 * statement with the class its engine exception category gives it.
 */
export function markEngineFault<T>(value: T, fault: EngineFault): T {
  setMark(value, ENGINE_FAULT, fault);
  return value;
}

/** The engine mark on `value` itself, not along its `cause` chain. */
function ownEngineMark(value: unknown): EngineFault | undefined {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return undefined;
    }
    const mark = Object.getOwnPropertyDescriptor(value, ENGINE_FAULT)?.value;
    return mark === 'client' || mark === 'server' || mark === 'unrecognized' ? mark : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The engine class marked on `value` itself, not along its `cause` chain: an
 * error the adapter builds around an engine error (the read-only refusal)
 * keeps the adapter's class. An engine error without a recognized category is
 * a server fault.
 */
export function engineFaultOf(value: unknown): FaultClass | undefined {
  const mark = ownEngineMark(value);
  return mark === 'unrecognized' ? 'server' : mark;
}

interface FaultRecord {
  client: boolean;
  server: boolean;
}

const scopeStore = new AsyncLocalStorage<FaultRecord>();

/** Collects the faults reported while one tool call runs. */
export interface FaultScope {
  run<T>(fn: () => T): T;
  /** `server` if any server fault was reported, `client` if only client ones, else undefined. */
  fault(): FaultClass | undefined;
}

export function createFaultScope(): FaultScope {
  const record: FaultRecord = { client: false, server: false };
  return {
    run: (fn) => scopeStore.run(record, fn),
    fault: () => (record.server ? 'server' : record.client ? 'client' : undefined),
  };
}

/** Record a fault for the current tool call; a no-op outside a scope. */
export function reportFault(fault: FaultClass): void {
  const record = scopeStore.getStore();
  if (record) record[fault] = true;
}

/**
 * Record the class of an error a tool caught and turned into a result. With
 * `clientQuery`, an error raised while preparing or running the caller's own
 * statement takes the class of the engine exception category the read pool
 * marked on it (a statement the engine cannot parse, bind or run is the
 * caller's; a storage, I/O or connection failure, or an unrecognized
 * category, the server's), overriding the server mark every error leaving the
 * read pool carries. With `missingParameter` as well (the statement names a
 * parameter the call did not pass), an engine error without a recognized
 * category is the caller's: that is how the engine reports the missing
 * parameter. An error the adapter raises at that stage (the query timeout,
 * the read-only refusal) has no engine class and is the caller's. Anything
 * else keeps its mark, and an unmarked error is a server fault.
 */
export function reportCaughtFault(
  err: unknown,
  options?: { clientQuery?: boolean; missingParameter?: boolean },
): void {
  if (options?.clientQuery && queryStageOf(err) !== undefined) {
    const engine = ownEngineMark(err);
    reportFault(
      engine === 'unrecognized'
        ? options.missingParameter
          ? 'client'
          : 'server'
        : (engine ?? 'client'),
    );
    return;
  }
  reportFault(faultOf(err) ?? 'server');
}
