/**
 * On-demand install of the optional local embedding stack (#2370).
 *
 * `@huggingface/transformers` and `onnxruntime-node` are optionalDependencies:
 * npm prunes them (instead of failing the whole install) when
 * `onnxruntime-node`'s postinstall cannot download its CUDA binaries from
 * api.nuget.org — common behind HTTP proxies and regional firewalls, where
 * that download ignores standard proxy env vars and 302 redirects.
 *
 * This module heals such an install without a reinstall: it fetches the stack
 * into a user-level runtime prefix (`~/.gitnexus/embedding-runtime`) straight
 * from the user's configured npm registry — honouring their mirror and proxy
 * settings, the part of their network setup that demonstrably works — with
 * `--ignore-scripts`, so no NuGet download is attempted at all. The CPU ONNX
 * binding ships inside the npm tarball; only CUDA GPU acceleration needs the
 * postinstall, and `installEmbeddingRuntime({ cuda: true })` opts into it.
 *
 * Resolution is package-first: a normally-installed stack always wins, and the
 * runtime prefix is only consulted when the bare specifier does not resolve.
 */
import { createRequire } from 'node:module';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { logger } from '../logger.js';
import { getRegisterHooks } from './node-module-compat.js';

const DEFAULT_EMBEDDING_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Shorter deadline for analyze's auto-install (interactive; must not stall the index run). */
export const ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Deadline for the on-demand npm install. An explicit
 * `GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS` always wins (so a user on a slow
 * mirror can raise it); otherwise `defaultMs` applies. The default is generous
 * (the ONNX stack is a large registry fetch), but latency-sensitive callers
 * (analyze's auto-install) pass a shorter `defaultMs` so a blackholed proxy
 * can't stall the whole run for the full ten minutes. Mirrors
 * `getExtensionInstallTimeoutMs`.
 */
export const getEmbeddingInstallTimeoutMs = (
  defaultMs: number = DEFAULT_EMBEDDING_INSTALL_TIMEOUT_MS,
): number => {
  const raw = process.env.GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
};

/**
 * SIGKILL the npm child and its whole tree. npm spawns a node grandchild, and a
 * plain SIGTERM to the direct child lets the grandchild escape (pr-2169), so on
 * Windows use `taskkill /T /F` (mirrors `killChildTree` in local-cli-client.ts).
 */
const killNpmChild = (child: ChildProcess): void => {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch {
      // Already exited — fall through to child.kill().
    }
  }
  child.kill('SIGKILL');
};

const require = createRequire(import.meta.url);

/** The stack the runtime prefix provides; resolution fallback covers all three. */
const EMBEDDING_STACK_PACKAGES = [
  '@huggingface/transformers',
  'onnxruntime-node',
  'onnxruntime-common',
] as const;

/**
 * User-level prefix the on-demand stack installs into. The env override is
 * `path.resolve`d once here (the single chokepoint) so a relative or empty
 * value can't poison the probes downstream — `createRequire` throws
 * `ERR_INVALID_ARG_VALUE` on a relative anchor, which otherwise made every
 * resolution report "not installed" and reinstall on every run. An empty or
 * whitespace-only value falls through to the default.
 */
export const getEmbeddingRuntimeDir = (): string => {
  const override = process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR?.trim();
  return override ? resolve(override) : join(homedir(), '.gitnexus', 'embedding-runtime');
};

/**
 * The version specs to install — read from gitnexus' own package.json
 * `optionalDependencies` so the on-demand install can never drift from what a
 * normal install would have provided. (The manifest ships in the tarball even
 * when npm pruned the packages themselves.)
 */
export const getEmbeddingStackSpecs = (): Record<string, string> => {
  const manifest = require('../../../package.json') as {
    optionalDependencies?: Record<string, string>;
  };
  const optional = manifest.optionalDependencies ?? {};
  return Object.fromEntries(
    ['@huggingface/transformers', 'onnxruntime-node']
      .filter((name) => optional[name] !== undefined)
      .map((name) => [name, optional[name]]),
  );
};

export interface EmbeddingRuntimeResolution {
  /** 'package': the normally-installed copy; 'runtime-prefix': the on-demand copy. */
  source: 'package' | 'runtime-prefix';
}

/**
 * Whether a runtime-prefix-sourced stack can actually be loaded on this Node
 * (#2372). The prefix mechanism re-anchors bare specifiers via
 * `module.registerHooks`, absent before Node 22.15 / 23.5 — so on 22.0–22.14 and
 * 23.0–23.4 a populated prefix exists but the ESM loader can never reach it. A
 * package-sourced stack never needs the hook and is unaffected. CLI code
 * consumes this predicate (never the compat module directly) to keep messaging
 * truthful instead of promising a prefix runtime the loader can't use.
 */
export const isPrefixRuntimeLoadable = (): boolean => typeof getRegisterHooks() === 'function';

/** Resolution anchored inside the runtime prefix (`<dir>/node_modules`). */
const prefixRequire = () => createRequire(join(getEmbeddingRuntimeDir(), 'noop.js'));

/**
 * True when BOTH load-bearing stack packages resolve from `req`. Probing
 * `@huggingface/transformers` alone is not enough: an interrupted or partial
 * prefix install (transformers extracted, `onnxruntime-node` not yet) would
 * otherwise read as "installed", suppress the self-heal, and fail later at model
 * load. `onnxruntime-common` stays un-probed — it is a regular dependency the
 * #307 resolver owns, never pruned.
 */
const stackResolvesFrom = (req: ReturnType<typeof createRequire>): boolean => {
  try {
    req.resolve('@huggingface/transformers');
    req.resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
};

/**
 * Where the embedding stack resolves from, or `null` when it is not (fully)
 * installed. Resolution only — nothing is imported, so this never loads native
 * code and is safe on every platform.
 */
export const resolveEmbeddingRuntime = (): EmbeddingRuntimeResolution | null => {
  if (stackResolvesFrom(require)) return { source: 'package' };
  if (stackResolvesFrom(prefixRequire())) return { source: 'runtime-prefix' };
  return null;
};

let hookAttempted = false;
// While set, the resolve hook passes straight through. It guards the
// `resolveEmbeddingRuntime()` probe inside the onnxruntime-common gate below:
// today `require.resolve` bypasses these sync hooks, so the probe can't re-enter
// the chain — but the latch makes that acyclicity STRUCTURAL rather than relying
// on that (undocumented, version-specific — verified on Node 22.16) behaviour.
let hookReentrant = false;

/** Whether the stack itself resolved from the runtime prefix — re-entrancy-guarded. */
const stackIsPrefixSourced = (): boolean => {
  hookReentrant = true;
  try {
    return resolveEmbeddingRuntime()?.source === 'runtime-prefix';
  } finally {
    hookReentrant = false;
  }
};

/**
 * Idempotently register the resolution fallback that redirects the embedding
 * stack's bare specifiers to the runtime prefix when normal resolution fails.
 * Mirrors the onnxruntime-common fallback hook (#307): try the default
 * resolution first so a real, package-manager-installed copy always wins, and
 * only re-anchor at the prefix on ERR_MODULE_NOT_FOUND.
 *
 * Must be registered BEFORE the CUDA-13 redirect hook
 * (`ensureOnnxRuntimeNodeMatchesSystem`) — `registerHooks` runs the most
 * recently registered hook first, so registering this one earliest makes it
 * the last-resort fallback in the chain.
 */
export const ensureEmbeddingStackResolvable = (): void => {
  if (hookAttempted) return;
  hookAttempted = true;

  try {
    // Node < 22.15 / < 23.5 (engines floor is >= 22.0.0): no synchronous hooks
    // API. Degrade gracefully — normally-installed stacks still resolve; only
    // the runtime-prefix fallback is unavailable. Reachable now that the import
    // is a namespace access (see node-module-compat.ts) rather than a static
    // named import that would fail at link time.
    const registerHooks = getRegisterHooks();
    if (typeof registerHooks !== 'function') return;

    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (hookReentrant || !(EMBEDDING_STACK_PACKAGES as readonly string[]).includes(specifier)) {
          return nextResolve(specifier, context);
        }
        try {
          return nextResolve(specifier, context);
        } catch (err) {
          const code = (err as { code?: string } | null | undefined)?.code;
          // ESM-only allowlist: never add the CJS `MODULE_NOT_FOUND` — that is
          // what keeps the source probe below (which uses `require.resolve`)
          // from feeding its own miss back into the chain.
          if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
            throw err;
          }
          // onnxruntime-common is version-paired by the #307 resolver, which sits
          // ABOVE this last-resort fallback. Only steal its phantom-import case
          // when the stack itself came from the prefix — otherwise a leftover
          // user-global prefix would hijack #307 for a package-sourced stack and
          // pair a package onnxruntime-node with a version-drifted prefix common.
          if (specifier === 'onnxruntime-common' && !stackIsPrefixSourced()) {
            throw err;
          }
          // Re-anchor at the runtime prefix so Node applies the package's own
          // exports conditions (ESM/CJS) exactly as a normal install would. The
          // anchor is read here (not at registration) so it stays coherent with
          // the current GITNEXUS_EMBEDDING_RUNTIME_DIR.
          const prefixAnchor = pathToFileURL(join(getEmbeddingRuntimeDir(), 'noop.js')).href;
          return nextResolve(specifier, { ...context, parentURL: prefixAnchor });
        }
      },
    });
    logger.debug(
      { prefix: getEmbeddingRuntimeDir() },
      'Installed embedding-runtime resolution fallback (#2370)',
    );
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'embedding-runtime resolution fallback not installed',
    );
  }
};

export interface EmbeddingInstallOptions {
  /**
   * Also fetch the CUDA GPU binaries: runs onnxruntime-node's postinstall
   * (NuGet download — set GLOBAL_AGENT_HTTPS_PROXY behind a proxy). Default
   * false: `--ignore-scripts` + ONNXRUNTIME_NODE_INSTALL=skip, so the install
   * touches only the npm registry and CPU embeddings work everywhere.
   */
  cuda?: boolean;
  /** Progress sink for npm's output lines. */
  onOutput?: (line: string) => void;
}

/** Pure command builder, exported for tests. */
export const buildEmbeddingInstallCommand = (
  opts: EmbeddingInstallOptions = {},
): { args: string[]; env: NodeJS.ProcessEnv } => {
  const specs = getEmbeddingStackSpecs();
  const args = [
    'install',
    '--prefix',
    getEmbeddingRuntimeDir(),
    '--no-fund',
    '--no-audit',
    '--loglevel',
    'error',
    ...(opts.cuda ? [] : ['--ignore-scripts']),
    ...Object.entries(specs).map(([name, spec]) => `${name}@${spec}`),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.cuda) {
    // --cuda opts into the NuGet CUDA download. A user who exported
    // ONNXRUNTIME_NODE_INSTALL=skip per our proxy docs must not have it silently
    // suppress that download and then be told the install succeeded.
    delete env.ONNXRUNTIME_NODE_INSTALL;
  } else {
    env.ONNXRUNTIME_NODE_INSTALL = 'skip';
  }
  return { args, env };
};

/** cmd.exe metacharacters that force quoting (plus whitespace), per Colascione. */
const WIN32_NEEDS_QUOTING = /[\s&|<>^()%!]/;

/**
 * Quote a single argument for the Windows `cmd.exe` shell (#2372). npm is a
 * `.cmd` shim, so the spawn must go through a shell (EINVAL otherwise since
 * CVE-2024-27980), and Node does NOT escape args under `shell: true` — a spaced
 * `--prefix` path splits, and cmd eats the `^` in `@pkg@^1.0.0` semver ranges.
 *
 * Rules (validated against Node source, MS cmd/CRT docs, BatBadBut, Rust std):
 * reject NUL/CR/LF and embedded `"` (both unrepresentable/unsafe at the cmd
 * layer, and `"` is illegal in Windows paths and npm specs); wrap in double
 * quotes when empty or containing whitespace/metacharacters; double the trailing
 * backslash run so the added closing quote is not itself escaped (`C:\` →
 * `"C:\\"`). `^` is literal inside cmd double quotes across all three parse
 * layers (cmd `/c` → npm.cmd's `%*` re-parse → node CRT argv). Two documented
 * ceilings quoting can't close: a defined `%VAR%` expands once at the first cmd
 * parse, and `!` expands only under registry-enabled delayed expansion — both
 * are the env-var owner's trust, out of the malicious-repo threat model.
 */
export const quoteWin32Arg = (arg: string): string => {
  if (/[\0\r\n]/.test(arg)) {
    throw new Error(
      `argument contains NUL/CR/LF, unsafe for the Windows shell: ${JSON.stringify(arg)}`,
    );
  }
  if (arg.includes('"')) {
    throw new Error(
      `argument contains a double quote, unsafe for the Windows shell: ${JSON.stringify(arg)}`,
    );
  }
  if (arg !== '' && !WIN32_NEEDS_QUOTING.test(arg)) return arg;
  const trailingBackslashes = /\\*$/.exec(arg)?.[0].length ?? 0;
  return `"${arg}${'\\'.repeat(trailingBackslashes)}"`;
};

/**
 * Compose a full `cmd.exe` command line: the command stays unquoted (so
 * PATH/PATHEXT resolves a bare name or `.cmd` shim), args are individually
 * quoted. Passing this as spawn's first (only) string argument — no args array
 * — yields a byte-identical `cmd.exe /d /s /c "…"` line while avoiding DEP0190
 * (the runtime deprecation warning Node >=24 emits for
 * `spawn(file, args, {shell:true})`). Exported generically so the real-cmd.exe
 * round-trip test drives the exact same composition the npm spawn uses.
 */
export const composeWin32Command = (command: string, args: string[]): string =>
  [command, ...args.map(quoteWin32Arg)].join(' ');

/** {@link composeWin32Command} for the on-demand npm install (`npm` stays unquoted). */
export const composeWin32NpmCommand = (args: string[]): string => composeWin32Command('npm', args);

/**
 * Install (or update) the embedding stack into the runtime prefix via the
 * user's npm — registry, mirror, and proxy configuration all apply. Rejects
 * with npm's tail output on failure or timeout.
 *
 * The child is bounded by `timeoutMs` (default {@link getEmbeddingInstallTimeoutMs})
 * and SIGKILLed — with its grandchildren — if it overruns, so a blackholed
 * proxy (the exact #2370 environment) can't hang the caller forever. It is also
 * killed if the parent exits mid-install, so a leftover npm can't keep writing
 * into the shared prefix.
 */
export const installEmbeddingRuntime = async (
  opts: EmbeddingInstallOptions = {},
  timeoutMs: number = getEmbeddingInstallTimeoutMs(),
): Promise<void> => {
  const { args, env } = buildEmbeddingInstallCommand(opts);
  await new Promise<void>((resolve, reject) => {
    // Windows `npm` is a `.cmd` shim, so the spawn must go through a shell.
    // Compose the quoted command line ourselves and pass it as spawn's single
    // string arg (no args array) so cmd.exe receives correctly-quoted paths/
    // specs and Node >=24 doesn't warn (DEP0190). POSIX uses the array form.
    // cwd: homedir() so npm reads its config from the user's home, never the
    // analyzed repo's cwd — a project-local .npmrc there can't redirect the
    // registry into the prefix we then load in-process (legacy npm; refuted on
    // npm 10, but this closes the class regardless of npm version).
    const child =
      process.platform === 'win32'
        ? spawn(composeWin32NpmCommand(args), {
            env,
            cwd: homedir(),
            windowsHide: true,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn('npm', args, {
            env,
            cwd: homedir(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
    let tail = '';
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      if (opts.onOutput) text.split('\n').filter(Boolean).forEach(opts.onOutput);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    let settled = false;
    // Kill a still-running npm if the parent exits (analyze's SIGINT handler, or
    // a crash) so it can't keep writing into the shared prefix. Removed on settle.
    const onParentExit = (): void => killNpmChild(child);
    process.on('exit', onParentExit);
    const cleanup = (): void => {
      process.removeListener('exit', onParentExit);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      killNpmChild(child);
      reject(
        new Error(
          `npm install of the embedding runtime timed out after ${timeoutMs}ms ` +
            `(override with GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS) — check your proxy/registry:\n${tail}`,
        ),
      );
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (exitCode === 0) resolve();
      else
        reject(
          new Error(
            `npm install of the embedding runtime failed ` +
              `(${signal ? `killed with ${signal}` : `exit ${exitCode}`}):\n${tail}`,
          ),
        );
    });
  });
};
