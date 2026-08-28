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
  // The gitnexus-plan safe writer resolves every name through a per-platform
  // backend: Linux anchors through /proc/self/fd, macOS resolves lexically and
  // verifies each step against descriptors it holds open. Publication is link(2)
  // on both. #2905 shipped the Darwin backend after the suite had silently
  // skipped on every non-Linux runner, so this file must run on the OS matrix or
  // the macOS half is unverified by construction — and the flag, trailing-
  // separator and hard-link fixtures assert kernel behaviour that only a real
  // Darwin kernel can confirm. Windows is refused by the capability gate; the
  // suite asserts that refusal rather than skipping it.
  'test/unit/evidence-provenance-helper.test.ts',
  // Windows drive-letter case variance in the analyzer runner-identity path
  // fields (#2668): normalizeAnalyzerRootPath is a POSIX no-op, so the
  // "identity path fields are normalizer-stable" fixpoint guard only bites on
  // the windows-latest matrix — it must run there, not just in the Ubuntu
  // full-suite where it's trivially green. Deliberately the split-out
  // normalization file, NOT analyzer-identity.test.ts: the latter's fixture
  // tests compare identity fields against raw temp-dir paths and fail on macOS,
  // where /var/... realpaths to /private/var/....
  'test/unit/analyzer-identity-path-normalization.test.ts',
  // `isInside` containment guard vs Windows cross-drive paths: path.relative
  // returns the absolute target across drives, so the guard needs isAbsolute.
  // Fixture-free and pathApi-injectable, so it is portable to every runner.
  'test/unit/analyzer-identity-is-inside.test.ts',
  // `\\?\` extended-length prefix normalization (#2667): fixture-free and
  // platform-injectable (every assertion passes an explicit 'win32'), so like the
  // is-inside guard above it is portable to every runner and its assertions run
  // identically here and on Ubuntu. Registered alongside its two siblings so the
  // Windows path-handling guards stay discoverable as one group. Same
  // mixed-prefix relativize hazard as is-inside, reached through a
  // caller-supplied path.
  'test/unit/windows-long-path-prefix.test.ts',
  // getconf page-size probe: explicit process.platform gate (win32 short-circuit)
  // plus a live-probe test whose only real non-4K coverage is macos-arm64's
  // 16 KiB pages — the exact hardware class #1231 targets (#2424 review).
  'test/unit/lbug-config-pagesize.test.ts',
  'test/unit/worker-pool-windows-quarantine.test.ts',
  'test/unit/lbug-pool-fts-load.test.ts',
  // Global registry writes use the platform-specific index-lock backend
  // (Windows named pipe, Linux socket, or macOS file lock). This includes the
  // overlapping-registration regression from #2716 on every OS matrix.
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
  // The index write-lock (#2658) selects its backend by process.platform — the
  // OS socket lock (Windows named pipe / Linux abstract socket) vs the file
  // fallback — and its socket-backend describe block is gated to linux/win32.
  // The Ubuntu suite only proves the Linux abstract-socket path, so run it here
  // to exercise the Windows named-pipe backend and the macOS file fallback on
  // their real platforms (#2658 review H3).
  'test/unit/index-lock.test.ts',
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
  // #2623: the incremental writeback must load VECTOR before the CodeEmbedding
  // join-delete, and the blocked path must escalate instead of crashing. The
  // win32 VECTOR gate was removed in the same PR, so this ordering must be
  // proven on the windows-latest native addon, not just Ubuntu. Budget: ~25s
  // on Linux → expect ~2min on the slowest Windows shard.
  'test/unit/incremental-vector-extension-ordering.test.ts',
  // #2841: the FTS half of that same gate, plus the both-extensions-blocked
  // case — and it needs this matrix for two reasons the VECTOR sibling above
  // does not cover. The reported failure environment is a machine where the
  // extension stopped LOADING, which is the #2374 class and Windows-reported
  // (the same reason fts-extension-e2e.test.ts is registered below), so the
  // FTS-unavailable branch has to run on a real Windows/macOS runner rather
  // than only on Ubuntu where FTS always loads. And its both-blocked case is
  // gated on GITNEXUS_REQUIRE_VECTOR=1, which ci-tests.yml sets ONLY on this
  // job — everywhere else an unavailable VECTOR extension skips instead of
  // failing. Budget: four real analyze runs, so expect it to sit alongside the
  // VECTOR sibling's ~87s Windows measurement.
  'test/unit/incremental-index-extension-dml-gate.test.ts',
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
  // Real cross-process single-writer lock coordination (#2658): child processes
  // contend for the lock and race to reclaim a dead holder. Process spawning,
  // kernel socket auto-release (Win named pipe / Linux abstract socket), and the
  // FILE-backend rename-steal reclaim (macOS/BSD default) all vary across OSes —
  // the exact behaviors the Windows/macOS matrix must prove. macOS timing first
  // exposed a file-backend double-admit race here (#2658 review); the reclaim is
  // now judgment-verified so a live holder is never displaced.
  'test/integration/analyze-index-lock-concurrency.test.ts',
  // The per-group sync lock (R9), same class of guarantee one level up: real
  // child processes contend for one group's lock while this process runs a real
  // `syncGroup`, and the CLI case spawns the real command. Everything that
  // varies here is platform-owned — which backend `selectBackend()` picks
  // (Windows named pipe / Linux abstract socket / macOS file lock), kernel
  // auto-release on SIGKILL vs. the file backend's pid-liveness reclaim, and
  // `mkdir` over an occupied path. The fail-closed cases pin
  // GITNEXUS_INDEX_LOCK_BACKEND=file so the filesystem branch is exercised on
  // every OS rather than only where it is the default; no case is skipped on
  // any platform, because a skipped case turns "a sync that cannot be protected
  // does not run" into a claim that holds on Ubuntu only.
  'test/integration/group/group-sync-lock-concurrency.test.ts',
  // The three `dist/` module-load closure guards, all built on the shared
  // child-process probe in `test/helpers/module-load-probe.ts`. That probe IS
  // the platform-varying part: it spawns `process.execPath` in array form,
  // clears NODE_OPTIONS, addresses its target via `pathToFileURL` (Windows needs
  // the `file:///C:/...` form — a bare absolute path is not a valid ESM
  // specifier there), and renders every result through a `path.sep`→POSIX
  // normalisation the anchors and offender regexes depend on. None of that is
  // proven anywhere else.
  //
  // Cheap: measured on the Windows runner at 448 ms, 53 ms and sub-second. An
  // earlier attempt to register them still turned the matrix red — not from
  // their own cost, but because vitest sharded by file COUNT, so inserting any
  // file re-partitioned the list and happened to cluster `cli-e2e` (361 s) with
  // `cli-limit-e2e` (75 s) on one shard. The split is weight-aware now
  // (`scripts/cross-platform-shard.ts`), so a cheap file can no longer move a
  // heavy one.
  //
  // #2802: MCP startup must not eagerly load the analyze-only language
  // provider registry or the group contract extractors.
  'test/integration/mcp/startup-language-closure.test.ts',
  // PR #1383: `cli/mcp.js`'s static-import closure must stay leaf-only so no
  // native binding initialises before the stdout sentinel installs.
  'test/integration/mcp/import-closure.test.ts',
  // #2091/#2093/#2116: the scope-resolution registry must not load the optional
  // tree-sitter grammars at import time. The offender regexes match grammar
  // paths with either separator, which only the Windows runner proves.
  'test/integration/optional-grammars/registry-import-closure.test.ts',
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
  'test/integration/watch-filesystem.test.ts',
  'test/integration/markdown-processor-crlf.test.ts',
  'test/integration/ignore-and-skip-e2e.test.ts',
  // Pins that the bridge pairing verdict is measured before the database is
  // opened. The property it protects is about mtime behavior across OS and
  // filesystem, and the alternative — really opening the bridge — cannot run on
  // Windows at all (in-process write→read reopen of the same bridge.lbug is a
  // documented limitation). Running it on every platform is the whole point:
  // Windows is where an unverified assumption about mtime would hurt most.
  'test/unit/group/bridge-pairing-precedes-open.test.ts',
  // The raw-control-byte guard reads every tracked text file `git ls-files`
  // reports — 4893 of them — and decides membership from the git path, which is
  // always `/`-separated no matter what the host separator is. Both halves of
  // that are platform-varying: the collector basename-matches with
  // `path.posix.basename` against `git ls-files -z` output while the reads go
  // through `path.join`, so on Windows the same string is consumed under two
  // separator conventions in one pass, and only a real windows-latest run
  // proves they agree. It is also the file-count-heaviest read loop in the
  // suite, so it is where a per-file filesystem cost (NTFS + Defender, or
  // macOS's slower stat path) would show up first. No case is skipped on any
  // platform: a guard that only holds on Ubuntu is not a guard on the file
  // whose NUL it exists to catch. Budget: the heaviest single case is one
  // 4893-file pass — 2.3 s on a slow virtualised filesystem, 0.34 s on a local
  // disk — against a 30 s testTimeout.
  'test/unit/source-control-bytes.test.ts',
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
