import { spawn } from 'child_process';
import { fileURLToPath } from 'node:url';
import { LBUG_MAX_DB_SIZE } from './lbug-config.js';
import { diagnoseExtensionLoad, type ExtensionLoadDiagnosis } from './extension-load-error.js';
import { logger } from '../logger.js';

const DEFAULT_EXTENSION_INSTALL_TIMEOUT_MS = 15_000;
const EXTENSION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Lifecycle policy for an optional DuckDB extension.
 *
 * - `auto`     — try `LOAD`, fall back to one bounded out-of-process `INSTALL`
 *                attempt per process if `LOAD` fails. Default for analyze.
 * - `load-only`— try `LOAD` only; never spawn an installer. Used by serve/MCP
 *                read paths so user queries never block on a network install.
 * - `never`    — skip the extension entirely. Operators can use this to
 *                forcibly disable optional search features.
 */
export type ExtensionInstallPolicy = 'auto' | 'load-only' | 'never';

export interface ExtensionInstallResult {
  success: boolean;
  timedOut: boolean;
  message: string;
}

/** Snapshot of one optional extension's resolved capability state. */
export interface ExtensionCapability {
  name: string;
  loaded: boolean;
  /** Human-readable reason when `loaded` is false. */
  reason?: string;
  /**
   * Classified diagnosis of `reason`, computed ONCE at mark-unavailable time so
   * per-request surfaces (ftsDegradedWarning on /api/search + MCP query) read the
   * cached remedy instead of re-inspecting the extension file on every call (#2383 F3).
   */
  diagnosis?: ExtensionLoadDiagnosis;
}

/** Per-call overrides applied on top of `ExtensionManager` defaults. */
export interface ExtensionEnsureOptions {
  policy?: ExtensionInstallPolicy;
  installTimeoutMs?: number;
}

export interface ExtensionManagerOptions {
  policy?: ExtensionInstallPolicy;
  installTimeoutMs?: number;
  installExtension?: (
    extensionName: string,
    timeoutMs: number,
    loadError?: string,
  ) => Promise<ExtensionInstallResult>;
  warn?: (message: string) => void;
}

const alreadyAvailable = (message: string): boolean =>
  message.includes('already loaded') ||
  message.includes('already installed') ||
  message.includes('already exists');

/** LadybugDB errors are multi-line; collapse for single-line warn/reason strings. */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const resolvePolicyFromEnv = (): ExtensionInstallPolicy => {
  const raw = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
  if (raw === 'load-only' || raw === 'never' || raw === 'auto') return raw;
  return 'load-only';
};

export const getExtensionInstallPolicy = (): ExtensionInstallPolicy => resolvePolicyFromEnv();

/**
 * Install policy for the **analyze (write) path**.
 *
 * The global default (`resolvePolicyFromEnv`) is `load-only` so serve/query
 * read paths never require outbound network access (PR #1161, offline-first).
 * The analyze path is different: it owns building the search indexes, so it
 * defaults to `auto` — LOAD the extension if present, otherwise attempt one
 * bounded out-of-process INSTALL. This keeps FTS symmetric with the
 * VECTOR/embeddings path (which already defaults to `auto`) and matches the
 * #726 contract. An explicit `GITNEXUS_LBUG_EXTENSION_INSTALL` value still
 * wins, so operators can force `load-only`/`never` for fully offline analyze;
 * `auto` LOADs-first, so offline machines still degrade gracefully when the
 * INSTALL cannot reach the network.
 */
export const resolveAnalyzeInstallPolicy = (): ExtensionInstallPolicy => {
  const raw = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
  if (raw === 'load-only' || raw === 'never' || raw === 'auto') return raw;
  return 'auto';
};

export const getExtensionInstallTimeoutMs = (): number => {
  const raw = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXTENSION_INSTALL_TIMEOUT_MS;
};

export const getExtensionInstallChildProcessArgs = (
  extensionName: string,
  maxDbSize: number = LBUG_MAX_DB_SIZE,
): string[] => {
  const childScript = new URL('../../../scripts/install-duckdb-extension.mjs', import.meta.url);
  return [fileURLToPath(childScript), extensionName, String(maxDbSize)];
};

/**
 * Run `INSTALL <extension>` in a short-lived child Node process so the parent
 * event loop is never blocked by DuckDB's synchronous network call.
 *
 * The child opens its own scratch LadybugDB, executes the install, and exits.
 * If the child exceeds `timeoutMs` the parent kills it with SIGKILL and
 * resolves with `timedOut: true`.
 */
export const installDuckDbExtensionOutOfProcess = async (
  extensionName: string,
  timeoutMs: number = getExtensionInstallTimeoutMs(),
  loadError?: string,
): Promise<ExtensionInstallResult> => {
  if (!EXTENSION_NAME_PATTERN.test(extensionName)) {
    throw new Error(`Invalid DuckDB extension name: ${extensionName}`);
  }

  return await new Promise<ExtensionInstallResult>((resolve) => {
    const child = spawn(process.execPath, getExtensionInstallChildProcessArgs(extensionName), {
      env: {
        ...process.env,
        GITNEXUS_LBUG_EXTENSION_NAME: extensionName,
        // The child picks INSTALL vs FORCE INSTALL from this LOAD error so it
        // only re-downloads when the on-disk extension file is actually broken.
        ...(loadError ? { GITNEXUS_LBUG_EXTENSION_LOAD_ERROR: loadError } : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        success: false,
        timedOut: true,
        message: `extension install for ${extensionName} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, timedOut: false, message: err.message });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        success: code === 0,
        timedOut: false,
        message:
          code === 0
            ? `extension install for ${extensionName} completed`
            : `extension install for ${extensionName} failed with ${signal ?? `exit code ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`,
      });
    });
  });
};

/**
 * Centralized lifecycle manager for optional LadybugDB extensions.
 *
 * Always tries `LOAD EXTENSION <name>` first — it is per-connection,
 * idempotent, and never touches the network. If `LOAD` fails and the active
 * policy permits, the manager runs a single bounded out-of-process `INSTALL`
 * attempt per process and retries `LOAD`. Capability outcomes are cached so
 * unavailable extensions degrade search features without ever blocking
 * subsequent analyze or query calls.
 *
 * Policy precedence (most specific wins):
 *   per-call `opts.policy` → constructor `options.policy` → env → `load-only`
 */
export class ExtensionManager {
  private readonly capabilities = new Map<string, ExtensionCapability>();
  private readonly installAttempted = new Map<string, ExtensionInstallResult>();
  private readonly warnedKeys = new Set<string>();

  constructor(private readonly options: ExtensionManagerOptions = {}) {}

  /** Reset cached capability and install state. Test-only. */
  reset(): void {
    this.capabilities.clear();
    this.installAttempted.clear();
    this.warnedKeys.clear();
  }

  /** Snapshot of currently-known optional extension capabilities. */
  getCapabilities(): ExtensionCapability[] {
    return Array.from(this.capabilities.values());
  }

  /**
   * Ensure an optional extension is loaded on the supplied connection.
   *
   * Returns `true` when the extension is usable on `query`, `false` when it
   * is unavailable. Never throws on install failure — analyze and query
   * paths are expected to degrade gracefully.
   */
  async ensure(
    query: (sql: string) => Promise<unknown>,
    name: string,
    label: string,
    opts: ExtensionEnsureOptions = {},
  ): Promise<boolean> {
    if (!EXTENSION_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid DuckDB extension name: ${name}`);
    }

    const policy = opts.policy ?? this.options.policy ?? resolvePolicyFromEnv();
    const timeoutMs =
      opts.installTimeoutMs ?? this.options.installTimeoutMs ?? getExtensionInstallTimeoutMs();
    const warn = this.options.warn ?? ((msg: string) => logger.warn(msg));

    if (policy === 'never') {
      this.markUnavailable(name, label, 'extension install policy is "never"', warn);
      return false;
    }

    const loadError = await this.tryLoad(query, name);
    if (loadError === null) {
      this.markLoaded(name);
      return true;
    }

    if (policy === 'load-only') {
      this.markUnavailable(
        name,
        label,
        `load-only policy (no install attempted); LOAD ${name} failed: ${loadError}`,
        warn,
      );
      return false;
    }

    let install = this.installAttempted.get(name);
    if (!install) {
      const installFn = this.options.installExtension ?? installDuckDbExtensionOutOfProcess;
      // Hand the child the LOAD error so it re-downloads (FORCE) only when the
      // present extension file is provably broken, not on every LOAD failure.
      install = await installFn(name, timeoutMs, loadError);
      this.installAttempted.set(name, install);
    }

    if (!install.success) {
      this.markUnavailable(
        name,
        label,
        `${install.message}; LOAD ${name} had failed: ${loadError}`,
        warn,
      );
      return false;
    }

    const retryError = await this.tryLoad(query, name);
    if (retryError === null) {
      this.markLoaded(name);
      return true;
    }

    this.markUnavailable(
      name,
      label,
      `LOAD ${name} failed after successful INSTALL: ${retryError}`,
      warn,
    );
    return false;
  }

  /**
   * Attempt `LOAD EXTENSION <name>`; returns `null` on success and the
   * collapsed error message on failure. The message is the load-side ground
   * truth — LadybugDB distinguishes a missing extension file from a present
   * but unloadable one (wrong platform, truncated download, version mismatch),
   * and discarding it left users staring at "not pre-installed" when the file
   * existed all along (#2374).
   */
  private async tryLoad(
    query: (sql: string) => Promise<unknown>,
    name: string,
  ): Promise<string | null> {
    try {
      await query(`LOAD EXTENSION ${name}`);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return alreadyAvailable(msg) ? null : oneLine(msg);
    }
  }

  private markLoaded(name: string): void {
    this.capabilities.set(name, { name, loaded: true });
  }

  private markUnavailable(
    name: string,
    label: string,
    reason: string,
    warn: (message: string) => void,
  ): void {
    // Classify once here (the single load-failure sink, run per Database not per
    // request) so the hot per-request warning path does no file I/O (#2383 F3).
    this.capabilities.set(name, {
      name,
      loaded: false,
      reason,
      diagnosis: diagnoseExtensionLoad(reason),
    });
    const key = `${name}:${reason}`;
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    warn(
      `GitNexus: ${label} extension unavailable; continuing without ${label} features. ${reason}`,
    );
  }
}

/** Process-wide singleton shared by core and pool adapters. */
export const extensionManager = new ExtensionManager();

/** Snapshot of which optional DuckDB extensions are loaded in this process. */
export const getExtensionCapabilities = (): ExtensionCapability[] =>
  extensionManager.getCapabilities();

/** Test-only: clear the singleton's cached capability and install state. */
export const resetExtensionState = (): void => extensionManager.reset();
