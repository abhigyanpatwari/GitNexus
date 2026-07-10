/**
 * Cross-platform test subset runner.
 *
 * Runs only the tests that exercise platform-sensitive behavior on
 * Windows and macOS. The full suite runs on Ubuntu; this narrows the
 * cross-platform matrix to tests that actually vary across OSes.
 *
 * Categories included:
 *   - Platform-specific logic (path.sep, process.platform guards)
 *   - Native addon loading (LadybugDB, tree-sitter)
 *   - Process spawning and shell behavior
 *   - Filesystem locking and temp-dir behavior
 *   - Worker threads (real, not mocked)
 *   - CLI end-to-end tests
 *
 * When adding a new test that uses platform-varying APIs (native addons,
 * child_process with real spawning, filesystem locking, path.sep), add
 * it to the appropriate section below.
 *
 * Usage:
 *   npx vitest run $(npx tsx scripts/cross-platform-tests.ts)
 *   # or via the package script:
 *   npm run test:cross-platform
 */

// Platform-specific logic tests — contain explicit process.platform guards
// or test behavior that differs across operating systems
const PLATFORM_LOGIC = [
  'test/unit/setup.test.ts',
  'test/unit/setup-jsonc.test.ts',
  'test/unit/setup-codex.test.ts',
  'test/unit/setup-antigravity.test.ts',
  'test/integration/setup-uninstall-roundtrip.test.ts',
  'test/unit/resolve-invocation.test.ts',
  // CLI-spawn entry-point resolution; its path-separator assertion (cli[/\\]index)
  // must exercise the Windows backslash branch, so run it on the OS matrix (#2394).
  'test/unit/cli-entry.test.ts',
  'test/unit/platform-capabilities.test.ts',
  // getconf page-size probe: explicit process.platform gate (win32 short-circuit)
  // plus a live-probe test whose only real non-4K coverage is macos-arm64's
  // 16 KiB pages — the exact hardware class #1231 targets (#2424 review).
  'test/unit/lbug-config-pagesize.test.ts',
  'test/unit/worker-pool-windows-quarantine.test.ts',
  'test/unit/lbug-pool-fts-load.test.ts',
  'test/unit/repo-manager.test.ts',
  'test/unit/repo-manager-finalize-invariant.test.ts',
  'test/unit/git-utils.test.ts',
  'test/unit/hooks.test.ts',
  'test/unit/hook-db-lock-probe.test.ts',
  'test/unit/cursor-hook.test.ts',
  'test/unit/sidecar-recovery.test.ts',
  'test/unit/pool-wal-recovery.test.ts',
  'test/unit/lbug-adapter-wal-schema.test.ts',
  'test/unit/detect-changes-worktree.test.ts',
  'test/unit/eval-server-bind-restriction.test.ts',
  'test/unit/ignore-service.test.ts',
  'test/unit/group/bridge-db.test.ts',
  'test/unit/group/bridge-db-edge.test.ts',
  'test/unit/onnxruntime-node-resolver.test.ts',
  // Windows cmd.exe arg-quoting + compose-and-spawn for the npm install (#2372):
  // the quoting rules and win32 single-string spawn shape are OS-sensitive, so
  // exercise them on real windows-latest. The spawn-shape/path tests force their
  // platform branch and derive expected paths via the real fns, so they pass on
  // any host (see the platform stubs + resolve() in the test file).
  'test/unit/embedding-runtime-install.test.ts',
  // Real-spawn arg-delivery round-trip: proves the install spawn delivers args
  // to the child intact on each platform — win32 via the cmd.exe -> .cmd %* ->
  // node chain (real cmd.exe, not just our model), macos/linux via the no-shell
  // array form. Runs on every platform (the ubuntu suite covers Linux; this
  // registration adds windows + macos).
  'test/unit/embedding-install-arg-delivery.test.ts',
  // Structural FTS-extension classifier against REAL binaries (#2374): on this
  // matrix `process.execPath` / `lbugjs.node` are a real PE (windows) and Mach-O
  // (macos), so the header parsing is proven on genuine binaries, not synthetic
  // buffers (the ubuntu suite covers the ELF path).
  'test/integration/extension-binary-real.test.ts',
  // Server repo resolver branches on path shape (path.isAbsolute, backslash
  // detection) and canonicalizePath/realpathSync, all of which differ between
  // POSIX and Windows — the fail-closed path-claim semantics must hold on the
  // real windows-latest path implementation (#2419/#2420).
  'test/unit/server-api-repo-resolution.test.ts',
];

// Native LadybugDB integration tests — exercise the @ladybugdb/core
// N-API addon which has known platform-specific behavior (Windows
// file-lock lag after close, macOS N-API destructor segfaults)
const LBUG_NATIVE = [
  'test/integration/lbug-core-adapter.test.ts',
  'test/integration/lbug-vector-extension.test.ts',
  'test/integration/lbug-pool.test.ts',
  'test/integration/lbug-pool-stability.test.ts',
  'test/integration/lbug-lock-retry.test.ts',
  'test/integration/lbug-open-retry.test.ts',
  'test/integration/lbug-close-handle-release.test.ts',
  'test/integration/lbug-orphan-sidecar-recovery.test.ts',
  'test/integration/lbug-readonly-init.test.ts',
  'test/integration/lbug-non-ascii-path.test.ts',
  // Cross-repo trace e2e: builds two real lbug indexes + a real bridge and
  // opens them through the pool adapter (native addon + bridge file locking).
  // Windows is skipped in-file (describeReopen) due to the bridge reopen lock.
  'test/integration/group/cross-trace-e2e.test.ts',
  'test/integration/local-backend.test.ts',
  'test/integration/local-backend-calltool.test.ts',
  'test/integration/search-core.test.ts',
  'test/integration/search-pool.test.ts',
  'test/integration/fts-description-search.test.ts',
  'test/integration/staleness-and-stability.test.ts',
  'test/integration/analyze-wal-checkpoint-failure.test.ts',
  'test/integration/fts-stemmer-sweep.test.ts',
  'test/integration/lbug-multiwriter-deadlock.test.ts',
  // #2409 batched incremental writeback: chunked IN-list DETACH DELETEs +
  // backslash quote escaping against the REAL native engine — the failing
  // environment for #2409 was Windows, so the write pattern must be proven
  // on the windows-latest native addon, not just Ubuntu.
  'test/integration/lbug-delete-nodes-for-files.test.ts',
  // #2409 defect 2: dirty-flag recovery parks lbug.wal/.shadow (rename next
  // to a live native DB, rm-then-rename over an existing parked copy) before
  // any open — rename semantics are exactly what differs on Windows.
  'test/unit/incremental-dirty-recovery.test.ts',
];

// Process spawning and CLI tests — exercise child_process with real
// process spawning, which behaves differently across platforms (shell
// quoting, path resolution, signal handling)
const SPAWN_CLI = [
  'test/integration/cli-e2e.test.ts',
  'test/integration/cli-limit-e2e.test.ts',
  'test/integration/hooks-e2e.test.ts',
  'test/integration/skills-e2e.test.ts',
  // Spawns the real CLI across hermetic HOME/USERPROFILE homes to exercise the
  // FTS extension lifecycle — the #2374 bug was Windows-reported, so this must
  // run on the Windows/macOS matrix, not just the Ubuntu full suite.
  'test/integration/fts-extension-e2e.test.ts',
  'test/integration/server-http-startup.test.ts',
  'test/integration/mcp/server-startup.test.ts',
  'test/integration/analyze-heap-oom-e2e.test.ts',
  'test/integration/group/group-cli.test.ts',
  'test/integration/cli/tool-no-index-stderr.test.ts',
  'test/integration/setup-skills.test.ts',
  'test/integration/setup-antigravity.test.ts',
  'test/integration/antigravity-hook-e2e.test.ts',
  'test/unit/local-cli-subprocess.test.ts',
  'test/unit/runner-exec-tail.test.ts',
];

// Worker threads tests — exercise real worker_threads which have
// platform-specific behavior (thread spawning, IPC, exit handling)
const WORKER_THREADS = [
  'test/integration/worker-pool.test.ts',
  'test/integration/parse-impl-quarantine-cache-skip.test.ts',
];

// Tree-sitter native addon smoke tests — verify that native grammars
// load correctly on each platform (binary compatibility, .node loading)
const NATIVE_ADDON_SMOKE = [
  'test/integration/tree-sitter-languages.test.ts',
  'test/integration/parsing.test.ts',
  'test/integration/pipeline.test.ts',
  'test/integration/pipeline-graph-golden.test.ts',
  'test/unit/parser-loader.test.ts',
  'test/unit/parser-loader-abi.test.ts',
];

// Filesystem behavior tests — exercise operations that vary across
// platforms (CRLF, symlinks, permissions, temp dirs)
const FILESYSTEM = [
  'test/integration/filesystem-walker.test.ts',
  'test/integration/markdown-processor-crlf.test.ts',
  'test/integration/ignore-and-skip-e2e.test.ts',
];

const ALL_CROSS_PLATFORM = [
  ...PLATFORM_LOGIC,
  ...LBUG_NATIVE,
  ...SPAWN_CLI,
  ...WORKER_THREADS,
  ...NATIVE_ADDON_SMOKE,
  ...FILESYSTEM,
];

// When invoked directly, print the file list for vitest consumption
if (process.argv[1]?.endsWith('cross-platform-tests.ts')) {
  console.log(ALL_CROSS_PLATFORM.join('\n'));
}

export {
  ALL_CROSS_PLATFORM,
  PLATFORM_LOGIC,
  LBUG_NATIVE,
  SPAWN_CLI,
  WORKER_THREADS,
  NATIVE_ADDON_SMOKE,
  FILESYSTEM,
};
