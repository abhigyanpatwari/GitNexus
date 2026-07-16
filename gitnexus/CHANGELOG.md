# Changelog

All notable changes to GitNexus will be documented in this file.

## [Unreleased]

## [1.6.9] - 2026-07-04

### Added

- **Flat workspace index follows the checked-out branch** — the default (non-multi-branch) index now tracks `git checkout` instead of staying pinned to the branch it was created on (#2364)
- **Spring DI resolver for `@Autowired List<T>` injection** — collection-typed constructor/field injection resolves to all matching bean implementations (#2200)
- **Opt-in CJK bigram segmentation for FTS search** — improves search relevance over Chinese/Japanese/Korean text (#2339)
- **Compact, description-forward embedding text** — shorter, more targeted embedding input for symbol search (#2333, #2334)
- **`Route` nodes get a `(method, url)` identity** — distinct HTTP verbs on the same URL are no longer merged into one node (#2289, #2302)
- **Nuxt/Nitro auto-imports resolved in the TypeScript scope resolver** (#2026)
- **Doc comments searchable across all languages** via FTS (#2286)
- **Cross-file and inline HTTP handler resolution for `group`** — named handlers across files (#2275, #2277) and inline provider handlers via call-site line (#2276, #2282)
- **Cross-repo call trace using PDG** for `group` (#2269)
- **Java and Python conservative taint source/sink models** (#2267, #2253)
- **Java and Kotlin HTTP consumer extraction expanded**, with Kotlin Spring provider parity (#2268, #2254, #1888)
- **Django route extraction for multi-repo `group`** (#1836)
- **Kilo Code + GitNexus MCP setup guide** (#2259)

### Fixed

- **Index metadata renamed to `gitnexus.json`** with dual-write compatibility for existing indexes (#2363)
- **Java call graph** — cast-wrapped and `this.method()` receivers now resolve call edges (#2357)
- **Icon imports consolidated** — fixes stale refs and a package-name collision (#2343)
- **Embeddings** — CUDA 13 hosts now use a system-matched `onnxruntime-node` build for GPU acceleration (#2341)
- **Ladybug single-writer transaction contention** now retries instead of failing (#2342)
- **`--limit` CLI flag** — i18n-safe, guards 0/negative values, and truncates at the correct path (#2310)
- **Ladybug pinned to 0.18.0**, validating the multi-writer deadlock fix (#2340)
- **Full text file content stays searchable** in the FTS index (#2323)
- **Vector distance threshold made configurable** (#2330)
- **LadybugDB-incompatible multi-label Cypher replaced** in `group` queries (#2325, #2327)
- **Windows `@group` reopen** — read-only bridge handle is cached to fix repeated reopen failures (#2274, #2313)
- **FTS stemmer made configurable** (#2307)
- **FastAPI `APIRouter` constructor prefixes applied** to nested routes (#2312)
- **MCP `api_impact` response shape stabilized** for same-URL multi-verb routes (#2308, #2309)
- **Generator function declarations indexed** (#2305)
- **FTS indexes the `description` field** so doc comments are keyword-searchable (#2300)
- **Spring interface-inherited routes resolved** (#2288, #2290)
- **Spring method-level array-form route mappings recognized** (#2281)
- **MCP `impact` callgraph mode tolerates adapter-materialized `line:0`** (#2279, #2283)
- **Kotlin `fun interface` extraction** via a tree-sitter-kotlin re-vendor (#2271)
- **`--pdg analyze` double-free fixed** — LadybugDB close-destructor crash avoided and connection serialization hardened (#2264)

### Changed

- **Root README restructured and all READMEs fact-checked** (#2360)
- **Bundled skill reference drift fixed** in docs (#2362)

### Performance

- **`group`/HTTP route extraction skips source parsing** for files already covered by the graph (#2138 Part 2, #2265)

### Chore / Dependencies

- **gitnexus runtime** — bump `node-addon-api` 8.8.0 → 8.9.0 (#2366), `commander` 14.0.3 → 15.0.0 (#2322), `onnxruntime-node` (#2321), `onnxruntime-common` (#2320), `uuid` 14.0.0 → 14.0.1 (#2285)
- **gitnexus dev** — bump `@types/node` (#2273)
- **gitnexus-web** — bump `lucide-react` (#2349), `@langchain/langgraph` (#2344), `@playwright/test` (#2346), `@langchain/openai` (#2348, #2291), `@langchain/google-genai` (#2345), `langchain` 1.4.4 → 1.4.6 (#2294), `@vitest/coverage-v8` (#2297), `lru-cache` 11.3.6 → 11.5.1 (#2298), `@langchain/core` (#2293)
- **CI** — bump `softprops/action-gh-release` 3.0.0 → 3.0.1 (#2352), `actions/cache` 5.0.5 → 6.1.0 (#2351), `actions/setup-python` 6.2.0 → 6.3.0 (#2350), `actions/checkout` 6.0.3 → 7.0.0 (#2292), `release-drafter/release-drafter` 7.3.1 → 7.4.0 (#2295)

## [1.6.8] - 2026-06-20

### Added

- **PDG-backed impact analysis (opt-in)** — `impact` gains a `mode: 'pdg'` that runs statement-level and inter-procedural program slicing for far more precise blast radius, with resolved-callee-id soundness and validation by a mutation oracle; the default call-graph mode is unchanged (#2227)
- **Program Dependence Graph substrate across the language matrix** — a control-flow-graph layer landed for TS/JS (#2099) and was extended to PDG/CFG visitors for every supported language (#2197); on top of it an intra-procedural `REACHING_DEF` data-dependence layer (#2160), value-position branches (`if`/`when`/`switch`/`match`/`try` used as expressions) modeled as control dependence (#2211), and full control dependence via post-dominators + a Ferrante-style CDG (#2188). All layers are opt-in behind `--pdg`; a default `analyze` run stays byte-identical (#2082, #2085, #2205, #2207, #2195)
- **Taint analysis** — intra-procedural taint tracking over the PDG (#2164) plus inter-procedural taint via function summaries propagated over resolved `CALLS` edges (#2179) (#2083, #2084)
- **Multi-branch indexing and branch-scoped querying** — analyze and query a repository per branch, with each branch stored under its own subdirectory and the primary branch layout left unchanged (#2137, #2106)
- **Private GitHub repos via PAT + Azure DevOps Server support** — `gitnexus analyze` can clone private GitHub repositories with a personal access token and supports Azure DevOps Server remotes (#2223, #2076, #2210)
- **MCP `trace` tool** — returns the shortest call path between two symbols (#2173)
- **MCP HTTP server** — `gitnexus mcp --http` exposes the server over Streamable HTTP with legacy SSE transport support (#2141)
- **HTTP route extraction** — Java Spring route annotations are now extracted into `Route` nodes (#2078), and the HTTP method is persisted on each `Route` node (#2234, #2138)
- **`gitnexus analyze` circular import cycle check** (#2166)
- **`gitnexus analyze` embeddings flags** — `--embeddings-baseurl`, `--embeddings-model`, `--embeddings-auth-token`, and `--embeddings-dims` to point analyze at a custom embeddings provider (#2140)
- **`gitnexus setup` coding-agent integration selection** — choose which coding-agent integrations to install during setup (#2168)
- **C++ CUDA source extensions parsed** — `.cu`/`.cuh` files are now ingested (#2213)

### Fixed

- **`impact()` / `route_map` under-reporting blast radius** — name-resolution gaps that caused callers and routes to be dropped are fixed, with ambiguous symbols reported per-candidate (#2136, #2129, #1858, #1852)
- **Single-ancestor method override detection in the MRO processor** (#2199)
- **MCP `query` / `cypher` parameter names** — renamed so Claude Code can invoke them, while still accepting the legacy parameter (#2186)
- **C++ overload resolution** — homogeneous braced-init overloads are now ranked (#2214), deleted overload winners are suppressed (#2094), and the C++ hook layer handles pack-base comments and missing hook overrides (#2247)
- **Large-repo `analyze` crash** — the pipeline now survives non-cloneable worker results instead of aborting (#2135, #2112)
- **Embeddings** — `onnxruntime-common` resolves under pnpm-strict / `pnpm dlx` installs (#2139, #307), and the `VECTOR` index is created via `conn.query` rather than the prepared-statement path that silently skipped it (#2114)
- **Vendored tree-sitter grammars** — loaded from `vendor/` by absolute path so analyze finds them regardless of CWD (#2144, #2111)
- **Registry wipe on transient I/O errors prevented** — a failed read no longer clears the repository registry (#2124)
- **Server roots resolve from `GITNEXUS_HOME`** — clone, upload, and mapping roots honor the configured home directory (#2229)
- **Wiki generation keeps the graph DB pinned** so it is not evicted mid-generation (#2232)
- **Group sync pins repositories** so large groups resolve their cross-repo links (#2191)
- **Web viewer** — a chat-only mode for large projects prevents the WebUI from hanging (#2185, #2178), and the broken Browse-for-folder control was replaced with an upload directory picker (#1850)
- **Hooks** — the augment CLI child is wrapped in the orphan guard (#2169), db-lock probe subprocesses are bounded and gated behind a hook slot (#2165), and the MCP-owned-DB augment-skip diagnostic is silenced for strict hook runners (#2134, #2163, #1913)
- **Docker image ships runtime-needed published assets** — `hooks/` and `skills/` are copied into the image so `gitnexus analyze` no longer crashes with `MODULE_NOT_FOUND` (#2132, #2130)
- **`gitnexus analyze` preserves trailing spaces in git roots** (#2192)
- **Write-route origin guard scoped to the server's own bound host** (#2172)
- **Impact PDG Mutation Report workflow** — fixed three latent oracle bugs (dist-CLI invocation under Node ≥ 22.18 type-stripping, undeclared `@babel/*` deps, and a recall-gated check filter) so the mutation oracle CI runs green (#2258)

### Changed

- **tree-sitter readiness/summary CI hardened** — readiness and grammar-update workflows aligned on a shared manifest (#2187, #858), readiness summary counts kept current (#2196), and the summary now fails on parse drift (#2246)
- **Devcontainer simplified** — Dockerfile and `devcontainer.json` no longer pin version args for the AI CLIs (#2174)

### Performance

- **Graph-DB emit/persistence** — cut overall emit/persistence wall time (#2215) and overlap node `COPY` with relationship emit (#2226) (#2203)
- **PDG/CFG emit** — streaming/chunked PDG graph emit for full-kernel-scale repos (#2216, #2202) and an SSA-sparse reaching-defs solver replacing the dense-set worklist (#2212, #2201)
- **Hook db-lock scan** — cmdline-first on Linux, dropping the `lsof` fallback (#2183, #2180)

### Chore / Dependencies

- **gitnexus runtime** — bump `hono` 4.12.23 → 4.12.26 (#2244), `tar` 7.5.13 → 7.5.16 (#2218), `protobufjs` 7.5.8 → 7.6.4 (#2219), `js-yaml` 4.1.1 → 4.2.0 (#2097, #2217), and an `npm_and_yarn` security group (3 updates) (#2220)
- **gitnexus dev** — bump `vitest` 4.1.8 → 4.1.9 (#2249), `@vitest/coverage-v8` (#2250), `esbuild` 0.28.0 → 0.28.1 (#2182), and `@types/node` (#2128, #2222)
- **gitnexus-web** — bump `react-dom` 19.2.6 → 19.2.7 (#2240), `langchain` 1.4.2 → 1.4.4 (#2149), `@langchain/langgraph` (#2235), `@langchain/ollama` (#2236), `mnemonist` 0.39.8 → 0.40.4 (#2237), `lucide-react` (#2238), `sigma` 3.0.2 → 3.0.3 (#2151), `dompurify` 3.4.7 → 3.4.8 (#2150, #2245), `@vercel/node` (#2156), and `@vitest/coverage-v8` (#2153)
- **eval** — bump `aiohttp` (#2224)
- **CI actions** — bump `gitleaks/gitleaks-action` 2.3.9 → 3.0.0 (#2241), `github/codeql-action` 4.36.0 → 4.36.2 (#2242), `actions/checkout` 6.0.2 → 6.0.3 (#2152), `actions/attest-build-provenance` 2.4.0 → 4.1.0 (#2158), `docker/setup-qemu-action` 4.0.0 → 4.1.0 (#2159), `release-drafter/release-drafter` 7.3.0 → 7.3.1 (#2157), and `actions/setup-python` 5.6.0 → 6.2.0 (#2155)

## [1.6.7] - 2026-06-09

### Added

- **Toolchain-free tree-sitter install** — the `c`, `dart`, `proto`, `kotlin`, and `swift` grammars now ship vendored native prebuilds (six platform/arch each — linux/darwin/win32 × x64/arm64, every `.node` load-and-parse verified with committed `SHA256SUMS` and SLSA build provenance), so a fresh install no longer requires a C/C++ toolchain; `kotlin` moved off its `optionalDependency` into the vendored path, `dart`/`proto` keep a source-build fallback when no prebuild matches, and a registry-parameterized CI workflow builds, load-validates, and vendors the binaries (#2113, #2125, #2110)
- **`gitnexus uninstall`** — reverses `gitnexus setup` target-by-target, surgically removing GitNexus MCP server entries (Cursor, Claude Code, Antigravity, OpenCode, Codex), installed skill directories, and Claude Code / Antigravity hook entries with their bundled scripts; idempotent, JSONC-preserving, dry-run by default with `--force` to apply (#2062, #2060)
- **MCP `list_repos` pagination** — bounded `limit`/`offset` paging so clients can reliably enumerate every indexed repository instead of having the unpaginated array truncated by LLM token limits; the result is now a `{ repositories, pagination }` object (page until `pagination.hasMore` is false), with deterministic `(lower-cased name, path)` ordering (#2120, #2119)
- **C++ inheritance-lattice member lookup** — receiver members now resolve through the inheritance lattice with dominance hiding, ambiguous-base suppression, virtual-diamond deduplication, and overload ranking, and class-scope `using Base::member` declarations are no longer mistaken for namespace imports (#2077, #1891)
- **Taint/PDG substrate (M0)** — foundational graph schema and pipeline seams for reliable taint analysis on a PDG-expandable substrate: the `BasicBlock` node label and `CFG` / `REACHING_DEF` / `TAINTED` / `SANITIZES` / `TAINT_PATH` relationship types (round-tripped through the bulk-COPY path), a phase-registry seam (`registerPhase` / `enabledWhen`) generalising the graph-phase opt-in guard, and a per-language source/sink/sanitizer config registry. All additive and inert — no phase emits the new nodes/edges yet and a default `analyze` run is byte-identical to before (#2092, #2080)

### Fixed

- **Optional grammars lazy-loaded so `analyze` never crashes when one is missing** — the swift/dart/kotlin `query.ts` modules no longer statically import their tree-sitter binding at module load, so a missing optional grammar can no longer abort `gitnexus analyze` (or the MCP server, `doctor`, and `.githooks` auto-reindex) with `ERR_MODULE_NOT_FOUND` regardless of the repo's actual languages; grammars now resolve lazily at first use inside the worker, `GITNEXUS_SKIP_OPTIONAL_GRAMMARS` is honored at runtime, the scope-resolution phase excludes unavailable-language files, and skip diagnostics/precheck globs were corrected (#2101, #2091, #2093)
- **`tree-sitter-kotlin` optional-grammar install** — install now fails soft when no C/C++ toolchain is present, emitting one clear warning and always exiting 0 (mirroring the Swift/Dart/Proto probes) instead of breaking `gitnexus` install; optional-grammar/toolchain docs corrected to include Kotlin (#2110, #2107)
- **CLI image FTS keyword search** — the full-text-search extension is now baked into the CLI Docker image so a containerized `serve` does offline keyword search instead of silently degrading to vector-only (#2108)

### Changed

- **Tree-sitter prebuild CI matrix greened and made re-run-safe** — dropped the broken `-t 22` flag from the `prebuildify` invocation that crashed every matrix job (`v.indexOf is not a function`; N-API prebuilds are Node-version-agnostic, so no target is needed) (#2121), cleared npm-bundled `prebuilds/` before prebuildify so the host tuple is detected (not a stray `win32-x64`) and source-built the `tree-sitter` runtime peer on `linux-arm64` where upstream ships no prebuild (#2122), and switched the vendor-prebuilds push to `git push --force` so re-running a workflow no longer fails with a stale-lease rejection (#2123)

### Performance

- **MCP `query` enrichment batched** — the `query` tool now batches its per-symbol enrichment lookups (3N sequential pool round-trips collapsed to 2–3 `WHERE n.id IN $nodeIds` queries), cutting N+1 round-trips with byte-identical output (#2108)

### Chore / Dependencies

- **`@ladybugdb/core` bumped 0.17.0 → 0.17.1 in /gitnexus** (#2098)
- **Claude plugin manifests synced to the release version** — bumped `plugin.json` and the `gitnexus` `marketplace.json` entry to match the published npm version (stale `1.3.x` manifests had blocked marketplace updates), added a Vitest guard asserting all three manifests advertise one version, and documented the sync step in `CONTRIBUTING.md` (#2090)

## [1.6.6] - 2026-06-08

### Added

- **Scope-resolution (RFC #909) migrations completed across the language matrix** — Rust (#1639), JavaScript (#1640), Ruby (#1831), Swift (#937, #1948), Vue SFC (#940, #1950), Dart (#939, #1970), COBOL (#941, #1835, #1842), and Kotlin (#1727, #1746, #1782) now run on the registry-primary path; Java reached 100% scope-resolution parity and joined `MIGRATED_LANGUAGES` (#1805); per-language progress reporting added to the scope-resolution phase (#1813)
- **HTTP route & consumer contract extraction (group mode)** — Spring interface routes attributed to controllers (#1743); named/positional Java Spring route args (#1834); Kotlin Spring HTTP route, consumer, and WebClient long-form extraction (#1849, #1855, #1884); Java HTTP consumer contracts (#1872); OpenFeign `@RequestLine` consumer contracts incl. plain interfaces without `@FeignClient` (#1904, #1917); FastAPI `include_router(prefix=...)` cross-file routes (#1877); indirect call patterns via FastAPI `Depends()` and frontend HTTP consumers (#1852); gRPC consumer FQN derivation from Java imports for client-jar consumers (#1889)
- **C++ overload & template resolution** — operator-call resolution (#1754), template partial ordering (#1885), user-defined conversion ranking (#1829), nullptr/ellipsis pointer conversion ranks (#1708), SFINAE filter (#1623), expanded `type_traits` constraint registry (#1648), structured resolver-suppression outcomes (#1785), function-type ADL entities (#1822), and a parameter-type class sidecar (#1642)
- **Go enhancements** — structural interface implementation inference (#1966) and a `builtInNames` set for the Go language provider (#1886)
- **Self-healing worker pool** — automatic worker replacement plus deferred-resolution observability and verbose progress logging (#1741, #1773, #1947)
- **`.gitnexusrc` config file and `gitnexus analyze --default-branch`** (#243, #1996)
- **CLI / MCP impact ergonomics** — `--uid/--file/--kind` disambiguation flags (#1907, #1914), `limit/offset/summaryOnly` pagination on the impact tool (#1818), and a per-symbol `processes` field on `byDepth` items (#1867)
- **`gitnexus analyze --repair-fts`** — enforces FTS verification with hardened repair safeguards (#1720)
- **Web viewer** — Tree View and Circles View (#1799), GitLab repository URLs (#1565), `GITNEXUS_BACKEND_URL` env var for Docker deployments (#1286), and web + CLI internationalization (#1748)
- **Wiki** — local Claude/Codex providers (#1769), an opencode local provider (#2039), and `gitnexus wiki --lang <lang>` for multilanguage wiki generation (#1613)
- **`detect-changes` git-worktree support** (#1654)
- **DeepSeek V4 API support** (#1594)
- **Devcontainer for the Claude / Codex / Cursor CLIs** (#1875) and antigravity integration setup + hook adapter (#1730)
- **Object-literal methods linked to exported bindings** (#1718)
- **`eval-server --host`** for a user-configured bind IP (#1667)
- **PR reviewer swarm agents** (#1851)
- **tree-sitter node-type/field validation gate** — validates against the grammar and removes dead literal handling (#1937)

### Fixed

- **Parsing-layer coverage gaps closed across the language matrix** (umbrella #1919) — remaining open gaps (#2072) plus Java F35/F38/F41 (#1928, #2045), PHP F53/F54/F55 (#1931, #1989), COBOL F17–F23 (#1925, #1959), Rust F66/F68/F71/F72 (#1934, #1974), Python F57/F58/F61 (#1932, #1964), JS/TS F44/F83/F85/F86/F87 (#1929, #1968), and Ruby F62 (#1933, #1972)
- **Fully-qualified nested-type identity for C++ and Ruby** — distinct nodes for union-, anonymous-namespace-, and same-tail-nested types (#1978, #1981, #2004, #2005); cross-namespace same-tail inheritance bases resolved (#1993, #2005); Ruby same-tail nested mixin modules qualified with `IMPLEMENTS` routed by scope (#1991, #2006); shared codec for `__heritage__`/`__property__` markers (#1994, #2007); graph nodes materialized for scoped class/module/impl declarations (#1975, #1977); generic Rust inherent-impl methods owned through the mod-qualified `Impl` node (#1992, #2003)
- **C# resolution & memory** — global-namespace `typeBindings` O(files²) OOM eliminated (#1871, #1954) and namespace-siblings OOM with worker-path re-parse removed (#1905); qualified/alias constructor names, `:base`/`:this` initializers, and generic type-arg stripping (#2046); primary-base receiver type normalization (#2036); spurious `IMPORTS` edges from ungated `using` resolution stopped (#1881, #1908)
- **C++ dependent-base and member lookup** — resolution across nested/inline namespaces (#1634, #1814), base-specifier qualifier threading (#1815, #1819), call-site types threaded into qualified member lookup (#1632, #1810), variadic pack dependent lookup (#1909), uninitialized multi-declarators (#1965), and typedef-enum / anonymous-struct declarations (#1941)
- **Kotlin type resolution** — smart-cast refinement for `when/is` and `if/is` (#1758, #1774), overload target-id by parameter types (#1761, #1777), cross-file iterable return propagation (#1759, #1775), method-chain fixpoint receiver types (#1760, #1776), virtual dispatch via constructor type override (#1762, #1778), interface default-method dispatch via implements-split MRO (#1763, #1779), and default-parameter arity detection (#2034)
- **Go declarations** — multi-name declaration capture (#2032), fixed-array parameter binding normalization (#1988), and generic composite-literal constructor inference F33 (#1976)
- **Rust / PHP / Vue / Java parsing** — Rust `struct_expression` name pattern split (#2051); PHP import decomposition, namespace-less `.phtml` module scopes, and Blade-template exclusion (#1801, #1790, #1989); Vue JSDoc, dual-script merge, and lang plumbing F89/F90/F92 (#1936, #2050); Java inherited `RequestMapping` prefix deduplication (#2057) and same-module type resolution for duplicate FQNs (#1712)
- **TypeScript** — HOC pattern false positives fixed with `export default` HOC support (#1943) and suffix-index reuse in the scope resolver (#1840)
- **Inheritance on the worker path** — all languages' inheritance migrated to scope-resolution in worker mode (#1951, #1956); centralized heritage supertype matching (#1921, #1922, #1940); `File->Member` `DEFINES` edges skipped for class members (#1949); phantom `Function` defs for array-method callbacks no longer emitted (#1906)
- **MCP** — sibling-clone repo-ID collisions prevented and generated MCP tool names corrected (#2067); orphan processes avoided by handling stdin close/end and the startup race (#2049); duplicate-name repo resolution disambiguated for worktrees (#1753); Windows setup fallback when global `gitnexus` resolves to a non-spawnable shim (#1694)
- **Worker pool** — resilient zero-copy ingestion worker pool prevents analyze hangs on TS-root-scale loads (#1693); cache-hit native workers no longer abort (#1751, #1833); worker-pool docs drift corrected and worker-side stack surfaced on crash (#2068, #2070)
- **LadybugDB** — FTS loaded in the Windows read pool (#2040) and probed-then-loaded on Windows (#1690, #1692); non-ASCII KuzuDB paths resolved on Windows (#1811, #1817); WAL corruption detected in schema init with recovery surfaced (#1647, #1650); WAL checkpoint-threshold control (#1772); init lock skipped for read-only opens (#1783, #1784); `serve` kept stable when sidecars are missing (#1747)
- **Server / API** — `gitnexus serve` startup restored under Express 5 (#1749); `/api/graph`, `/api/search`, `/api/grep` opened read-only (#1686); native read-only enforcement and prepared statements for Cypher query paths (#1655); `eval-server` localhost binding left to the OS (#1722)
- **Embeddings** — local ONNX runtime guarded on macOS Intel before the transformers.js import (#1987)
- **Web agent** — Nexus AI agent system prompt aligned with registered tools (#1984) and the agent stopped cleanly on user Stop (#1820)
- **Group / contracts** — HTTP graph and source contracts unioned (#1709); `httpx` `AsyncClient` alias imports detected (#1687); Node gRPC `loadPackageDefinition` gate no longer matches every member call (#1916); manifest/workspace extraction moved before `closeLbug` (#1802, #1807)
- **Hooks / install** — `gitnexus` resolved on `PATH` via a pure-Node, all-OS scan (#1938, #1980); offline-first extension installs (#1161); actionable error and docs for the `pnpm dlx`/`pnpx` native-load crash (#307, #1967); `onnxruntime-common` declared as a runtime dependency (#2074); vendored grammars materialized to fix Windows EPERM (#1728, #1729)
- **CLI** — missing LadybugDB native binary detected at startup with actionable guidance (#835, #1837); `--no-stats` applied to the keep-marker stats line (#1706, #1765); skipped large-file paths surfaced by default (#1659, #1661); build.js skipped when running outside the monorepo (#1795, #1816); auto-heap raised to 16 GB with tightened cross-platform OOM guidance for UE5-scale repos (#1652)
- **Wiki** — hidden 60s default timeout removed with timeout/retry flag validation and surfaced timeout errors (#1651); budget-aware grouping to prevent context overflow on large repos (#627, #1832)
- **`detect-changes`** — `resolveWorktreeCwd` guarded against overriding a separately-indexed worktree (#1691)
- **Windows reliability** — `windowsHide:true` passed to every `child_process` spawn-family call (#1794)

### Changed

- **Legacy resolution deletion (Ring 4)** — removed the legacy call-resolution DAG + heritage processor (RING4-1, #942, #2023), the legacy resolution-context + tiered-lookup plumbing (RING4-2, #943, #2033), and the shadow-mode parity harness (RING4-3, #944, #2071)
- **CONTRIBUTING** — clarified local development setup (#2024)
- **Tests / CI** — cli-e2e made read-only and eval-server tests hardened under load (#2000, #1786, #1838, #1688); parity shards consolidated and the cross-platform matrix narrowed (#1798); devcontainer smoke build hardened against Docker Hub flakes (#1969); gitleaks stabilized (#2027)

### Performance

- **Linux-kernel-scale analysis overhaul** — worker-pool parse, finalize O(n²), and the scope-resolution memory wall (#1983, #2038)
- **Scope-capture linearized across all languages (O(n²)→O(n))** plus Python import-resolution linearization (#1918), the Go-specific re-walk fix (#1848, #1915), and owner-keyed lookup for Step 2 member resolution (#1657)
- **C++ ADL candidates indexed once instead of per-site rescans** (#1990)
- **Inert local value symbols pruned** during ingestion (#2065)

### Chore / Dependencies

- `@ladybugdb/core` bump in /gitnexus (#2056)
- Routine dependency bumps across /gitnexus, /gitnexus-web, /eval, and GitHub Actions — incl. `hono`, `vitest`, `@vitest/coverage-v8`, `tsx`, `lru-cache`, `express`/`@types/express`, `express-rate-limit`, `qs`, `node-addon-api`, `brace-expansion`, `langchain`, `i18next`, `dompurify`, `lucide-react`, `axios`, `zod`, `@langchain/langgraph`, `@vercel/node`, `langsmith`, `aiohttp`, `idna`, and the `docker/*` / `github/codeql-action` / `release-drafter` / `dependency-review-action` actions (#2056, #2044, #2043, #2042, #2016, #2015, #2013, #2012, #2011, #2010, #2009, #2008, #2018, #2019, #2017, #2020, #1986, #1911, #1864, #1863, #1861, #1860, #1866, #1844, #1845, #1826, #1825, #1824, #1791, #1789, #1768, #1767, #1739, #1740, #1738, #1736, #1735, #1734, #1731, #1713, #1698, #1697, #1696, #1689, #1604, #1552, #1464, #872)
- **Security** — `@vercel/node` upgraded in /gitnexus-web with transitive advisories remediated (#1705)

## [1.6.5] - 2026-05-16

### Added

- **C++ ADL V2** — Argument-Dependent Lookup overhaul. Class-typed reference args (incl. rvalue refs) contribute associated namespaces (#1595); class-pointer args and template-specialization args (with nested template args) included (#1592, #1596); base-class associated namespaces walked via MRO (#1597); free-function reference args contribute enclosing namespace (#1598); ordinary and ADL free-call candidates merged before overload selection (#1599)
- **C++ standard-conversion-sequence ranking** for overload resolution (#1606)
- **C++ scope-resolution migration** — C++ now runs on the registry-primary RFC #909 path (#938, #1520); template-body `this->` + `using ns::name` calls resolved in the scope resolver (#1590); template specializations disambiguated in class graph IDs and receiver routing (#1587); EXTENDS edges for template and qualified template bases (#1581)
- **PHP scope-resolution migration** — PHP moved to scope-based resolution (#938, #1497, supersedes #1124)
- **Java scope-resolution migration** — RFC #909 Ring 3 (#1482)
- **C scope-resolution migration** — RFC #909 Ring 3 (#1481)
- **Incremental indexing** — `gitnexus analyze` now reuses a parse cache, writes back to DB, and short-circuits scope resolution when nothing changed (#1479)
- **`gitnexus:keep` marker** — preserves custom context sections (#605, #1508)
- **`gitnexus analyze --skip-skills` and `--index-only`** flags (#742, #1485)
- **`gitnexus wiki --timeout` and `--retries` flags** — mitigate timeout aborts on large module pages (#1543)
- **HTTP embedding `dimensions` parameter** — now forwarded to the embedding endpoint (#1498)
- **Cursor 2.4 `postToolUse` hooks** — upgraded for Read/Grep/Shell coverage (#1467)

### Fixed

- **Cross-file type propagation** — resolved a stall on large repos (#1626)
- **C++ inline-namespace ambiguity** — detect same-name ambiguity across inline namespace children (#1564, #1600); workspace-wide dependent-base name resolution for cross-file templates (#1586)
- **Parse cache persistence** — sharded on large repos to avoid corruption (#1580)
- **TypeScript ESM `.js` extension** — fallback applied to tsconfig path-alias resolution (#1530) and `.js` → `.ts` source resolution (#1525)
- **Markdown CRLF line endings** — section heading parser now handles them (#1469)
- **`gitnexus analyze --no-stats`** — actually omits volatile counts (#1477, #1478)
- **`ensureGitNexusIgnored`** — tolerate read-only workspaces (#1549, #1550)
- **Claude augment hook** — skipped when GitNexus server owns the DB (#1493)
- **Docker runtime image** — symlink `gitnexus` binary onto `$PATH` (#1551); install `ca-certificates` for TLS verification (#1545, #1547); include duckdb installer script (#1502)
- **Windows reliability** — fix 32767-char tree-sitter crash and VECTOR-extension SIGSEGV (#1433); platform-aware `tsc` build command for win32 (#1531)
- **Search / FTS** — guard against undefined `bm25Results` when FTS is unavailable (#1489, #1540); CONTAINS fallback in augment when FTS indexes unavailable (#1476)
- **Wiki** — sanitize generated mermaid diagrams (#1539)
- **Hooks** — cap concurrent augment subprocesses to prevent runaway fan-out (#1486, #1510)
- **LadybugDB** — drain checkpoint result before close (#1506); recover `gitnexus analyze` from orphan sidecars when the main DB file is missing (#1622)
- **Group / contracts** — detect `httpx` async consumers (#1408)
- **Server hardening** — sanitize repo name to prevent argument injection on `/api/analyze` (#1305)

### Changed

- **CI release pipeline unified under `publish.yml`** — single source of truth for npm publish, provenance, and GitHub Release creation (#1610)
- **CI: skip RC build on release PRs** — release/* branches no longer cut redundant RCs (#1474)
- **CI (Claude review): make `/review` reliably post PR comments** (#1522); allow Bash in code-review job without interactive approval (#1523)
- **CI publish (post-merge fixes)** — bump publish job to Node 24 for npm OIDC support (#1628); engage npm Trusted Publishing OIDC properly (#1627)
- **Tests** — remove flaky regression test for resource exhaustion (#1521); de-flake regex linearity assertions in U8 (#1475)

### Chore / Dependencies

- `vitest` 4.1.5 → 4.1.6 in /gitnexus (#1605)
- `@langchain/google-genai` bump in /gitnexus-web (#1554)
- `vite` 8.0.10 → 8.0.11 in /gitnexus-web (#1555)
- `mermaid` bump (#1514)
- `protobufjs` 7.5.5 → 7.5.8 + `@protobufjs/utf8` in /gitnexus (#1535, #1536)
- `urllib3` bump in /eval uv group (#1512)
- GitHub Actions: `sigstore/cosign-installer` 4.1.1 → 4.1.2 (#1557)

## [1.6.4] - 2026-05-10

### Added

- **`gitnexus publish`** — opt-in command to push your indexed graph to the understand-quickly registry for shareable browsing (#1425)
- **`IncludeExtractor` for C++** — cross-repo include tracking joins the group contract pipeline (#1156)
- **Unreal Engine C++ support** — strips reflection macros (`UCLASS`, `UFUNCTION`, `UPROPERTY`, etc.) before tree-sitter parses, so UE projects index cleanly (#1439)
- **Thrift contracts extractor** — group-mode contract detection for Apache Thrift IDL (#1234)
- **Workspace extractors for Node, Python, Go, Java, Elixir** — group-mode auto-discovery of cross-package boundaries (#1260)
- **Rust workspace cross-crate contracts** — auto-discovery of `[workspace]` member crates and their cross-crate links (#1256)
- **Go scope-resolution hooks** — Go joins Python / C# / TypeScript on the registry-primary RFC #909 path (#1302)
- **TypeScript registry-primary scope resolution (Ring 3)** — TypeScript fully migrated to scope-based resolution (#1050)
- **Configurable group cross-link path exclusions** — reduces false-positive contract links in vendored / monorepo trees (#1093)
- **MCP tool safety annotations** — every MCP tool advertises read-only / mutating semantics so hosts can prompt appropriately (#1127)
- **`--embeddings <limit>` opt-in cap** — bound the embeddings pass on huge graphs (closes #382, #1375)
- **Pino structured logger** — replaces ad-hoc console output across the core with structured JSON logs (with pretty-print for TTY) (#1336)
- **Shared resilient-fetch helper** — single retries + circuit breaker module reused by HF / Docker / publish flows (#1448)
- **`/autofix` ChatOps button** — fork-safe PR autofix pipeline replaces the inline reviewdog flow (#1446, #1458)
- **Automated security & vulnerability scans** in CI (#1297, #1455)

### Fixed

- **FTS read-only DB cluster** — hook resolves canonical repo root and guards read-only FTS ensure; missing-FTS warning is now surfaced. Closes #1255, #1287, #1170, #1449, #1440, #1216, #1438 (#1226, #1418, #1107, #1123)
- **WAL corruption recovery** — quarantine corrupted `.wal` files instead of failing analyze; CHECKPOINT before close prevents recurrence; `safeClose` consolidates flush. Closes #1402, #1236, #1273, #1361 (#1417, #1314, #1377)
- **Embedding download failures** — actionable HF_ENDPOINT guidance, retries, timeout, and circuit breaker; bridge `HF_ENDPOINT` to transformers.js; iterative DFS; HF cache via `os.homedir()`. Closes #1378, #1437, #1205 (#1419, #1252, #1078)
- **Windows reliability** — pin tree-sitter-c/cpp to fix segfault, prefer `.cmd`/`.bat` from `where` output, robust LadybugDB lock acquisition for CI integration tests, surface silent finalize-skips so analyze cannot exit 0 without persisting. Closes #1242, #1427, #1447, #1468, #1400; partial #1218 (#1243, #1299, #1430, #1237, #1226, #1235)
- **DuckDB / LadybugDB native** — bumped to 0.16.0 then 0.16.1; prevent extension install hangs; CHECKPOINT before close; WAL quarantine on corruption. Closes #1162, #1160, #273 (#1235, #1326, #1129, #1314, #1417)
- **C# scope-resolution "Cannot add property" crashes** — generic typed properties included in context and impact, fixing crashes on Unity ECS partial structs and on properties whose name matches the class name. Closes #1426, #1465 (#1399)
- **C# frozen-bucket regression** + scope-resolution I8 hardening — closes #1066 (#1082, #1085)
- **Scope resolution** — same-range Module-as-parent for top-level scopes (closes #1086) (#1087); avoid variadic reference-site aggregation (#1112); skip empty scope extraction (#1100); classify Python class methods as Method (#1102)
- **Python** — index repos with empty `__init__.py` and >32 KB files (#1163); walk ancestors for multi-segment dotted imports (#1241); deterministic multi-segment suffix fallback (#1253)
- **TypeScript** — capture missed CALLS edges from HOF callbacks and JSX (#1175); name HOC-wrapped const declarations (`forwardRef` / `memo` / `useCallback` / `useMemo` / `observer`) (#1261); pair-with-arrow `@declaration.function` anchored on inner arrow
- **Go** — loose equality for `Array.find()` null checks (#1384)
- **Swift** — switched to the official prebuilt parser runtime (#1130)
- **Server hardening cluster (U2–U8)** — JS path-injection on `/api/file` + docker-server (U2, #1322); git-clone path/CLI-injection / ReDoS hardening (U3, #1325); per-route rate limiting on FS-touching endpoints (U4, #1327); URL/regex/tag-filter sanitization (U7, #1330); ReDoS in cobol-preprocessor + rust-workspace + cross-impact resource exhaustion (U8, #1331); critical type-confusion + validation helper (#1317); rate-limit `/api/analyze` and `/api/embed` (closes #1328, #1339); IPv6 ipKeyGenerator (closes #1360, #1374); IPv4-compatible IPv6 / NAT64 SSRF bypasses in `validateGitUrl` (closes #1148, 95814847); predictable tempfile names → `crypto.randomBytes` (#1387); log-injection / http-to-file-access / client-side request forgery (#1456); pin Docker Node base images + Trivy verification + Dependabot policy (#1455)
- **Group / contracts** — `runExactMatch` honours `.gitnexusignore` via shared `IgnoreService` (closes #1185, #1247); custom manifest links resolved against graph symbols (#1254); `IgnoreService` EACCES test under uid=0 (#1108)
- **MCP** — close MCP server timeout via stdout discipline + cold-start friction (#1383); avoid `git` from non-repo cwd in sibling-cwd match (closes #1138, #1293); start MCP bridge correctly when using `npx` (#1114); project `tool_map` flows from handlers (#1113); parallelize staleness checks in `list_repos` (#1416)
- **Storage / CLI** — derive registry name from canonical repo root, not worktree slug (closes #1259, #1296); `--skip-git` treats cwd as index root (#1245); keep GitNexus ignores inside `.gitnexus/` (#1248); surface silent finalize-skips so `analyze` cannot exit 0 without persisting (closes #1169, #1237); ignore global registry during staleness checks (#1141); use `os.homedir()` instead of `process.env.HOME` for HF cache dir (#1078); correct OpenCode skills install path in status message (#1386)
- **Docker / server** — dedicated health endpoint for container healthcheck (closes #1147, #1355); HEAD probe so SSE heartbeat doesn't time out healthcheck (#1182); flush WAL after `/api/embed` so search sees new embeddings (closes #1149, #1359); platform-aware semantic fallback (#1150); skip vector index query on unsupported platforms (closes #1178, #1181); serve web UI at root path instead of 404 (#1048)
- **Worker pool** — wait for replacement worker online before dispatch (#1324); prevent premature pool resolution in worker split-and-retry path (#1321); recover worker parse stalls (#1121); widened CI flake-tolerant timeouts (#1323, #1347, #1354)
- **Embeddings storage** — CHECKPOINT before closing DB to prevent WAL corruption (#1314)
- **Performance** — replace O(n³) C3 merge loop with O(n²) head-pointer algorithm (#1316)
- **Install** — vendor tree-sitter-dart source (#1125)
- **Git utils** — suppress stderr leak in `getCurrentCommit` and `getGitRoot` (closes #1172, #1341)
- **Search** — load FTS during core DB init (#1123); create FTS indexes during `analyze` (#1107); surface warning when FTS indexes are missing (#1418)
- **Hooks** — clarify `PostToolUse` hook is notification-only, not auto-reindex (#1070)
- **Docs** — README Web UI section corrected (closes #1110, #1159, #2ff3e64f); Goliath capitalisation typo (#1126)
- **CI** — fork-safe PR autofix pipeline (#1446); consolidated Claude review workflow (#1258); fine-grained PAT for RC tag push (#1407); handle expired artifacts in base coverage fetch (#1410, #1412); allow expected legacy parity failures (#1099); avoid duplicate main push checks; isolate native LadybugDB / CLI e2e flakes; seed e2e with a small fixture repo (#1249); configure e2e GitNexus home at runtime; widen rate-limit test window for Windows CI (#1347)

### Changed

- **`gitnexus publish` artefact contract** — universal opt-in publish format introduced (#1425, #1458)
- **Refactor: per-language patterns consolidated into `LanguageProvider`** (#1279)
- **Refactor: `safeClose` helper** consolidates WAL flush across LadybugDB call sites (#1377)
- **Quality: exclude `test/fixtures` from CodeQL, ESLint, and Prettier** (#1313)
- **Regression coverage** for `.gitnexusignore` behaviour with `--skip-git` (#1450)

### Chore / Dependencies

- `@ladybugdb/core` 0.16.0 → 0.16.1 (#1235, #1326)
- `@anthropic-ai/sdk` (#1442), `@langchain/anthropic` (#1389), `@langchain/core` (#1394), `@langchain/openai` (#1215)
- `hono` 4.12.9 → 4.12.18 + `@hono/node-server` (#1310, #1311, #1443)
- `axios` (#1345), `fast-uri` 3.1.0 → 3.1.2 (#1441), `lru-cache` 11.3.5 → 11.3.6 (#1344), `mnemonist` 0.40.3 → 0.40.4 (#1239), `express-rate-limit` (#1343, #1397), `onnxruntime-node` (#1213, #1435), `uuid` 13 → 14 in /gitnexus-web (#1211, after revert #1222 / re-land #1250 + #1208)
- `react`/`@types/react` (#1210), `react-dom` 19.2.5 → 19.2.6 (#1396), `react-zoom-pan-pinch` (#1214), `jsdom` 29.0.2 → 29.1.1 (#1395)
- npm_and_yarn group bump (#1312), uv group bump (#1315), `python-dotenv` (#1320), `@types/node` (#1212, #1421, #1436)
- GitHub Actions: `docker/build-push-action` 6.19.2 → 7.1.0 (#1391), `github/codeql-action` 3.35.3 → 4.35.3 (#1390)

## [1.6.3] - 2026-04-24

### Added

- **Cross-repo impact analysis** — `@repo` MCP routing plus group resources let impact queries span multiple indexed repositories in a group (#794, #984)
- **Python scope-based call resolution** — registry-primary flip, performance, and generalization work from RFC #909 Ring 3 (#980)
- **C# scope-resolution migration** — C# now runs on the registry-primary path alongside Python (#934, #1019)
- **RFC #909 Ring 1 & Ring 2 scope-resolution infrastructure** — the shared foundation for language-agnostic scope resolution:
  - Scope-resolution types and constants, `LanguageProvider` hook extension (#910, #911, #949, #950)
  - `ScopeTree` + `PositionIndex` + `makeScopeId` (#912, #961)
  - `DefIndex` / `ModuleScopeIndex` / `QualifiedNameIndex` (#913, #958)
  - `MethodDispatchIndex` materialized view over `HeritageMap` (#914, #960)
  - `resolveTypeRef` strict single-return type resolver (#916, #959)
  - SCC-aware finalize with bounded fixpoint (#915, #962)
  - `ClassRegistry` / `MethodRegistry` / `FieldRegistry` + 7-step lookup (#917, #963)
  - Shadow-mode diff + aggregate, parity harness + static dashboard (#918, #923, #951, #972)
  - `ScopeExtractor` driver with 5-pass CaptureMatch → ParsedFile (#919, #965)
  - `ScopeExtractor` wired into parse-worker + processor (#920, #969)
  - `finalize-orchestrator` materializes `ScopeResolutionIndexes` (#921, #970)
  - Per-language `resolveImportTarget` adapter (#922, #971)
  - `REGISTRY_PRIMARY_<LANG>` per-language flag reader (#924, #968)
  - `emit-references` drains `ReferenceIndex` to graph edges (#925, #973)
- **`gitnexus analyze --name <alias>`** with duplicate-name guard in the repo registry (#955)
- **`gitnexus remove <target>`** unindexes a registered repo by name or path (#664, #1003)
- **Auto-infer registry name** from `git remote.origin.url` when `--name` is omitted (#981)
- **Sibling-clone drift detection** — indexed repos are fingerprinted by remote URL so duplicate registrations are caught before graph divergence (#982)
- **Configurable large-file skip threshold** — the walker's 512 KB default is now overridable via `GITNEXUS_MAX_FILE_SIZE` (KB) or `gitnexus analyze --max-file-size <kb>`. Values are clamped to the 32 MB tree-sitter ceiling, invalid inputs fall back to the default with a one-time warning, and the CLI banner reports the effective post-clamp threshold when an override is active (#991, #1044, #1045)
- **`GITNEXUS_INDEX_TEST_DIRS` opt-in** for `__tests__` / `__mocks__` traversal (#771, #1046)
- **`analyze` embedding preservation** — existing embeddings are preserved by default, `--force` regenerates them, `--drop-embeddings` opts out entirely (CLI + HTTP API) (#1055)
- **Structural embedding chunking** with data-driven `CHUNKING_RULES` dispatch, replacing the flat line-based split (#987)
- **PHP HTTP consumer detection** for the extractor catalogue (#993)
- **Per-phase search timing** instrumentation across the query pipeline (#953)
- **MCP disambiguation ranking** — `context` / `impact` candidates are ranked and expose `kind` / `file_path` hints (#888)
- **Docker images for UI + CLI/server** shipped via `docker-compose` with cosign signing (#967), RC image builds (#978), and GHCR → Docker Hub mirroring (#1029)

### Fixed

- **Go CALLS edges for receiver methods** — worker source IDs now align with the main pipeline, restoring receiver-method call edges (#1043)
- **Node 22 DEP0151 warning** from `tree-sitter-c-sharp` import silenced (#1013, #1049)
- **FTS index bootstrap** tries a local `LOAD` before `INSTALL` so offline/air-gapped runs no longer fail on network errors (#726)
- **FTS ensure failures** are no longer cached and are invalidated on pool teardown (#1006)
- **`groupImpact` local-impact errors** now bubble to the caller instead of being swallowed (#1004, #1007)
- **Friendly error** when a group name is not found, with regression test for #903 (#989)
- **`bm25` results** return FTS-matched symbols instead of an arbitrary `LIMIT 3` slice (#806)
- **Embedding AST traversal** switched from recursion to iterative DFS, fixing stack overflow on deeply nested files (#990)
- **React component path detection** runs before lowercasing, so mixed-case `.jsx`/`.tsx` files are recognised (#260)
- **`detect-changes` ENOBUFS** by setting `maxBuffer` on `git` / `rg` `execFileSync` invocations (#957)
- **`detect-changes` in direct CLI** — command was wired to MCP only; now exposed on the CLI as well (#892)
- **CLI gitnexus markers** — `<!-- gitnexus:* -->` is only matched at section position, no longer inside code/prose (#1041, #1042)
- **`opencode.json` setup** preserves existing comments and config during install (#998)
- **Sequential parser logging** — skipped languages are now logged instead of silently dropped (#1021)
- **`cli-e2e` fixture isolation** from the shared mini-repo, plus stabilised `rel-csv-split` stream teardown on Windows via `expect.poll` (#954, #1052)
- **Docker** — RC build guarded against empty `vtag`, `inputs.tag` used to detect `workflow_call` context, web builder stage now copies `gitnexus/package.json`, base image switched from alpine to debian (#983, #996, #997, #1014)
- **CI** — reusable `docker.yml` now inherits secrets from `release-candidate.yml` (#1054)

### Changed

- **`setup` config I/O unified** on `mergeJsoncFile` across all writers (#1031)
- **Docker CI** gains a retry wrapper for `build-push` with visibility and hardened shell

### Chore / Dependencies

- Dependency bumps: `graphology` 0.25.4 → 0.26.0 (#1001), `uuid` 13 → 14 (#1000), `@huggingface/transformers` (#1035), `@types/node` (#1002), `@types/uuid` (#1016), `vitest` 4.1.4 → 4.1.5 (#1017), `@vitest/coverage-v8` (#1018)
- gitnexus-web dependency bumps: `vite` 5.4.21 → 6.4.2 → 7.3.2 → 8.0.10 + `vitest` 4 (#1061, #1062, #1063), `lucide-react` 0.562.0 → 1.11.0 with local GitHub SVG fallback (#1038), `@langchain/anthropic` 1.3.10 → 1.3.27 (#1039), `@babel/types` (#1037)
- gitnexus-shared dependency bumps: `typescript` (#1034)
- GitHub Actions bumps: `actions/setup-node` 6.3.0 → 6.4.0 (#1033)
- Documentation: repo-wide `DoD.md` Definition of Done (#1032), gRPC microservices group guide (#906, #994), `group add` / `group remove` README fixes (#1020), CLI docs include `--skip-git` (#750), README Discord link updated

## [1.6.2] - 2026-04-18

### Added

- **Docker support** — containerized ingestion and MCP serving for reproducible runs on CI and container platforms (#848)
- **Language-agnostic heritage extractor** — config+factory pattern for class-heritage extraction (EXTENDS / IMPLEMENTS), completing the extractor refactor alongside method/field/call/variable (#890)
- **Language-agnostic call extractor** — config+factory pattern that collapses ~225 lines of inline parse-worker logic into declarative per-language configs (#877)
- **Language-agnostic variable extractor** — structured metadata for `Const` / `Static` / `Variable` nodes via config+factory pattern (#878)
- **AST-aware embedding chunking** — offset-based splitting preserves symbol boundaries, improving semantic search precision on large files (#889)
- **HTTP consumer detection for jQuery and axios object-form** — `$.ajax` / `$.get` / `$.post` and `axios({ url, method })` now recognized as HTTP call sites (#887)

### Fixed

- **Python external dotted imports** — avoid spurious same-file matches when an import path like `foo.bar.baz` refers to a third-party module (#899)
- **Worker warnings no longer terminate ingestion** — non-fatal parser warnings keep the pipeline running instead of aborting the run (#900, #261)
- **Global-install upgrade `ENOTEMPTY`** — devendored `tree-sitter-proto` install lifecycle + preinstall cleanup so `npm i -g gitnexus@latest` succeeds on top of an older install (#843, #846)
- **`env.cacheDir`** now defaults to a user-writable location, unblocking ingestion on systems where the install directory is read-only (#845)
- **Content-hash staleness detection for embeddings** — zero-node rebuilds no longer skip vector-index creation, fixing semantic search after selective re-analysis (#831)
- **`tree-sitter-c-sharp` version pin** — locked to 0.23.1 to avoid a breaking change in a transitive prerelease (#834)
- **`release-drafter` v7 CI** — replaced the removed `disable-releaser` flag with `dry-run` so release-note drafts still work
- **`npm arborist` crash from `tree-sitter-dart`** — switched the dependency URL format so `npm install` no longer crashes on clean installs
- **Service-group `ManifestExtractor`** — `config.links` now wires the manifest extractor properly, restoring cross-link discovery that had silently dropped to zero

### Changed

- **SemanticModel wired as a first-class resolution input (SM-20)** — `call-processor`, `resolution-context`, `type-env`, and `heritage-map` now consult `table.model.*` directly; 37 internal call sites migrated off the SymbolTable wrapper (#885)
- **Per-strategy `ImportSemantics` hooks** — `named` / `wildcard-transitive` / `wildcard-leaf` / `namespace` strategies split into composable hooks, replacing the monolithic conditional (Strategies 1–4 of #886)
- **Class extraction configs moved to `configs/` subdirectory** — per-language class configs now co-locate with the other extractor configs, completing the extractor layer's directory convention (#879)
- **CLI AI-context trimmed** — duplicated CLAUDE.md block removed from the shipped context, reducing token usage in LLM-consuming workflows (#904)
- **LLM context files optimized** — AI-consumed documentation tuned for accuracy and token efficiency (#857)
- **Workflow concurrency standardized** — all CI workflows adopt the consistent concurrency key pattern documented in CONTRIBUTING.md; release-note labeling automated (#837)
- **E2E status-ready timeout raised** — 45s accommodates parallel-worker startup variance on CI (#908)

### Chore / Dependencies

- **tree-sitter 0.25 upgrade readiness** — daily Dependabot monitor for the upcoming major-version bump (#847)
- Dependency bumps: `glob` 11.1.0 → 13.0.6 (#867), `commander` 12.1.0 → 14.0.3 (#868), `@huggingface/transformers` (#869), `@modelcontextprotocol/sdk` (#866), `lru-cache` 11.2.7 → 11.3.5 (#870), `mnemonist` 0.39.8 → 0.40.3 (#871), `@ladybugdb/core` (#873)
- gitnexus-web dependency bumps: `mermaid` 11.12.2 → 11.14.0 (#860), `tailwindcss` (#861), `jsdom` 29.0.0 → 29.0.2 (#863), `wait-on` 8.0.5 → 9.0.5 (#859), `@vitest/coverage-v8` (#864)
- GitHub Actions bumps: `actions/checkout` 4.3.1 → 6.0.2 (#842), `actions/upload-artifact` 4.6.2 → 7.0.1 (#838), `actions/setup-node` 4.4.0 → 6.3.0 (#841), `actions/cache` 5.0.4 → 5.0.5 (#840), `actions/github-script` 7.0.1 → 9.0.0 (#850), `dorny/paths-filter` 3.0.2 → 4.0.1 (#839), `amannn/action-semantic-pull-request` 6.1.1 (#853), `release-drafter/release-drafter` 6.0.0 → 7.2.0 (#852), `marocchino/sticky-pull-request-comment` 3.0.4 (#851), `softprops/action-gh-release` 2.5.0 → 3.0.0 (#849)

## [1.6.1] - 2026-04-13

### Added
- **Service group extractor expansion** — manifest extractor and broader extractor coverage (2/4 of #606 split) (#796)
- **Dart call patterns** for `await`, cascade, lambda, and widget-tree contexts (#801)

### Fixed
- **Stack overflow and memory exhaustion** on large repository analysis (#814)
- **`tree-sitter-dart` install crash** — switched from git URL to npm tarball (#811)
- **Generic TypeScript awaited function calls** missing from the call graph (#804)
- **Runtime dependency on `file:../gitnexus-shared`** removed from the published package (#803)
- **Ruby `singleton_class` context** preserved during sequential parsing (#774)

### Changed
- **DAG-based ingestion pipeline architecture** — pipeline phases now declare typed dependencies and run via a topologically sorted DAG; container-node logic extracted to `LanguageProvider`. Includes hardened lifecycle (try/finally cleanup, error wrapping, cycle reporting), tightened `ParseOutput.exportedTypeMap` immutability, and corrected phase dependencies (#809)

## [1.6.0] - 2026-04-12

### Added
- **SemanticModel architecture refactor (SM-8 through SM-19)** — extracted registries into `model/` module with ISP-compliant interfaces: TypeRegistry, MethodRegistry, FieldRegistry, RegistrationTable, ResolutionContext (#786)
  - HeritageMap built from accumulated `ExtractedHeritage[]` for MRO-aware resolution (#739)
  - `lookupMethodByOwnerWithMRO` using HeritageMap for cross-class method dispatch (#740)
  - MRO fast path before D2 fuzzy widening in call resolution (#741)
  - BindingAccumulator for cross-file return type propagation (#743, #763)
  - Restructured `resolveUncached` replacing `lookupFuzzy` data source for all tiers (#764)
  - Deleted `lookupFuzzy`, `lookupFuzzyCallable`, `globalIndex`, `callableIndex` — replaced with structured lookups (#769)
  - Deleted `resolveCallTarget` god-method — replaced with thin dispatcher delegating to `resolveMemberCall` (#744), `resolveStaticCall` (#754), `resolveFreeCall` (#756) (#770)
- **Service group infrastructure** — service boundary detection, contract extractors, sync pipeline, CLI/MCP tools, monorepo fixture; bridge.lbug storage and contract matching expansion (#795)
- **C# interface-to-interface heritage** capture (#789)
- **Vue SFC support** with destructured call result tracking (#604)
- **Java method reference** resolution — `obj::method` as call sites (#622)
- **C/C++ MethodExtractor** config with pure virtual detection (#617)
- **MethodExtractor configs** for Python, PHP, Swift, Dart, Rust, Ruby (#624)
- **METHOD_IMPLEMENTS edges** with overload disambiguation and MethodExtractor unification (#642)
- **Same-arity overload disambiguation** via type-hash suffix (#658)
- **`GITNEXUS_HOME` env var** to customize global directory (#746)
- **Verbose analyze output** prints skipped large file paths (#745)
- **Class name lookup index** for O(1) qualified lookups (#707, #716)
- **`lookupMethodByOwner` index** for O(1) cross-class chain resolution (#665)
- **Fuzzy lookup counters** for performance visibility (#708)

### Fixed
- **Stack overflow on large PHP files** — iterative AST traversal (#783)
- **Large repository graph loading** failure (#732)
- **Windows multi-repo switching** — false 404 errors and stale repo context (#633)
- **`detect_changes` diff mapping** — map diff hunks to symbol line ranges (#779)
- **HTTP client vs Express route detection** and Spring interface attribution (#780)
- **VECTOR extension** not loaded during DB init for semantic search (#782)
- **tree-sitter-swift** postinstall patch for macOS ARM64 (#788)
- **tree-sitter-c** peer dependency conflict pinned (#723)
- **Constructor indexing** in methodByOwner (#694, #753)
- **Named binding processor** — `lookupExact` replaced with `lookupExactAll` (#755)
- **`.gitnexusignore` negation patterns** now respected (#654)
- **MCP setup** prefers global gitnexus binary over npx (#653)
- **CORS rejection** returns clean error instead of 500 (#646)
- **Array.push stack overflow** — replaced spread with loop (#650)
- **MCP stdout silencing** prevents embedder/pool-adapter conflicts (#645)
- **Web heartbeat** — graceful reconnection replaces aggressive disconnect (#643)
- **Web repo scoping** — backend calls scoped to active repo (#644)
- **OpenCode config path** and FTS extension load order (#781)
- **OnboardingGuide** dev-mode serve command corrected (#725)
- **Security issues** and critical bugs from code review (#709)

### Changed
- Replaced class-type fuzzy lookups with structured indices in type-env (#733, #734, #736)
- Extracted `CLASS_LIKE_TYPES` constant (#693)

## [1.5.3] - 2026-04-01

### Added
- **TypeScript/JavaScript MethodExtractor** config (#588)

### Fixed
- **Wiki Azure OpenAI** compat and HTML viewer script injection (#618)

## [1.5.2] - 2026-04-01

### Fixed
- **`gitnexus-shared` module not found** — `gitnexus-shared` was a `file:` workspace dependency never published to npm, causing `ERR_MODULE_NOT_FOUND` when installing `gitnexus` globally. The build now bundles shared code into `dist/_shared/` and rewrites imports to relative paths (#613)
- **v1.5.1 publish regression** — npm's `prepare` lifecycle ran `tsc` after `prepack`, overwriting the rewritten imports before packing; both scripts now run the full build so the final tarball is always correct

## [1.5.1] - 2026-04-01 [YANKED]

### Fixed
- Incomplete fix for `gitnexus-shared` bundling — `prepare` script overwrote rewritten imports during publish

## [1.5.0] - 2026-04-01

### Added
- **Repo landing screen** — when the backend detects indexed repositories, the web UI now shows a landing page with selectable repo cards (name, stats, indexed date) instead of auto-loading the first repo; users can also analyze new repos directly from the landing screen (#607)
- **Unified web & CLI ingestion pipeline** — complete architectural migration of the web app from a self-contained WASM browser app to a thin client backed by the CLI server; new `gitnexus-shared` package for cross-package type unification (#536)
  - New server endpoints: `/api/heartbeat` (SSE liveness), `/api/info`, `/api/repos`, `/api/file`, `/api/grep`, `/api/analyze` (SSE progress), `/api/embed`, `/api/mcp` (MCP-over-StreamableHTTP)
  - Onboarding flow: auto-detect server → connect → repo landing or analyze
  - Header repo dropdown: switch, re-analyze, or delete repos
- **Azure OpenAI support for wiki command** — fixed broken Azure auth (`api-key` header), `api-version` URL parameter, reasoning model handling (`max_completion_tokens`, no `temperature`), content filter error messages; added interactive setup wizard, `--api-version` and `--reasoning-model` CLI flags (#562)
- **Java method references & interface dispatch** — `obj::method` treated as call sites, overload selection via typed variable args (not just literals), interface dispatch emits additional CALLS edges to implementing classes (#540)
- **MethodExtractor abstraction** — structured method metadata extraction (isAbstract, isFinal, annotations, visibility, parameter types) with config-driven factory pattern (#576)
  - Java and Kotlin configs with overload-safe `methodInfoCache` keyed by `name:line`
  - C# config with `sealed`, `params`/`out`/`ref`/optional parameters, `[Attribute]` syntax, `internal` visibility (#582)
- **`--skip-agents-md` CLI flag** — opt out of overwriting GitNexus-managed sections in AGENTS.md and CLAUDE.md during `gitnexus analyze` (#517)
- **Prettier** — monorepo-wide code formatter with lint-staged + Husky pre-commit hook, `.prettierrc` config, Tailwind CSS v4 plugin, `endOfLine: "lf"` + `.gitattributes` for Windows consistency (#563)
- **ESLint v9** — flat config with `unused-imports` auto-removal, `@typescript-eslint` rules, React hooks rules, CI `lint` job (#564)

### Fixed
- **OpenCode MCP configuration** — corrected README MCP setup for OpenCode which requires `command` as an array containing both executable and arguments (#363)
- **litellm security** — excluded vulnerable versions 1.82.7 and 1.82.8 in eval harness `pyproject.toml` (#580)

### Changed
- **Reduced explicit `any` types** — 128 `no-explicit-any` warnings eliminated (689 → 561, 19% reduction) across `NodeProperties` index signature, ~80 `SyntaxNode` substitutions, typed worker protocol, and graphology community detection (#566)

### Docs
- Added `gitnexus-shared` build step to web UI quick start instructions (#585)
- Added enterprise offering section to README (#579)

## [1.4.10] - 2026-03-27

### Fixed
- **MCP server install via npx** — resolve tree-sitter peer dependency conflicts that broke `npx -y gitnexus@latest mcp` (#537, #538)
  - Downgrade tree-sitter from ^0.25.0 to ^0.21.1 (only npm version where all 14 parsers agree)
  - Align all parser versions to their highest ^0.21.x-compatible releases
  - Remove tree-sitter override (only applies to root packages, ignored by npx)
  - Pin tree-sitter-dart to correct ABI-14-compatible commit
  - Exact pins for tree-sitter-c (0.23.2), tree-sitter-python (0.23.4), tree-sitter-rust (0.23.1) where next patch requires ^0.22.x

## [1.4.9] - 2026-03-26

### Added
- **COBOL language support** — standalone regex processor for fixed-format and free-format COBOL, JCL, COPY/REPLACING with pseudotext (#498)
  - 95% language feature coverage: CALL USING, EXEC SQL/CICS/DLI, DECLARATIVES, SET, INSPECT, INITIALIZE, STRING/UNSTRING, SORT/MERGE with INPUT/OUTPUT PROCEDURE, GO TO DEPENDING ON, MOVE CORRESPONDING, nested programs with per-program scoping
  - 90+ review findings resolved across 20 review cycles with 241 tests (180 unit + 61 integration)
  - Benchmarked: CardDemo 12,349 nodes / 9,773 edges in 7.4s; ACAS 14,017 nodes / 15,659 edges in 9.3s
- **Dart language support** — tree-sitter grammar, type extractors, import/call resolution, Flutter/Riverpod framework detection (#204)
- **Field type extraction** — Phase 8 & 9: per-language field extractors with generic table-driven factory + TypeScript hand-written extractor, return-type binding in call-processor (#494)
  - 14 language configs (TS/JS, Python, Go, Rust, C/C++, C#, Java, Kotlin, PHP, Ruby, Swift, Dart)
  - `FieldVisibility` union type, `extractNames` hook for Ruby multi-attribute
  - 46 field extraction tests across 5 languages
- **ORM dataflow detection** for Prisma and Supabase (#511)
- **Expo Router** file-based route detection (#503)
- **PHP response shape extraction** for `json_encode` patterns (#502)
- **Next.js middleware.ts** linked to routes at project level (#504)
- **Filter panel** — additional node types (#519)

### Changed
- **BUILT_IN_NAMES** split into per-language provider fields (#523)
- **tree-sitter** upgraded to 0.25.0 with all grammar packages (#516)
- **Impact tool** — batched chunking and entry-point grouping for enrichment (#507)

### Fixed
- **COBOL CRLF** — all `split('\n')` calls use `/\r?\n/` for Windows compatibility
- **COBOL nested programs** — all graph edges (CALL, CANCEL, CICS, ENTRY, SQL, SEARCH) use `owningModuleId()` for correct attribution
- **COBOL callAccum** — multi-line CALL USING with verb boundary detection, Area A paragraph guard, EXEC entry flush, division/END PROGRAM flush
- **Dart language gaps** closed (#524)
- **Shape check false positives** — quoted keys, DOM leaks, errorKeys (#501)
- **Python alias gaps** resolved (#505)
- **Cypher write-detection regex** false positive fixed (#507)
- **CI** — shape-check-regression test moved to lbug-db project (#518)

## [1.4.8] - 2026-03-23

### Added
- **Type resolution Milestone D — Phases 10–13** consolidated into a single milestone with full integration test coverage across 11 languages (#387)
  - Phase A/B/C: overload disambiguation via argument literal types, constructor-visible virtual dispatch via `constructorTypeMap`, `parameterTypes` extraction in `extractMethodSignature`
  - Phase 14 enhancements: single-pass seeding, Tarjan's SCC for cyclic resolution, cross-file return types
  - Optional parameter arity resolution
  - Per-language cross-file binding tests and resolver fixes
  - Store all overloads in `fileIndex` instead of last-write-wins
- **Cross-file binding propagation** for multiple languages
- **HTTP embedding backend** for self-hosted/remote endpoints with dynamic dimensions, batch guards, and dimension mismatch handling (#395)
- **Markdown file indexing** — headings and cross-links as graph nodes (#399)
- **MiniMax provider support** (#224)
- **Codex MCP and skills support** with CLI setup flow and e2e tests
- **HelpPanel UI** — built-in help for the web interface (#465)
- **Section node type** registered in `NODE_TABLES` and `NODE_SCHEMA_QUERIES` (#401)
- **Community and Process node properties** documented in cypher tool description (#411)
- **Server-mode hydration regression tests**
- **Pre-commit hooks** via husky for typecheck + unit tests

### Fixed
- **Python import alias resolution** — `import X as Y` now routes module aliases directly to `moduleAliasMap` in import processor (#417, #461)
- **Python module-qualified calls** resolved via `moduleAliasMap` (#337)
- **Python module-qualified constructor calls** (Issue #337)
- **Heritage/MRO edges** now calculate confidence per resolution tier (#412)
- **LadybugDB lock** — retry on DB lock with session-safe cleanup (#325)
- **CORS** — allow private/LAN network origins (#390)
- **Analyze without git** — allow indexing folders without a `.git` directory (#384)
- **Web: LadybugDB** — `getAllRows`, `loadServerGraph`, BM25, highlight clearing (#474)
- **Server-mode hydration** — await server connect hydration flow (#398, #404)
- **Embedding dimensions** — validate on every vector, not just the first; hard-throw on mismatch
- **Timeout detection** — always-on dim validation, test hardening
- **ONNX CUDA** — prevent uncatchable native crash when CUDA libs present but ORT lacks CUDA provider; clarify linux/x64-only
- **CLI** — run codex mcp add via shell on Windows; write tool output to stdout via fd 1
- **Stale progress, cross-platform prepare, DEV log** fixes
- **Import resolution API** simplified per PR #409 review findings (P0–P3)
- **Auto-labeling** — switched from clustering to z-score method; multi-dim aware Mahalanobis threshold
- **PR/issue filtering** — fixed prop cutoff issue
- **Sequential enrichment queries** + stale data detection
- **package-lock.json** synced with `onnxruntime-node ^1.24.0`

### Changed
- **Unified language dispatch** with compile-time exhaustive tables
- **Prepare script simplified** — removed `scripts/prepare.cjs`
- **Switched from .githooks to husky** for pre-commit hooks
- **`@claude` workflow** restricted to maintainers and above via `author_association` check

### Performance
- **O(1) per-chunk synthesis guard** using `boolean[]` instead of Set
- **`sizeBefore` optimization** in type resolution
- **Token truncation** improvements

### Chore
- Strengthened Python module-import tests, un-skipped match/case, added perf guard
- Added positive and negative tests for all 4 bug fixes
- E2e tests for stale detection, sequential enrichment, stability (#396)
- Integration tests for Milestone D across all 11 languages
- `gitnexus-stable-ops` added to community integrations
- `.env.example` added for embedding backend configuration

## [1.4.7] - 2026-03-19

### Added
- **Phase 8 field/property type resolution** — ACCESSES edges with `declaredType` for field reads/writes (#354)
- **Phase 9 return-type variable binding** — call-result variable binding across 11 languages (#379)
  - `extractPendingAssignment` in per-language type extractors captures `let x = getUser()` patterns
  - Unified fixpoint loop resolves variable types from function return types after initial walk
  - Field access on call-result variables: `user.name` resolves `name` via return type's class definition
  - Method-call-result chaining: `user.getProfile().bio` resolves through intermediate return types
  - 22 new test fixtures covering call-result and method-chain binding across all supported languages
  - Integration tests added for all 10 language resolver suites
- **ACCESSES edge type** with read/write field access tracking (#372)
- **Python `enumerate()` for-loop support** with nested tuple patterns (#356)
- **MCP tool/resource descriptions** updated to reflect Phase 9 ACCESSES edge semantics and `declaredType` property

### Fixed
- **mcp**: server crashes under parallel tool calls (#326, #349)
- **parsing**: undefined error on languages missing from call routers (#364)
- **web**: add missing Kotlin entries to `Record<SupportedLanguages>` maps
- **rust**: `await` expression unwrapping in `extractPendingAssignment` for async call-result binding
- **tests**: update property edge and write access expectations across multiple language tests
- **docs**: corrected stale "single-pass" claims in type-resolution-system.md to reflect walk+fixpoint architecture

### Changed
- **Upgrade `@ladybugdb/core` to 0.15.2** and remove segfault workarounds (#374)
- **type-resolution-roadmap.md** overhauled — completed phases condensed to summaries, Phases 10–14 added with full engineering specs

## [1.4.6] - 2026-03-18

### Added
- **Phase 7 type resolution** — return-aware loop inference for call-expression iterables (#341)
  - `ReturnTypeLookup` interface with `lookupReturnType` / `lookupRawReturnType` split
  - `ForLoopExtractorContext` context object replacing positional `(node, env)` signature
  - Call-expression iterable resolution across 8 languages (TS/JS, Java, Kotlin, C#, Go, Rust, Python, PHP)
  - PHP `$this->property` foreach via `@var` class property scan (Strategy C)
  - PHP `function_call_expression` and `member_call_expression` foreach paths
  - `extractElementTypeFromString` as canonical raw-string container unwrapper in `shared.ts`
  - `extractReturnTypeName` deduplicated from `call-processor.ts` into `shared.ts` (137 lines removed)
  - `SKIP_SUBTREE_TYPES` performance optimization with documented `template_string` exclusion
  - `pendingCallResults` infrastructure (dormant — Phase 9 work)

### Fixed
- **impact**: return structured error + partial results instead of crashing (#345)
- **impact**: add `HAS_METHOD` and `OVERRIDES` to `VALID_RELATION_TYPES` (#350)
- **cli**: write tool output to stdout via fd 1 instead of stderr (#346)
- **postinstall**: add permission fix for CLI and hook scripts (#348)
- **workflow**: use prefixed temporary branch name for fork PRs to prevent overwriting real branches
- **test**: add `--repo` to CLI e2e tool tests for multi-repo environment
- **php**: add `declaration_list` type guard on `findClassPropertyElementType` fallback
- **docs**: correct `pendingCallResults` description in roadmap and system docs

### Chore
- Add `.worktrees/` to `.gitignore`

## [1.4.5] - 2026-03-17

### Added
- **Ruby language support** for CLI and web (#111)
- **TypeEnvironment API** with constructor inference, self/this/super resolution (#274)
- **Return type inference** with doc-comment parsing (JSDoc, PHPDoc, YARD) and per-language type extractors (#284)
- **Phase 4 type resolution** — nullable unwrapping, for-loop typing, assignment chain propagation (#310)
- **Phase 5 type resolution** — chained calls, pattern matching, class-as-receiver (#315)
- **Phase 6 type resolution** — for-loop Tier 1c, pattern matching, container descriptors, 10-language coverage (#318)
  - Container descriptor table for generic type argument resolution (Map keys vs values)
  - Method-aware for-loop extractors with integration tests for all languages
  - Recursive pattern binding (C# `is` patterns, Kotlin `when/is` smart casts)
  - Class field declaration unwrapping for C#/Java
  - PHP `$this->property` foreach member access
  - C++ pointer dereference range-for
  - Java `this.data.values()` field access patterns
  - Position-indexed when/is bindings for branch-local narrowing
- **Type resolution system documentation** with architecture guide and roadmap
- `.gitignore` and `.gitnexusignore` support during file discovery (#231)
- Codex MCP configuration documentation in README (#236)
- `skipGraphPhases` pipeline option to skip MRO/community/process phases for faster test runs
- `hookTimeout: 120000` in vitest config for CI beforeAll hooks

### Changed
- **Migrated from KuzuDB to LadybugDB v0.15** (#275)
- Dynamically discover and install agent skills in CLI (#270)

### Performance
- Worker pool threshold — skip worker creation for small repos (<15 files or <512KB total)
- AST walk pruning via `SKIP_SUBTREE_TYPES` for leaf-only nodes (string, comment, number literals)
- Pre-computed `interestingNodeTypes` set — single Set.has() replaces 3 checks per AST node
- `fastStripNullable` — skip full nullable parsing for simple identifiers (90%+ case)
- Replace `.children?.find()` with manual for loops in `extractFunctionName` to eliminate array allocations

### Fixed
- Same-directory Python import resolution (#328)
- Ruby method-level call resolution, HAS_METHOD edges, and dispatch table (#278)
- C++ fixture file casing for case-sensitive CI
- Template string incorrectly included in AST pruning set (contains interpolated expressions)

## [1.4.0] - Previous release
