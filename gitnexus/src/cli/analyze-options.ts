/**
 * CLI-facing `analyze` option shape.
 *
 * This is the *flag* shape: it mirrors what Commander parses off the command
 * line and what `.gitnexusrc` may set, before `analyze` translates it into the
 * core orchestrator's own `AnalyzeOptions` (`core/run-analyze.ts`) — a
 * different, deliberately separate interface (`stats` here vs `noStats`
 * there, `embeddings?: boolean | string` here vs a resolved
 * `embeddingsNodeLimit` there).
 *
 * It lives in this leaf module because both `analyze.ts` (which consumes the
 * flags) and `analyze-config.ts` (which maps `.gitnexusrc` keys onto them)
 * need it, and `analyze.ts` already imports the config loader — a type import
 * back the other way put the two files, plus `core/run-analyze.ts`, in an
 * import cycle. `analyze.ts` re-exports the type for existing importers.
 */
export interface AnalyzeOptions {
  /** Keep this repository current with serialized incremental refreshes. */
  watch?: boolean;
  /** Watch quiet period in milliseconds. */
  debounce?: string;
  force?: boolean;
  repairFts?: boolean;
  /**
   * Embedding generation toggle. Commander parses `--embeddings [limit]` as:
   *   - `undefined` when the flag is omitted
   *   - `true` when passed without an argument (use default 50K node cap)
   *   - a string when passed with an argument (`--embeddings 0` disables the
   *     cap, `--embeddings <n>` uses `<n>` as the cap)
   */
  embeddings?: boolean | string;
  /**
   * Explicitly drop existing embeddings on rebuild instead of preserving
   * them. Without this flag, a routine `analyze` keeps any embeddings
   * already present in the index even when `--embeddings` is omitted.
   */
  dropEmbeddings?: boolean;
  skills?: boolean;
  verbose?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /**
   * Build the control-flow-graph / PDG substrate (#2081 M1). Opt-in; off by
   * default. Threaded to both the worker (CFG build) and scope-resolution
   * (BasicBlock/CFG emit).
   */
  pdg?: boolean;
  /**
   * Stats inclusion in AGENTS.md and CLAUDE.md.
   *
   * Commander.js represents `--no-stats` as `stats: boolean` (default
   * `true`; `false` when the user passes `--no-stats`), NOT as
   * `noStats: boolean`. Reading the negated form would always be
   * `undefined` and the flag would silently no-op (#1477). Consumers
   * that want "did the user request --no-stats?" should compare with
   * `=== false` to distinguish the explicit-off case from the
   * default-on case.
   */
  stats?: boolean;
  /**
   * Opt-in auto-commit of any AGENTS.md/CLAUDE.md changes this `analyze` run
   * makes. Scoped to only those two files (never `git add -A`); no-ops
   * silently if neither exists, neither changed, or the commit step itself
   * fails (e.g. no git identity configured). See #2639.
   */
  selfCommit?: boolean;
  /** Skip installing standard GitNexus skill files directly under .claude/skills/. */
  skipSkills?: boolean;
  /**
   * Default branch for the generated regression-compare example (#243). From
   * `--default-branch`; may also be supplied via `.gitnexusrc`. Resolved to a
   * concrete branch (CLI > `.gitnexusrc` > auto-detected origin/HEAD > "main")
   * before being threaded into the generated AGENTS.md / CLAUDE.md content.
   */
  defaultBranch?: string;
  /**
   * Index-branch selector (#2106). From `--branch`. Distinct from
   * `defaultBranch` (cosmetic base_ref): this routes the index to a per-branch
   * slot. NOT sourced from `.gitnexusrc` — the `.gitnexusrc` `branch` key is an
   * alias for `defaultBranch` and must not change index placement. Defaults to
   * the checked-out branch inside `runFullAnalysis` when omitted.
   */
  branch?: string;
  /** Pure index mode: skip all file injection (AGENTS.md, CLAUDE.md, skills). */
  indexOnly?: boolean;
  /** Index the folder even when no .git directory is present. */
  skipGit?: boolean;
  /**
   * Override the default basename-derived registry `name` with a
   * user-supplied alias (#829). Disambiguates repos whose paths share a
   * basename. Persisted — subsequent re-analyses of the same path without
   * `--name` preserve the alias.
   */
  name?: string;
  /**
   * Allow registration even when another path already uses the same
   * `--name` alias (#829). Intentionally a distinct flag from `--force`
   * because the user may want to coexist under the same name WITHOUT
   * paying the cost of a pipeline re-index. Maps to registerRepo's
   * `allowDuplicateName` option end-to-end.
   */
  allowDuplicateName?: boolean;
  /**
   * Override the walker's large-file skip threshold (#991). Value in KB;
   * clamped downstream to the tree-sitter 32 MB ceiling. Sets
   * `GITNEXUS_MAX_FILE_SIZE` for the rest of the pipeline.
   */
  maxFileSize?: string;
  /** Override worker sub-batch idle timeout in seconds. */
  workerTimeout?: string;
  /** Control LadybugDB WAL auto-checkpoint threshold during analyze. */
  walCheckpointThreshold?: string;
  /** Parse worker pool size (>=1); 0 is rejected (no sequential mode). */
  workers?: string;
  embeddingThreads?: string;
  embeddingBatchSize?: string;
  embeddingSubBatchSize?: string;
  embeddingDevice?: string;
  /**
   * Extra fetch-wrapper function names to treat as HTTP consumers (#1589/#1852
   * residual). Supplied via `.gitnexusrc` `fetchWrappers: [...]`. Threaded into
   * the routes phase, where the cross-file consumer scan unions them with the
   * auto-detected `fetch()` wrappers so a custom/axios-based wrapper named
   * outside the built-in convention still produces `route_map` consumers.
   */
  fetchWrappers?: string[];
  /**
   * Explicit local Spring Boot Actuator snapshot input (#2418). Accepts a JSON
   * bundle or a directory containing endpoint JSON files. Disabled by default.
   */
  springActuator?: string;
  /**
   * Explicit local AsyncAPI 3.x document input. Accepts a directory of
   * documents or a single document, resolved against the repository root so an
   * out-of-band cache and a committed directory are equally usable. Disabled by
   * default.
   */
  asyncapiSpec?: string;
  /** OpenAI-compatible embeddings base URL (incl. /v1). Overrides GITNEXUS_EMBEDDING_URL. */
  embeddingBaseUrl?: string;
  /** Embedding model name. Overrides GITNEXUS_EMBEDDING_MODEL. */
  embeddingModel?: string;
  /** Bearer token for the embeddings endpoint. Overrides GITNEXUS_EMBEDDING_API_KEY. Never logged. */
  embeddingAuthToken?: string;
  /** Embedding vector dimensions (positive integer string). Overrides GITNEXUS_EMBEDDING_DIMS. */
  embeddingDims?: string;
}
