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
  'test/unit/platform-capabilities.test.ts',
  'test/unit/worker-pool-windows-quarantine.test.ts',
  'test/unit/lbug-pool-win-fts-probe.test.ts',
  'test/unit/repo-manager.test.ts',
  'test/unit/repo-manager-finalize-invariant.test.ts',
  'test/unit/hooks.test.ts',
  'test/unit/cursor-hook.test.ts',
  'test/unit/sidecar-recovery.test.ts',
  'test/unit/pool-wal-recovery.test.ts',
  'test/unit/detect-changes-worktree.test.ts',
  'test/unit/eval-server-bind-restriction.test.ts',
  'test/unit/ignore-service.test.ts',
  'test/unit/group/bridge-db.test.ts',
  'test/unit/group/bridge-db-edge.test.ts',
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
  'test/integration/local-backend.test.ts',
  'test/integration/local-backend-calltool.test.ts',
  'test/integration/search-core.test.ts',
  'test/integration/search-pool.test.ts',
  'test/integration/staleness-and-stability.test.ts',
  'test/integration/analyze-wal-checkpoint-failure.test.ts',
];

// Process spawning and CLI tests — exercise child_process with real
// process spawning, which behaves differently across platforms (shell
// quoting, path resolution, signal handling)
const SPAWN_CLI = [
  'test/integration/cli-e2e.test.ts',
  'test/integration/hooks-e2e.test.ts',
  'test/integration/skills-e2e.test.ts',
  'test/integration/server-http-startup.test.ts',
  'test/integration/mcp/server-startup.test.ts',
  'test/integration/analyze-heap-oom-e2e.test.ts',
  'test/integration/group/group-cli.test.ts',
  'test/integration/cli/tool-no-index-stderr.test.ts',
  'test/integration/setup-skills.test.ts',
  'test/integration/setup-antigravity.test.ts',
  'test/integration/antigravity-hook-e2e.test.ts',
  'test/unit/local-cli-subprocess.test.ts',
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
