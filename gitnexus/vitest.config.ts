import { defineConfig } from 'vitest/config';
import PerfSequencer from './test/helpers/perf-sequencer.js';

export default defineConfig({
  test: {
    // Shared settings — inherited by all projects via extends: true
    testTimeout: 30000,
    hookTimeout: 120000,
    pool: 'forks',
    globals: true,
    teardownTimeout: 3000,
    // E2E harnesses pin a small NODE_OPTIONS heap so spawned CLI children
    // stay light; without this opt-out the #2649 auto-heap override would
    // respawn every such child with a RAM-sized cap. Children inherit it via
    // the harnesses' `{ ...process.env }` spreads. Tests that exercise the
    // respawn behavior itself delete GITNEXUS_MEMORY in their own setup.
    env: { GITNEXUS_MEMORY: 'off' },
    // N-API destructors can crash worker forks on macOS during process exit.
    // This is independent of the QueryResult lifetime fix in @ladybugdb/core 0.15.2 —
    // it's a vitest forks + native addon interaction where destructors run in
    // arbitrary order at exit. Tests themselves pass; only the exit crashes.
    // TODO: remove once LadybugDB fixes all N-API destructor ordering issues.
    dangerouslyIgnoreUnhandledErrors: true,

    // Coverage stays at root (not supported in project configs)
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli/index.ts', // CLI entry point (commander wiring)
        'src/server/**', // HTTP server (requires network)
        'src/core/wiki/**', // Wiki generation (requires LLM)
      ],
      // Auto-ratchet: vitest bumps thresholds when coverage exceeds them.
      // CI will fail if a PR drops below these floors.
      thresholds: {
        statements: 26,
        branches: 23,
        functions: 28,
        lines: 27,
      },
    },

    // Balance shards by estimated work rather than file count, so the
    // spawn-heavy sequential suites spread evenly across shard runners instead
    // of clustering onto one (see test/helpers/perf-sequencer.ts). Only shard()
    // is overridden — groupOrder and sort order are left to the base sequencer.
    sequence: {
      sequencer: PerfSequencer,
    },

    // LadybugDB's native mmap addon causes file-lock conflicts when vitest
    // runs lbug test files in parallel forks on Windows.  The 'lbug-db'
    // project forces sequential execution (fileParallelism: false).
    //
    // Each file runs in its own fork — the fork exits after the file
    // completes, triggering an N-API destructor segfault that is caught
    // by dangerouslyIgnoreUnhandledErrors.  Tests themselves pass; only
    // the exit crashes.  This is safer than isolate: false, which causes
    // native state corruption after 2-3 open/close cycles in the same fork.
    projects: [
      {
        extends: true,
        test: {
          name: 'lbug-db',
          include: [
            'test/integration/impact-epistemic-lower-bound.test.ts',
            'test/integration/impact-scope-omission-persistence.test.ts',
            'test/integration/lbug-core-adapter.test.ts',
            'test/integration/lbug-vector-extension.test.ts',
            'test/integration/lbug-pool.test.ts',
            'test/integration/lbug-pool-stability.test.ts',
            'test/integration/local-backend.test.ts',
            'test/integration/local-backend-calltool.test.ts',
            'test/integration/spring-aop-mcp.test.ts',
            // Native @ladybugdb/core: loads a real graph through loadGraphToLbug
            // and asserts the Destination NULL/join invariant on the stored rows.
            'test/integration/spring-destinations-lbug.test.ts',
            'test/integration/search-core.test.ts',
            'test/integration/search-pool.test.ts',
            'test/integration/fts-description-search.test.ts',
            'test/integration/fts-fullfile-search.test.ts',
            'test/integration/fts-cjk-segmentation-search.test.ts',
            'test/integration/augmentation.test.ts',
            'test/integration/staleness-and-stability.test.ts',
            'test/integration/lbug-lock-retry.test.ts',
            'test/integration/lbug-open-retry.test.ts',
            'test/integration/lbug-close-handle-release.test.ts',
            'test/integration/api-impact-e2e.test.ts',
            'test/integration/shape-check-regression.test.ts',
            'test/integration/java-class-impact.test.ts',
            'test/integration/class-impact-all-languages.test.ts',
            'test/integration/lbug-orphan-sidecar-recovery.test.ts',
            'test/integration/lbug-readonly-init.test.ts',
            'test/integration/analyze-wal-checkpoint-failure.test.ts',
            'test/integration/lbug-non-ascii-path.test.ts',
            'test/integration/lbug-conn-serialization.test.ts',
            'test/integration/group/manifest-resolve-symbol-2325.test.ts',
            'test/integration/group/manifest-synthetic-impact-lbug.test.ts',
            'test/integration/group/http-route-resolve-symbol.test.ts',
            'test/integration/group/graphql-resolve-symbol.test.ts',
            'test/integration/fts-stemmer-sweep.test.ts',
            'test/integration/lbug-multiwriter-deadlock.test.ts',
            'test/integration/extension-binary-real.test.ts',
            'test/integration/lbug-delete-nodes-for-files.test.ts',
            'test/integration/lbug-query-importers-batch.test.ts',
            'test/integration/impact-ambiguous-blast-radius.test.ts',
            // #2915. Native @ladybugdb/core via withTestLbugDB(poolAdapter:true),
            // and it drives detect_changes over a real git repo — the mmap
            // file-lock exposure this project serializes (TESTING.md § Vitest
            // projects), on the Windows/macOS platforms #2915 was reported from.
            'test/integration/detect-changes-path-anchoring.test.ts',
            // #2915. Native @ladybugdb/core via withTestLbugDB(poolAdapter:true) —
            // the wiki's graph queries executed by a real engine rather than a
            // fake that answers on `query.includes(...)`.
            'test/integration/wiki-graph-queries-engine.test.ts',
            'test/unit/incremental-dirty-recovery.test.ts',
            'test/unit/incremental-orchestration.test.ts',
            // #2841. Native @ladybugdb/core: it runs real analyses, reopens the
            // DB under different extension-install policies, and reads
            // SHOW_INDEXES on the writable connection — exactly the mmap
            // file-lock exposure this project exists to serialize (TESTING.md
            // § Vitest projects). Registering it here does NOT narrow where it
            // runs: vitest applies `--shard` once to the combined cross-project
            // spec list (PerfSequencer/assignShards is a complete, disjoint
            // partition), and run-cross-platform.ts hands vitest explicit file
            // paths, which resolve against every project's include list. Its
            // `incremental-vector-extension-ordering` /
            // `incremental-fts-drop-ordering` siblings are equally native and
            // still sit in `default` — pre-existing drift, deliberately left
            // alone here.
            'test/unit/incremental-index-extension-dml-gate.test.ts',
          ],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'default',
          sequence: { groupOrder: 3 },
          include: ['test/**/*.test.ts'],
          exclude: [
            'test/integration/impact-epistemic-lower-bound.test.ts',
            'test/integration/impact-scope-omission-persistence.test.ts',
            'test/integration/lbug-core-adapter.test.ts',
            'test/integration/lbug-vector-extension.test.ts',
            'test/integration/lbug-pool.test.ts',
            'test/integration/lbug-pool-stability.test.ts',
            'test/integration/local-backend.test.ts',
            'test/integration/local-backend-calltool.test.ts',
            'test/integration/spring-aop-mcp.test.ts',
            'test/integration/spring-destinations-lbug.test.ts',
            'test/integration/search-core.test.ts',
            'test/integration/search-pool.test.ts',
            'test/integration/fts-description-search.test.ts',
            'test/integration/fts-fullfile-search.test.ts',
            'test/integration/fts-cjk-segmentation-search.test.ts',
            'test/integration/augmentation.test.ts',
            'test/integration/staleness-and-stability.test.ts',
            'test/integration/lbug-lock-retry.test.ts',
            'test/integration/lbug-open-retry.test.ts',
            'test/integration/lbug-close-handle-release.test.ts',
            'test/integration/api-impact-e2e.test.ts',
            'test/integration/shape-check-regression.test.ts',
            'test/integration/java-class-impact.test.ts',
            'test/integration/class-impact-all-languages.test.ts',
            'test/integration/lbug-orphan-sidecar-recovery.test.ts',
            'test/integration/lbug-readonly-init.test.ts',
            'test/integration/analyze-wal-checkpoint-failure.test.ts',
            'test/integration/lbug-non-ascii-path.test.ts',
            'test/integration/lbug-conn-serialization.test.ts',
            'test/integration/group/manifest-resolve-symbol-2325.test.ts',
            'test/integration/group/manifest-synthetic-impact-lbug.test.ts',
            'test/integration/group/http-route-resolve-symbol.test.ts',
            'test/integration/group/graphql-resolve-symbol.test.ts',
            'test/integration/skills-e2e.test.ts',
            'test/integration/fts-extension-e2e.test.ts',
            'test/integration/fts-stemmer-sweep.test.ts',
            'test/integration/lbug-multiwriter-deadlock.test.ts',
            'test/integration/extension-binary-real.test.ts',
            'test/integration/lbug-delete-nodes-for-files.test.ts',
            'test/integration/lbug-query-importers-batch.test.ts',
            'test/integration/impact-ambiguous-blast-radius.test.ts',
            'test/integration/detect-changes-path-anchoring.test.ts',
            'test/integration/wiki-graph-queries-engine.test.ts',
            'test/unit/incremental-dirty-recovery.test.ts',
            'test/unit/incremental-orchestration.test.ts',
            // Excluded here because it is included by `lbug-db` above; a file
            // in two projects would be collected (and run) twice.
            'test/unit/incremental-index-extension-dml-gate.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'cli-e2e',
          include: [
            'test/integration/skills-e2e.test.ts',
            // Spawns the real CLI per test; runs sequentially (fileParallelism:
            // false) so it doesn't aggravate the under-load timeout-flake class.
            'test/integration/fts-extension-e2e.test.ts',
          ],
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
