/**
 * LadybugDB backend loader.
 *
 * Tries native @ladybugdb/core first (fast, pre-built binary).
 * Falls back to @ladybugdb/wasm-core when no native binary exists
 * for the current platform (e.g. darwin-x64).
 */

import { createRequire } from 'module';

// Minimal local type definitions covering the subset used by GitNexus.
// Both native and WASM backends satisfy these at runtime; the `as any`
// cast bridges the minor signature differences (e.g. query() return type
// is `QueryResult | QueryResult[]` in native but `QueryResult` in WASM).
export interface LbugDatabase {
  close(): Promise<void>;
}

export interface LbugQueryResult {
  getAll(): Promise<any[]>;
  getAllRows?(): Promise<any[]>;
  hasNext(): boolean | Promise<boolean>;
  getNext(): Promise<any>;
}

export interface LbugPreparedStatement {
  isSuccess(): boolean;
  getErrorMessage(): string | Promise<string>;
  close?(): void | Promise<void>;
}

export interface LbugConnection {
  query(cypher: string): Promise<any>;
  prepare(cypher: string): Promise<LbugPreparedStatement>;
  execute(stmt: LbugPreparedStatement, params?: Record<string, any>): Promise<any>;
  close(): Promise<void>;
}

export interface LbugBackend {
  Database: new (path: string, ...args: any[]) => LbugDatabase;
  Connection: new (db: any, ...args: any[]) => LbugConnection;
}

let _backend: LbugBackend | null = null;
let _isWasm = false;

/** Platforms that ship a prebuilt @ladybugdb/core native binary. */
const NATIVE_PLATFORMS = new Set([
  'darwin-arm64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]);

/**
 * Load the LadybugDB backend. Cached after first call.
 * Safe to call multiple times — returns the same instance.
 *
 * On platforms without a prebuilt native binary (e.g. darwin-x64),
 * skips the native import entirely to avoid a fatal process.dlopen crash.
 */
export async function getLbugBackend(): Promise<LbugBackend> {
  if (_backend) return _backend;

  const platformKey = `${process.platform}-${process.arch}`;
  if (NATIVE_PLATFORMS.has(platformKey)) {
    try {
      const native = await import('@ladybugdb/core');
      _backend = (native.default || native) as LbugBackend;
      _isWasm = false;
      return _backend;
    } catch {
      // Native import failed even on a supported platform — fall through to WASM
    }
  }

  // WASM fallback — use the Node.js-specific entry point which uses
  // worker_threads instead of browser Workers.
  // The ./nodejs subpath only exports via "require", so we use createRequire.
  const esmRequire = createRequire(import.meta.url);
  const mod = esmRequire('@ladybugdb/wasm-core/nodejs') as any;
  await mod.init();

  // Shim: WASM QueryResult has getAllRows() but not getAll().
  // Native has getAll() but not getAllRows(). GitNexus code calls getAll(),
  // so we alias it on the WASM QueryResult prototype.
  const qrPath = esmRequire.resolve('@ladybugdb/wasm-core/nodejs').replace(/index\.js$/, 'query_result.js');
  const QR = esmRequire(qrPath);
  const QRProto = (QR.default || QR).prototype;
  if (QRProto && !QRProto.getAll && QRProto.getAllRows) {
    QRProto.getAll = QRProto.getAllRows;
  }

  _backend = mod as LbugBackend;
  _isWasm = true;
  return _backend;
}

/** Returns true if the current backend is WASM (set after first getLbugBackend() call). */
export function isWasmBackend(): boolean {
  return _isWasm;
}
