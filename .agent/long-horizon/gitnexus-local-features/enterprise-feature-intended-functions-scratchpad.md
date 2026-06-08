# Enterprise Feature Intended Functions Scratchpad

Created: 2026-06-05T01:13:48+01:00
Status: active working evidence
Branch: local/gitnexus-local-features
Canonical bundle: .agent/long-horizon/gitnexus-local-features/

Current role: subordinate scratchpad evidence only. Stable conclusions, queue status, and implementation gates live in `documentation.md` and `plans.md`; this file is not a control surface and must not be used as an implementation queue.

Route note: this scratchpad has been normalized to current command names after the 2026-06-05 helper quarantine. Older evidence was originally gathered before the quarantine; current workflow uses bare `gitnexus` for the host/npm CLI and `gitnexus-podman` for the Podman/container runtime.

## Purpose

This scratchpad records source-backed research into GitNexus enterprise-positioned and upcoming feature intentions:

- intended function
- intended operating model
- reference code or adjacent implementation evidence
- local OSS alignment/misalignment
- feasibility and unanswered questions

This is working evidence only. Durable decisions must be promoted into prompt.md, plans.md, implement.md, or documentation.md. Implementation remains blocked until MAIN explicitly marks the work READY_FOR_IMPLEMENTATION.

## 2026-06-05 Coordinated 60-90 Minute Research Pass

Start timestamp: `2026-06-05T10:22:16.7587586+01:00`

Requested duration: 60-90 minutes of coordinated research.

Operating rule:

- Research all seven candidate features together, not as isolated mini-projects.
- Use tiered depth: decision-grade for Auto-Reindexing, medium for PR Review / Blast Radius and Auto-Updating Code Wiki, light scoping for Auto Regression Forensics, End-to-End Test Generation, Multi-Repo Support Improvements, and OCaml Support.
- Keep this scratchpad as working evidence only. Promote durable conclusions into `plans.md` and `documentation.md`.
- Do not edit GitNexus source files during this research pass.

Research blocks:

| Block | Target duration | Objective | Evidence classes |
| --- | ---: | --- | --- |
| 1 | 20-30 min | Local source ownership and actual current behavior across all seven features. | repo source, tests, docs, changelog, package scripts, current branch status |
| 2 | 20-30 min | Public/GitHub intended behavior and reference-code evidence across all seven features. | README/product positioning, GitHub PRs/issues, changelog/release evidence, upstream source references |
| 3 | 20-30 min | Methodology, dependency synthesis, sequencing, risks, and implementation-readiness gates. | software delivery methodology sources, local dependency map, evidence sufficiency review |

Expected outputs:

- Feature-wide expected-vs-actual table.
- Public evidence table with fact vs inference.
- Local source ownership map.
- Cross-feature dependency map.
- Recommended sequencing and first implementation target.
- Required approvals and stop rules before source edits.

### Block 1 - Local Source Ownership And Actual Behavior

Block 1 checkpoint timestamp: `2026-06-05T10:23:45.6187291+01:00`

Commands run:

```powershell
rg -n "ReindexWatcher|reindexOperations|startReindexJob|checkStaleness|listRegisteredRepos|ReindexTrigger|requestReindex|freshness|stale" gitnexus/src gitnexus/test -g "*.ts"
rg -n "wiki|Code Wiki|generateWiki|WikiGenerator|cursor|llm|mermaid|html-viewer" gitnexus/src gitnexus/test -g "*.ts" -g "*.md"
rg -n "detect_changes|api_impact|impact|blast|pull request|PR review|review" gitnexus/src gitnexus/test ARCHITECTURE.md README.md gitnexus/README.md -g "*.ts" -g "*.md"
rg -n "group_sync|group list|group status|GroupService|groupImpact|contract|Contract|cross-impact|bridge|workspace extractor|multi-repo|cross-repo" gitnexus/src gitnexus/test ARCHITECTURE.md README.md gitnexus/README.md -g "*.ts" -g "*.md"
rg -n "regression forensics|forensics|regression.*forensic|shape-check|tripwire|eval|benchmark|test generation|generate.*test|e2e.*generation|end-to-end test" gitnexus/src gitnexus/test README.md gitnexus/README.md gitnexus/CHANGELOG.md -g "*.ts" -g "*.md"
rg -n "OCaml|ocaml|SUPPORTED_LANGUAGES|supportedLanguages|tree-sitter-ocaml|MIGRATED_LANGUAGES|SCOPE_RESOLVERS|LanguageProvider|scope resolver" gitnexus/src gitnexus/test README.md gitnexus/README.md package.json gitnexus/package.json -g "*.ts" -g "*.md" -g "*.json"
Get-Content gitnexus-shared\src\languages.ts
Get-Content gitnexus\src\core\ingestion\languages\index.ts
Get-Content gitnexus\src\core\ingestion\registry-primary-flag.ts
Get-Content gitnexus\src\core\ingestion\scope-resolution\pipeline\registry.ts
rg -n "tree-sitter-|@tree-sitter|tree-sitter" gitnexus/package.json package.json gitnexus-shared/package.json
```

Local source ownership map:

| Feature | Local source surfaces found | Actual local behavior signal |
| --- | --- | --- |
| Auto-Reindexing | `gitnexus/src/server/reindex-watcher.ts`, `reindex-control.ts`, `reindex-operations.ts`, `reindex-follow-up.ts`, `api.ts`, `gitnexus/src/core/git-staleness.ts`, `gitnexus/src/storage/repo-manager.ts`, `gitnexus/src/mcp/local/local-backend.ts`; tests `reindex-*`, `staleness.test.ts`, hook staleness tests | Strong skeleton/control plane exists: watcher scheduler, dry-run defaults, ignored paths, manual/sweep reasons, API queue, operation ledger, coalescing/follow-up, staleness primitives. Runtime auto-orchestration still appears incomplete or not generally enabled. |
| Auto-Updating Code Wiki | `gitnexus/src/cli/wiki.ts`, `gitnexus/src/core/wiki/generator.ts`, `graph-queries.ts`, `llm-client.ts`, `local-cli-client.ts`, `cursor-client.ts`, `html-viewer.ts`, `mermaid-sanitizer.ts`, `prompts.ts`; tests `wiki-flags.test.ts`, `wiki-llm-client.test.ts`, `wiki-mermaid-sanitizer.test.ts`, CLI wiki tests | Full manual wiki generation path exists, including module tree review, LLM providers, local CLI providers, HTML viewer, meta/module-tree cache behavior. No confirmed automatic refresh trigger yet. |
| PR Review / Blast Radius | `gitnexus/src/mcp/tools.ts`, `gitnexus/src/mcp/server.ts`, `gitnexus/src/mcp/local/local-backend.ts`, `gitnexus/src/cli/tool.ts`, `gitnexus/src/cli/detect-changes-format.ts`, `api_impact` path, `gitnexus/test/integration/api-impact-e2e.test.ts`, `detect-changes-worktree.test.ts`, `tool-direct-cli.test.ts`, `tools.test.ts` | Impact, detect_changes, and api_impact primitives exist. Local behavior supports report-building, but no dedicated PR-review product surface or GitHub comment/posting lane is confirmed locally. |
| Auto Regression Forensics | Existing tripwires and diagnostics: `shape-check-regression.test.ts`, language scope-capture tripwires, pipeline benchmarks, `eval-server.ts`, WAL/sidecar recovery tests, many regression-named tests | There is broad regression evidence infrastructure, but no dedicated "auto regression forensics" feature surface found. Likely future orchestration/reporting over tests, graph diffs, eval-server, and failure classification. |
| End-to-End Test Generation | E2E tests and fixtures exist across CLI/MCP/resolvers/group/wiki; searches did not find a dedicated generated-test feature path | Current repo has strong E2E coverage but no confirmed local generator for producing end-to-end tests. Treat as product-positioning/light scoping until evidence appears. |
| Multi-Repo Support Improvements | `gitnexus/src/core/group/*`, `group.ts`, `GroupService`, `cross-impact.ts`, `bridge-db.ts`, `bridge-schema.ts`, contract extractors for HTTP/gRPC/topic/include/workspace ecosystems; tests under `gitnexus/test/integration/group/*` and `test/unit/mcp/group-repo-routing.test.ts` | Multi-repo/group support is already substantial: group sync, contracts, bridge graph, group-aware query/context/impact routing, group resources/status. The likely "improvement" scope is targeted hardening, not a new unified graph unless later approved. |
| OCaml Support | `README.md` lists OCaml support as enterprise-positioned. Local `SupportedLanguages` enum lacks OCaml. Provider registry and `SCOPE_RESOLVERS` omit OCaml. `gitnexus/package.json` has tree-sitter deps for current languages, not `tree-sitter-ocaml`. | No local OCaml support found. This is a language-provider/parser/resolver project with dependency, enum, provider, parser, fixtures, parity, and documentation work. |

Block 1 local conclusion:

- Auto-Reindexing, Code Wiki, PR/blast-radius, and multi-repo have real local building blocks.
- Auto-Reindexing remains the deepest first candidate because it provides graph freshness needed by PR reports, wiki refresh, and multi-repo status.
- Auto-Updating Code Wiki should likely depend on reindex/freshness success rather than duplicate staleness detection.
- PR Review / Blast Radius can likely start as local Markdown/JSON reports over existing primitives after freshness is solved.
- Regression Forensics and E2E Test Generation are not absent as testing practices, but they are absent as dedicated product features.
- OCaml is a separate language-support implementation, not a small orchestration layer.

### Block 2 - Public / GitHub Intended Behavior And Reference Evidence

Block 2 checkpoint timestamp: `2026-06-05T10:26:22.7947660+01:00`

Web/source searches run:

```text
GitNexus Auto-reindexing PR Review Auto-updating Code Wiki enterprise README
site:github.com/abhigyanpatwari/GitNexus auto reindex GitNexus PR 205
site:github.com/abhigyanpatwari/GitNexus auto reindex GitNexus PR 1070
site:github.com/abhigyanpatwari/GitNexus GitNexus Code Wiki wiki generation
site:github.com/abhigyanpatwari/GitNexus "PR Review" "blast radius"
site:github.com/abhigyanpatwari/GitNexus "api_impact" "PR"
site:github.com/abhigyanpatwari/GitNexus "detect_changes" "pull request"
site:github.com/abhigyanpatwari/GitNexus "Auto regression forensics"
tree-sitter-ocaml npm package grammar OCaml
GitNexus OCaml support GitHub issue
site:github.com/abhigyanpatwari/GitNexus OCaml support
OCaml tree-sitter language parser JavaScript npm
```

Public evidence table:

| Source | Feature(s) | Evidence type | What it supports |
| --- | --- | --- | --- |
| https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md | All seven candidates | Product-positioning fact | Public README names enterprise-positioned PR Review, Auto-updating Code Wiki, Auto-reindexing, Multi-repo support, OCaml support, plus upcoming Auto regression forensics and End-to-end test generation. This defines intended value, not local OSS behavior. |
| https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md | PR/blast-radius, wiki, multi-repo, language support, staleness | Architecture/source-map fact | Architecture maps staleness, MCP tools, `api_impact`, group-aware query/context/impact, wiki generation, and language support to concrete source areas. It supports our local ownership map. |
| https://github.com/abhigyanpatwari/GitNexus/pull/205 | Auto-Reindexing | Historical reference-code fact | Earlier merged PR implemented hook-based auto-reindex after commit/merge, embedding preservation, and AGENTS/CLAUDE guidance. Important for intended problem statement, but not acceptable as our implementation route because hooks are now forbidden locally. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1070 | Auto-Reindexing | Corrective docs/history fact | Later merged PR clarifies PostToolUse hook behavior is notification-only and explicitly leaves Enterprise Auto-reindexing as a distinct feature. This is strong evidence not to recreate hook-based auto-reindex as the local route. |
| https://github.com/abhigyanpatwari/GitNexus/issues/1400 | Auto-Reindexing, registry/staleness | Field-report fact | Windows issue reports analyze producing `.gitnexus` files while registry/status still show unindexed. This supports registry validation and explicit failure visibility as part of any auto-freshness design. |
| https://github.com/abhigyanpatwari/gitnexus/blob/main/gitnexus-claude-plugin/skills/gitnexus-cli/SKILL.md | Auto-Reindexing, wiki | Skill/docs fact | CLI skill says analyze runs first-time, after major changes, or when context reports stale; wiki is manual generation with `--force`, providers, timeout/retries, gist publishing. Supports manual current behavior. |
| https://github.com/abhigyanpatwari/GitNexus/issues/302 | Auto-Updating Code Wiki | Issue/commentary fact with caution | External generated docs-site issue suggests `gitnexus wiki` could feed docs/site work, but maintainers closed as product/docs ownership rather than implementation ticket. Useful caution: wiki automation needs ownership policy, not just code. |
| https://www.npmjs.com/package/tree-sitter-ocaml | OCaml Support | Primary package-registry fact | `tree-sitter-ocaml` exists, version 0.24.2, and exposes separate grammars for implementations, interfaces, and types. This makes OCaml technically feasible but does not reduce local implementation scope. |
| https://dora.dev/capabilities/working-in-small-batches/ | Methodology / sequencing | Delivery-method primary source | Supports small, testable implementation slices and warns that AI-generated large changes increase review risk. |
| https://dora.dev/capabilities/trunk-based-development/ | Branch/lane strategy | Delivery-method primary source | Supports minimizing long-lived/divergent branches and keeping work small. Compatible with the user decision to use one shared feature branch while implementing one feature at a time. |
| https://dora.dev/capabilities/continuous-integration/ | Verification strategy | Delivery-method primary source | Supports fast automated tests, short-lived branches, and fixing broken builds immediately. |
| https://docs.github.com/en/get-started/using-github/github-flow | Commit/PR hygiene | Vendor docs | Supports isolated complete commits and separate branches for unrelated changes. For this project, "unrelated" maps to keeping features sequential and commits scoped on the one chosen branch, not one branch per feature. |

Block 2 public evidence conclusion:

- Public positioning supports the seven-feature inventory but does not grant implementation entitlement or prove local availability.
- Auto-Reindexing has the clearest historical problem statement, but hook-based reference code should be treated as a warning and historical reference, not a route to copy.
- Code Wiki has mature manual OSS behavior and needs policy around freshness triggers, LLM cost, language, cache, and publishing before any automatic update work.
- PR Review / Blast Radius should be scoped initially as a local report over existing graph primitives rather than GitHub posting/review automation.
- Multi-repo support is already partially OSS/local through groups/contracts; "unified graph" in public positioning is ambiguous and must not be assumed to mean a single database without more evidence.
- OCaml is feasible through an existing tree-sitter grammar but remains a substantial language-support project.
- Research methodology supports one shared branch only if implementation remains small-batch, sequential, tested, and snapshotted.

### Block 3 - Dependency Synthesis, Sequencing, And Risk Review

Block 3 checkpoint timestamp: `2026-06-05T10:27:21.7192985+01:00`

Expected vs actual matrix:

| Feature | Expected behavior from public positioning | Actual local behavior from source | Gap |
| --- | --- | --- | --- |
| Auto-Reindexing | Knowledge graph stays fresh automatically. | Staleness detection, registry, reindex queue/API, operation ledger, and watcher scheduler skeleton exist; automatic safe server-side orchestration is not confirmed as active. | Need opt-in freshness orchestrator using existing primitives. |
| Auto-Updating Code Wiki | Documentation stays current automatically; manual Code Wiki exists in OSS. | Manual `gitnexus wiki` generation exists with LLM providers, cache/meta, review mode, HTML viewer, force regeneration. | Need post-reindex or freshness-driven orchestration, plus policy for LLM cost/publishing/cache. |
| PR Review / Blast Radius | Automated blast-radius analysis on pull requests. | `impact`, `detect_changes`, `api_impact`, `route_map`, `shape_check`, CLI/MCP tools, and tests exist. | Need report schema and local report command before GitHub posting/automation. |
| Auto Regression Forensics | Automatically explain regressions. | Many regression tripwires, benchmarks, shape checks, eval-server, and failure-oriented tests exist. | Need define product semantics: what signal is ingested, what output is generated, and what source of failure truth is used. |
| End-to-End Test Generation | Generate E2E tests. | Many E2E tests/fixtures exist; no dedicated generator path found. | Need research/design before implementation; likely depends on route/tool maps and PR/regression report schema. |
| Multi-Repo Support Improvements | Unified graph across repositories. | Group support exists: group sync/list/contracts/status, bridge graph, contract extractors, group-aware query/context/impact. | Need clarify whether improvement means hardening current group model or building a true unified graph; do not assume single DB. |
| OCaml Support | Additional language coverage. | No OCaml enum/provider/parser/dependency/resolver found. `tree-sitter-ocaml` exists externally. | Substantial language onboarding project with parser, provider, queries, fixtures, resolver, tests, docs. |

Dependency map:

```text
Auto-Reindexing
  -> PR Review / Blast Radius
  -> Auto-Updating Code Wiki
  -> Multi-Repo status/sync freshness improvements

PR Review / Blast Radius
  -> Auto Regression Forensics
  -> End-to-End Test Generation

Auto-Updating Code Wiki
  -> depends on Auto-Reindexing for graph freshness
  -> optionally depends on PR/report policy if wiki updates are published or reviewed

Multi-Repo Support Improvements
  -> depends on per-repo freshness for reliable group status/contracts
  -> may later influence PR/blast-radius when cross-repo reports are required

OCaml Support
  -> mostly independent of the orchestration stack
  -> increases blast radius across language-provider/parser/test infrastructure
```

Recommended sequencing:

1. Snapshot the planning/research bundle.
2. Draft a decision-complete Auto-Reindexing implementation plan.
3. If MAIN approves, implement the smallest Auto-Reindexing slice:
   - opt-in server-side freshness sweep
   - validated registered-repo loading
   - commit-staleness selection
   - existing reindex queue/job pathway
   - dry-run default
   - operation-ledger trigger visibility
4. After Auto-Reindexing is verified, implement PR Review / Blast Radius as a local Markdown/JSON report over `detect_changes`, `impact`, and `api_impact`.
5. After graph freshness and report schema are stable, implement Auto-Updating Code Wiki as opt-in post-reindex/wiki-refresh orchestration.
6. Reassess Multi-Repo improvements after freshness/report/wiki behavior shows whether current group status/contracts need hardening.
7. Keep Auto Regression Forensics and E2E Test Generation deferred until PR/report/test-output semantics are defined.
8. Keep OCaml deferred until it gets a separate language-support readiness plan.

Branch/lane conclusion:

- Use the one shared branch `local/gitnexus-local-features`.
- Do not create one branch per feature.
- Use small-batch commits and one active implementation slice at a time.
- A feature is not allowed to start because a prior feature is "mostly done"; it starts only after the previous slice is verified and documented.

Rigor review / overclaim checks:

- Do not claim Enterprise feature equivalence. These are independent local OSS-style implementations inspired by public positioning.
- Do not equate "multi-repo support" with "single unified graph" without explicit design approval.
- Do not implement hook-based auto-reindex, even though PR #205 is useful historical evidence.
- Do not hide automatic reindex operations as `direct`; observability needs a distinct trigger.
- Do not make native filesystem watching the correctness path on Windows/Podman; sweep/staleness should be correctness, watcher events optional acceleration.
- Do not trigger LLM wiki generation automatically without explicit policy for cost, provider, language, publication target, and cache invalidation.
- Do not start OCaml by only adding the npm grammar; language support requires enum/provider/query/resolver/fixtures/tests/docs.

Research-pass status:

- The pass produced enough evidence to keep Auto-Reindexing as first candidate.
- The pass is not implementation authorization.
- Required next step remains a decision-complete Auto-Reindexing implementation plan and `MAIN | READY_FOR_IMPLEMENTATION`.




## Methodology: Evidence-Led Long-Horizon Feature Delivery

This work should combine long-horizon task control with evidence-led software delivery:

1. Keep the durable task state in the four-file control bundle.
2. Use scratchpads only for working evidence, timestamps, commands, and interim synthesis.
3. Research before choosing branch/lane strategy or implementation order.
4. Treat each feature as a candidate capability with expected behavior, actual local behavior, dependency shape, risks, and a smallest safe slice.
5. Promote only stable conclusions into the canonical bundle.

## Methodology Sources To Use

| Source | Source class | Use in this task |
| --- | --- | --- |
| https://developers.openai.com/blog/run-long-horizon-tasks-with-codex | Primary/vendor methodology | Frames the multi-session Codex operating model and durable state/checkpoint need. |
| https://agilemanifesto.org/iso/en/principles.html | Primary methodology | Supports frequent delivery, changing requirements, and working increments. |
| https://scrumguides.org/scrum-guide.html | Primary methodology | Supports transparent backlog, increments, review, and empiricism. |
| https://dora.dev/capabilities/working-in-small-batches/ | Research-backed delivery guidance | Supports small implementation slices after research establishes dependency shape. |
| https://dora.dev/capabilities/continuous-integration/ | Research-backed delivery guidance | Supports regular integration on the agreed shared feature branch. |
| https://martinfowler.com/articles/continuousIntegration.html | Expert methodology | Supports continuous integration discipline and avoiding long-lived hidden divergence. |
| https://kanbanguides.org/the-kanban-guide/2025.5/ | Primary methodology | Supports visible workflow, WIP limits, and explicit policies. |
| https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/welcome.html | Vendor architecture guidance | Supports ADR-style decision capture where branch/lane or architecture choices matter. |
| https://adr.github.io/ | ADR community reference | Provides lightweight decision-record conventions. |
| https://www.sei.cmu.edu/library/attribute-driven-design-method-collection/ | Architecture method source | Supports quality-attribute-first architecture decomposition. |
| https://sma.nasa.gov/news/articles/newsitem/2026/03/25/identifying-objective-evidence-improves-requirement-implementation | Verification/process guidance | Supports objective evidence and auditability. |
| https://swehb.nasa.gov/spaces/SWEHBVD/pages/102695413/SWE-034%2B-%2BAcceptance%2BCriteria | Verification/process guidance | Supports explicit acceptance criteria before implementation. |
| https://github.github.com/gh-aw/patterns/research-plan-assign-ops/ | Agent workflow pattern | Supports research-plan-assign-operate coordination for multi-agent work. |
| https://github.com/obra/superpowers | Skill/methodology reference | Provides planning, TDD, debugging, and collaboration workflow discipline. |
| https://deepswe.datacurve.ai/ | Agentic SWE reference | Useful comparative evidence for long-running coding-agent methodology. |
| https://epoch.ai/publications/mirrorcode-preliminary-results | Agentic SWE benchmark/report | Useful comparative evidence for long-horizon coding-agent evaluation. |

## Research Questions

For each candidate feature, answer:

1. What function is GitNexus claiming or implying?
2. How is the feature intended to work operationally?
3. Is there public source, a PR, an issue, a changelog entry, or local code that can act as reference implementation evidence?
4. What exists in local OSS code now?
5. What is missing or enterprise-only?
6. What is the smallest safe local implementation slice, if any?
7. What approval, branch/lane, or stop rule is needed before implementation?

## Candidate Features

| Feature | Current research priority | Intended research outcome |
| --- | --- | --- |
| Auto-reindexing | Decision-grade now | Determine expected freshness model, existing local watcher/hook behavior, and safest first implementation slice. |
| Auto-updating Code Wiki | Medium now | Determine whether OSS wiki generation already exists and what orchestration is missing for automatic refresh. |
| PR review / blast radius | Medium now | Determine whether existing impact/detect_changes tools can support PR review and whether public automation reference exists. |
| Auto regression forensics | Light scoping now | Determine whether this is only upcoming/product-positioned or has reference code/eval scaffolding. |
| End-to-end test generation | Light scoping now | Determine whether this is only upcoming/product-positioned or has reference code/eval scaffolding. |
| Multi-repo support improvements | Light scoping now | Determine the gap between OSS registry/group support and enterprise unified graph claims. |
| OCaml support | Light scoping now | Determine language-parser feasibility and whether any local/public implementation exists. |

## Research Log

### 2026-06-05T01:13:48+01:00 - Scratchpad Created

Intent:

- Create a dedicated scratchpad for enterprise-feature intended-function research.
- Keep source-backed evidence separate from the canonical four-file control bundle until conclusions stabilize.
- Continue research autonomously, documenting frequently with source references.

Initial local commands already run:

```powershell
Get-Date -Format o
git -C "C:\Users\steve\projects\gitnexus\source-rc109-integration" status --short --branch
Get-ChildItem "C:\Users\steve\projects\gitnexus\source-rc109-integration\.agent\long-horizon\gitnexus-local-features" | Select-Object Name,Length,LastWriteTime
rg -n "Enterprise|PR Review|Auto-updating|Auto-reindexing|Multi-repo|OCaml|Code Wiki|regression|test generation|auto" "C:\Users\steve\projects\gitnexus\source-rc109-integration" -g "*.md" -g "*.ts" -g "*.json"
```

Initial local evidence:

| Source | Fact or inference | Finding |
| --- | --- | --- |
| README.md enterprise section | Fact | GitNexus positions PR Review, Auto-updating Code Wiki, Auto-reindexing, Multi-repo support, and OCaml support as Enterprise includes. |
| README.md upcoming section | Fact | Auto regression forensics and End-to-end test generation are listed as upcoming. |
| CHANGELOG.md / gitnexus/CHANGELOG.md | Fact | Auto-reindex hook behavior, workspace extractors, Rust workspace contracts, PR autofix, and hook-notification caveats appear in public changelog history. |
| gitnexus/README.md | Fact | OSS/local docs mention multi-repo registry behavior and MCP access across indexed repos. |
| CONTRIBUTING.md | Fact | Public CI automation contracts exist for PR autofix and Claude review workflows, which may be adjacent reference code for PR automation but not necessarily enterprise PR blast-radius review. |

### 2026-06-05T01:18:31+01:00 - Local Source Ownership And Public Evidence Pass 1

Commands run:

```powershell
rg --files "C:\Users\steve\projects\gitnexus\source-rc109-integration\gitnexus\src" | rg "(reindex|wiki|group|contract|impact|changes|language|ocaml|api-impact|review|watcher)"
rg --files "C:\Users\steve\projects\gitnexus\source-rc109-integration\gitnexus\test" | rg "(reindex|wiki|group|contract|impact|changes|ocaml|api-impact|watcher|regression|e2e)"
rg -n "auto[- ]?reindex|reindex|watcher|Code Wiki|wiki|detect_changes|blast|impact|group_sync|group_query|group_status|contract|OCaml|ocaml|regression|end-to-end|test generation|autofix|pull request|PR review" ...
rg -n "supportedLanguages|languages|ocaml|OCaml|tree-sitter|LanguageProvider|register|extensions" "...\gitnexus\src\core\ingestion" -g "*.ts"
rg -n "regression forensics|auto regression|end-to-end test|test generation|swe-bench|benchmark|resolve rate|evaluation|trajectory|eval" "...\eval" ...
```

Public sources opened:

| Source | Source class | Fact or inference | Finding |
| --- | --- | --- | --- |
| https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md | Upstream architecture doc | Fact | Current architecture documents ingestion, persistence, query layer, staleness checking, MCP tools including `impact`, `detect_changes`, `api_impact`, group-aware query/impact, Contract Bridge, and wiki/language ownership paths. |
| https://github.com/nxpatterns/gitnexus | README mirror/fork, likely tracking upstream README | Fact with caution | Public README text lists enterprise items: PR Review, Auto-updating Code Wiki, Auto-reindexing, Multi-repo support, OCaml support, plus upcoming Auto regression forensics and End-to-end test generation. Treat as product-positioning evidence unless confirmed by source code. |
| https://www.akonlabs.com/ | Official product site | Fact | Product site frames GitNexus as indexing any codebase into a graph of dependencies, call chains, clusters, and execution flows, then exposing tools to AI agents. It names impact analysis, multi-repo support, wiki generation, and git-diff impact as key features. |
| https://github.com/abhigyanpatwari/GitNexus/pull/205 | Upstream merged PR | Fact | Earlier OSS implementation added PostToolUse hook auto-reindex after commit/merge with embedding preservation. Important as historical reference code and intent, but not current behavior by itself. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1070 | Upstream merged PR | Fact | Later PR clarified current OSS PostToolUse behavior is notification-only, not auto-reindex. It explicitly leaves the enterprise Auto-reindexing README line intact as distinct from OSS hook behavior. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1256 | Upstream merged PR | Fact | Rust workspace cross-crate contract discovery provides reference design for group/multi-repo contract extraction and review hardening. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1446 | Upstream merged PR | Fact | Fork-safe PR autofix pipeline provides reference architecture for untrusted/trusted workflow split, artifacts, and PR feedback. Adjacent to PR Review, not blast-radius PR review itself. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1458 | Upstream merged PR | Fact | `/autofix` ChatOps button provides reference PR workflow UX and safe apply loop, but again for formatting/autofix rather than impact review. |
| https://toolchew.com/en/review-gitnexus/ | Third-party field review | Secondary evidence | Reports no real-time index updates in OSS and says indexing is manual; aligns with PR #1070 and reinforces the enterprise-vs-OSS gap. |

Local ownership map:

| Feature | Local reference files | Current local evidence |
| --- | --- | --- |
| Auto-reindexing | `gitnexus/src/server/reindex-watcher.ts`, `reindex-control.ts`, `reindex-operations.ts`, `reindex-follow-up.ts`, `gitnexus/src/server/api.ts`; tests under `gitnexus/test/unit/reindex-*` | Strong local reference code exists for server-side reindex queue, operations, API endpoints, coalesced requests, locks, follow-up reruns, and scheduler reasons (`watch`, `sweep`, `manual`). Need inspect whether it is wired to file watching/scheduled freshness in current runtime or only available as manual/API infrastructure. |
| Auto-updating Code Wiki | `gitnexus/src/cli/wiki.ts`, `gitnexus/src/core/wiki/generator.ts`, `html-viewer.ts`, `graph-queries.ts`, `llm-client.ts`; tests under `gitnexus/test/unit/wiki-*` | Strong OSS wiki generation exists. Generator has `full`, `incremental`, and `up-to-date` modes keyed by commit/meta. Missing enterprise piece appears to be orchestration that automatically runs wiki generation after index refresh or on schedule. |
| PR review / blast radius | `gitnexus/src/mcp/tools.ts`, `gitnexus/src/mcp/local/local-backend.ts`, `gitnexus/src/cli/detect-changes-format.ts`, `.github/prompts/gitnexus-pr-swarm-review.prompt.md`, `pr-swarm-review/`, `.github/workflows/claude.yml`, `.github/workflows/pr-autofix*.yml`; tests `detect-changes-worktree.test.ts`, `impact-*`, `api-impact-e2e.test.ts` | Strong primitives exist: `detect_changes` maps diffs to affected flows; `impact` returns risk, affected processes/modules, depth grouping; `api_impact` gives route-level pre-change risk. PR review automation itself appears only as read-only swarm prompt/workflows and PR autofix adjacency, not an enterprise blast-radius PR review service. |
| Multi-repo support improvements | `gitnexus/src/core/group/*`, `gitnexus/src/cli/group.ts`, `gitnexus/src/mcp/resources.ts`, `gitnexus/src/mcp/tools.ts`; tests under `gitnexus/test/unit/group` and `test/integration/group` | Strong OSS group/contract support exists: Contract Registry, group sync, cross-impact, workspace extractors, bridge DB. Misalignment: enterprise copy says unified graph across repositories, while architecture indicates group-aware routing plus Contract Bridge rather than one literal merged global graph. |
| OCaml support | `gitnexus-shared/src/languages.ts`, `gitnexus/src/core/ingestion/languages/index.ts`, `gitnexus/src/core/ingestion/language-provider.ts` | No local `ocaml` support found. Current provider registry includes JavaScript, TypeScript, Python, Java, Kotlin, Go, Rust, C#, C, C++, PHP, Ruby, Swift, Dart, Vue, and Cobol. OCaml would require adding enum/config/provider/parser/query/scope support and tests. |
| Auto regression forensics | `eval/README.md`, `eval/run_eval.py`, `eval/analysis/analyze_results.py`, `eval/environments/gitnexus_docker.py` | No direct feature found. Eval harness can compare GitNexus-assisted vs baseline agents on SWE-bench, resolve rate, and trajectories. This is reference infrastructure for measuring regressions/forensics but not an end-user feature yet. |
| End-to-end test generation | `eval/` plus `api_impact`/`shape_check` tooling | No direct feature found. Existing graph and eval primitives may inform future generation, but current evidence supports "upcoming only" rather than implemented. |

Interim synthesis:

- Auto-reindexing is still the only decision-grade-now candidate because there is real local infrastructure and a clear OSS/enterprise gap.
- The safest local direction should not use Claude/Codex hooks. User explicitly said we will not use hooks, and upstream PR #1070 gives a technical reason: synchronous auto-analyze from hooks risks blocking and database corruption on timeout.
- PR review and Code Wiki should remain medium-depth follow-ups: both have strong primitives, but the enterprise "automatic" orchestration/service layer is not yet proven in local OSS.
- Multi-repo is partially implemented locally through groups/contracts; research should avoid assuming "unified graph" means a single DB until source confirms that.
- OCaml, regression forensics, and E2E test generation remain light-scoping candidates unless a later search finds concrete source/PRs.

### 2026-06-05T01:23:00+01:00 - Local Git History And Runtime Wiring Pass

Commands run:

```powershell
git -C "C:\Users\steve\projects\gitnexus\source-rc109-integration" log --oneline --all --decorate --grep="reindex" --grep="wiki" --grep="OCaml" --grep="regression" --grep="test generation" --grep="PR Review" --grep="blast" --grep="workspace" --grep="group" -n 80
git -C "C:\Users\steve\projects\gitnexus\source-rc109-integration" log --all --oneline -- gitnexus/src/server/reindex-watcher.ts gitnexus/src/server/api.ts gitnexus/src/core/wiki/generator.ts gitnexus/src/core/group gitnexus-shared/src/languages.ts
rg -n "watcher|auto.*reindex|reindex.*watch|sweep|scheduler|/api/reindex|wiki.*auto|auto.*wiki|fromCommit|currentCommit|incremental|workspace_deps|OCaml|ocaml" "C:\Users\steve\projects\gitnexus\source-rc109-integration" -g "*.md" -g "*.ts" -g "*.json" -g "*.yml" -g "*.yaml"
rg -n "ReindexWatcher|readReindexWatcherConfig|watcher|GITNEXUS_REINDEX_WATCHER|sweepDue|markAllDirty|recordChange" "...\gitnexus\src\server\api.ts" "...\gitnexus\src" -g "*.ts"
```

Additional local evidence:

| Area | Evidence | Finding |
| --- | --- | --- |
| Auto-reindexing | `git log` shows local commits `local: add constrained reindex control plane`; `reindex-watcher.ts`; `reindex-control.ts`; `reindex-api-wiring.test.ts`; `reindex-watcher.test.ts` | Local branch already has a control-plane skeleton: env config, debounce, dry-run default, ignored paths, dirty repo tracking, queue/coalescing, `/api/reindex`, job status endpoints, graph read gating for unstable overlap windows, and follow-up reruns. |
| Auto-reindex runtime wiring | `rg ReindexWatcher...` finds only `reindex-watcher.ts` and `reindex-watcher.test.ts` | The scheduler is not currently wired into `api.ts` or another runtime entrypoint. Current implementation looks like reference/skeleton code plus manual API queue, not a complete active watcher. |
| Auto-reindex safety defaults | `readReindexWatcherConfigFromEnv` | Watcher starts disabled and dry-run by default: `GITNEXUS_REINDEX_WATCHER=false`, `GITNEXUS_REINDEX_WATCHER_DRY_RUN=true`, debounce 2000ms, sweep 60000ms, embeddings true. This is a good safety shape for research/development. |
| No hooks route | PR #1070 plus user direction | Use server-side/API/sweep/watch orchestration if implemented. Do not route through Claude/Codex hooks. |
| Code Wiki | `gitnexus/src/core/wiki/generator.ts` header and implementation | Wiki generator already supports incremental updates using git diff plus module-file mapping. It stores `fromCommit`, compares to current commit, returns `up-to-date` when unchanged, and regenerates affected module pages on incremental path. |
| Code Wiki history | `git log` shows `feat(wiki): support local Claude and Codex providers (#1769)`, `fix(wiki): add budget-aware grouping`, `feat(wiki): --lang`, timeout/retry hardening | Wiki generation is a mature OSS subsystem. Enterprise "auto-updating" likely means orchestrating this generator after index changes, not inventing wiki generation. |
| Multi-repo/group | `git log` shows staged evolution: group infrastructure, bridge DB, contract matching, cross-repo impact, workspace extractors, HTTP/include/thrift/gRPC extractors | Multi-repo has extensive reference code. The gap is product wording and maybe breadth/automation rather than no local implementation. |
| Incremental analyze | `GUARDRAILS.md`, `run-analyze.ts`, `repo-manager.ts`, incremental tests | `analyze` already runs incrementally by default with dirty-flag recovery and `incremental ≡ --force` correctness tests. Auto-reindex design must account for this: automatic freshness can call normal analyze rather than a bespoke partial parser, subject to resource controls. |
| PR review | `pr-swarm-review/README.md` and `.github/prompts/gitnexus-pr-swarm-review.prompt.md` | There is a read-only, manually invoked PR review methodology with seven lanes and CLI-neutral wrappers. It is not the same as enterprise automated blast-radius analysis, but it is reference process/design material. |
| Regression/test generation | `eval/README.md`, `eval/run_eval.py`, `eval/analysis/analyze_results.py` | Eval harness measures structural-code-intelligence impact on SWE-bench resolve rate/cost/efficiency. This is evidence infrastructure, not direct auto-regression-forensics or E2E-test-generation product code. |

Revised feature interpretation:

| Feature | Intended function | Intended operating model inferred from evidence | Reference code status |
| --- | --- | --- | --- |
| Auto-reindexing | Keep the knowledge graph fresh automatically. | Watch or sweep registered repos, debounce changes, request constrained `analyze` through server API/queue, coalesce active requests, preserve embeddings unless configured otherwise, expose job status. Must be opt-in and safe by default. | Strong local skeleton exists but runtime watcher wiring appears absent. Historical hook PR exists but later upstream docs say hooks are notification-only, so hooks are not the route. |
| Auto-updating Code Wiki | Keep generated architecture docs current with code/index changes. | Run wiki generator after a successful fresh index, using its commit-aware incremental mode. Avoid regenerating when `fromCommit === HEAD`. | Strong generator/incremental code exists; automatic orchestration not proven. |
| PR review / blast radius | Analyze pull requests for affected symbols/processes/modules and risk before merge. | Compute PR diff against base ref, feed changes to `detect_changes`, run `impact`/`api_impact` for high-risk symbols/routes, publish a structured PR report/check/comment. | Strong graph primitives and PR workflow references exist; specific automated enterprise PR blast-radius service not found yet. |
| Multi-repo support improvements | Make cross-repo/service relationships queryable for large orgs. | Use registry + group config + contract extraction + bridge graph + group-aware query/impact/resources. | Strong local code exists. Exact "unified graph" wording likely maps to group/bridge abstraction unless proven otherwise. |
| OCaml support | Add OCaml language coverage. | Add language enum/provider/parser/query/scope support and tests. Need external parser feasibility research before planning. | No local support/reference implementation found. |
| Auto regression forensics | Explain or localize regressions automatically. | Likely combine graph impact, git/test failure evidence, and eval/trajectory analysis. | No direct implementation found; eval harness is adjacent. |
| End-to-end test generation | Generate tests from graph/process/API knowledge. | Likely use execution flows, route/tool maps, shape checks, and affected-process data to propose tests. | No direct implementation found; graph primitives are adjacent. |

Research confidence after pass 2:

- High confidence: auto-reindexing and Code Wiki have real local building blocks.
- Medium confidence: PR review can be built from existing primitives, but automated enterprise workflow shape is not yet directly evidenced.
- Medium confidence: multi-repo support exists through groups/contracts, but "unified graph" requires wording discipline.
- Low confidence: OCaml, auto regression forensics, and E2E test generation are only product/upcoming claims without local implementation evidence so far.

### 2026-06-05T01:27:00+01:00 - Final Public Sweep For Missing Reference Code

Searches run:

```text
"GITNEXUS_REINDEX_WATCHER"
"ReindexWatcherScheduler" "GitNexus"
"gitnexus" "reindex-watcher"
"workspace_deps" "GitNexus"
tree-sitter OCaml grammar npm tree-sitter-ocaml
GitHub tree-sitter-ocaml grammar npm
npm tree-sitter-ocaml
OCaml tree-sitter parser JavaScript npm
```

Additional source evidence:

| Source | Source class | Fact or inference | Finding |
| --- | --- | --- | --- |
| https://www.npmjs.com/package/tree-sitter-ocaml | Primary package registry | Fact | `tree-sitter-ocaml` exists as an npm package, version 0.24.2, published recently enough to be viable for feasibility research. It exposes separate grammars for OCaml implementations, interfaces, and types. |
| https://www.npmjs.com/package/tree-sitter | Primary package registry | Fact | Node Tree-sitter expects a language grammar package and shows the standard parser + language wiring pattern GitNexus already follows for other languages. |
| Search for `GITNEXUS_REINDEX_WATCHER` / `ReindexWatcherScheduler` | Negative public-source evidence | Fact with caveat | No public indexed result found for the local watcher symbols. This suggests the watcher skeleton may be local/unreleased or too new for indexing. Treat it as local reference code, not upstream/public evidence. |
| Search for `workspace_deps` | Public adjacent evidence | Fact | Public search mostly returned competitor/comparison material; local source remains the authoritative evidence for workspace dependency extraction. |

Negative evidence to preserve:

- No public PR/issue/source result found for a complete GitNexus auto-updating wiki daemon or hosted scheduler.
- No public PR/issue/source result found for GitNexus OCaml implementation code.
- No public PR/issue/source result found for implemented GitNexus auto regression forensics or end-to-end test generation features.
- No public result found for the local `ReindexWatcherScheduler` symbols, so do not assume this has shipped upstream.

Research conclusion for current planning:

1. Auto-reindexing should be researched and decomposed first because there is local skeleton code, upstream historical intent, upstream warning against hook-based auto-run, and a clear enterprise-local gap.
2. The first candidate slice should likely be a safe runtime integration around the existing reindex queue/scheduler, not a new parser/indexer.
3. Code Wiki automatic refresh is likely a dependent or second slice: after a successful auto-reindex, optionally trigger wiki incremental generation, but only after we settle reindex safety and resource controls.
4. PR blast-radius review should be treated as a separate feature because it needs GitHub event/auth/workflow design, output contracts, and fork-safety. Existing PR autofix workflows are useful as security architecture references.
5. Multi-repo improvements should not be first unless MAIN decides the enterprise target is org-wide graph behavior rather than local freshness. It has many moving parts but already strong local code.
6. OCaml, regression forensics, and E2E test generation should remain deferred/light-scoping until auto-reindexing and PR/wiki dependencies are understood.

### 2026-06-05T10:30:34+01:00 - Coordinated Research Pass Continuation

User request:

- Dedicate 60-90 minutes to coordinated research.
- Track time objectively.
- Use the active scratchpad.
- Work in coordinated blocks.
- Keep the research feature-wide across all seven candidates.

Objective time marker:

```powershell
Get-Date -Format o
# 2026-06-05T10:30:34.4726426+01:00
```

Skills/methods consulted:

| Skill or method source | Use in this pass | Adaptation |
| --- | --- | --- |
| `autoresearch` | Use looped research/synthesis discipline and explicit evidence capture. | Do not create a separate research workspace because this task already has a long-horizon control bundle and active scratchpad. |
| `superpowers:using-superpowers` | Confirm that relevant skills should be checked before acting. | Applied through current Codex skill-reading mechanism. |
| `superpowers:writing-plans` | Use file/responsibility mapping before plan decomposition. | Do not write an implementation plan yet because `MAIN | READY_FOR_IMPLEMENTATION` is not granted. |
| `ara-rigor-reviewer` | Use epistemic checks: evidence relevance, scope calibration, argument coherence, methodology rigor. | Do not create ARA Level 2 artifacts; use the review dimensions as a scratchpad quality rubric. |

Commands run:

```powershell
Get-Date -Format o
git status --short --branch
Get-Content C:\Users\steve\.codex\skills\0-autoresearch-skill\SKILL.md -TotalCount 220
Get-Content C:\Users\steve\.codex\skills\research-manager\SKILL.md -TotalCount 220
Get-Content C:\Users\steve\.codex\skills\rigor-reviewer\SKILL.md -TotalCount 220
Get-Content C:\Users\steve\.codex\plugins\cache\openai-curated\superpowers\e2d08a2e\skills\using-superpowers\SKILL.md -TotalCount 180
Get-Content C:\Users\steve\.codex\plugins\cache\openai-curated\superpowers\e2d08a2e\skills\writing-plans\SKILL.md -TotalCount 220
Get-Command ctx7 -ErrorAction SilentlyContinue
rg -n "reindex|stale|staleness|watch|scheduler|wiki|blast|impact|detect_changes|group_|group |contract|ocaml|tree-sitter-ocaml|regression|forensic|e2e|test generation" gitnexus/src gitnexus/test README.md ARCHITECTURE.md
rg --files gitnexus/src gitnexus/test | rg "(reindex|stale|wiki|impact|detect|group|contract|regression|e2e|language|parser|ocaml|tree-sitter)"
rg -n "const startReindexJob|/api/reindex|reindex/status|ReindexWatcher|readReindexWatcherConfig|refreshRepoIndex|trigger|reason|pending_rerun|reindex\.completed" gitnexus/src/server/api.ts gitnexus/src/server/reindex-*.ts gitnexus/src/mcp/local/local-backend.ts gitnexus/test/unit/reindex-*.test.ts
rg -n "generateWiki|incremental|fromCommit|currentCommit|up-to-date|force|metadata|summary|lang|provider|timeout|retries" gitnexus/src/core/wiki gitnexus/src/cli/wiki.ts gitnexus/test/unit/wiki-*.test.ts
rg -n "detect_changes|impact|api_impact|diff|risk|affected_processes|affected_modules|group mode|cross|pull request|PR|base_ref|HEAD" gitnexus/src/mcp/tools.ts gitnexus/src/mcp/local/local-backend.ts gitnexus/src/cli/detect-changes-format.ts gitnexus/test/unit/detect-changes-worktree.test.ts gitnexus/test/integration/api-impact-e2e.test.ts .github pr-swarm-review -g "*.ts" -g "*.md" -g "*.yml" -g "*.yaml"
rg -n "group_sync|group_status|contracts|Contract Registry|bridge|cross-impact|workspace|unified|@<group|Contract Bridge|extractor|sync" gitnexus/src/core/group gitnexus/src/cli/group.ts gitnexus/src/mcp/tools.ts gitnexus/src/mcp/resources.ts gitnexus/test/unit/group gitnexus/test/integration/group ARCHITECTURE.md README.md
rg -n "OCaml|ocaml|SupportedLanguages|tree-sitter|LANGUAGE_CONFIGS|SCOPE_RESOLVERS|LanguageProvider|extensions" gitnexus/package.json gitnexus-shared/src gitnexus/src/config gitnexus/src/core/ingestion gitnexus/src/core/tree-sitter gitnexus/test/unit/tree-sitter-queries.test.ts gitnexus/test/integration/tree-sitter-languages.test.ts
```

Local evidence refinement:

| Feature | Evidence class | What is now stronger | What is still not proven |
| --- | --- | --- | --- |
| Auto-reindexing | Local source and tests | `ReindexWatcherScheduler` has a concrete request model with reasons `watch`, `sweep`, `manual`; env config is disabled and dry-run by default; API reindex jobs record trigger lineage and refresh repo handles before completion. | The watcher/scheduler is still not proven wired into the server startup path; a source search found scheduler tests and API queue code, but not runtime activation. |
| Auto-updating Code Wiki | Local source and tests | Wiki generation has explicit commit metadata, `up-to-date` detection, incremental diff mode, language/provider/timeout/retry controls, and full regeneration fallback when history diverges. | No automatic trigger after reindex is proven. Any auto-wiki feature needs provider/cost/publication policy before code. |
| PR review / blast radius | Local source and workflows | `detect_changes` supports compare scope and worktree-aware diff cwd; `impact` and `api_impact` expose risk and affected process/module data; `.github` has fork-safe PR automation patterns through autofix workflows. | No dedicated automated blast-radius PR review command/check/comment has been found. Existing autofix workflows are security-pattern evidence, not feature implementation. |
| Multi-repo support improvements | Local source and architecture docs | Group mode is documented as `@<group>` routing; `query`, `context`, and `impact` are group-aware; Contract Bridge and group resources exist; many extractors and tests exist. | README's "unified graph" wording should not be read literally as a single merged DB without more design evidence. Current architecture says group routing plus bridge fan-out. |
| OCaml support | Local negative evidence | Current language onboarding path is clear: shared enum, extension map, package dependency, parser loader, provider, queries, scope resolver, fixtures, integration tests. | There is no local OCaml entry in supported languages, no `tree-sitter-ocaml` dependency, and no OCaml resolver/provider. |
| Auto regression forensics | Local negative/adjacent evidence | Existing regression tests and eval harness provide raw material for future forensics. | No product-level feature surface or intended workflow has been found. |
| End-to-end test generation | Local negative/adjacent evidence | Existing E2E fixtures, API impact tests, and graph process data could inform future generated tests. | No generator feature surface has been found. |

Scope calibration after local deepening:

- Supported: "Auto-Reindexing is the strongest first implementation candidate."
- Supported: "Code Wiki and PR review are realistic second/third candidates because primitives exist."
- Supported: "Multi-repo support is already a substantial feature family; improvements need a named gap."
- Supported: "OCaml is a separate language-support project, not a minor toggle."
- Not supported: "All seven enterprise/upcoming features are equally implementation-ready."
- Not supported: "Runtime auto-reindexing already works end-to-end."
- Not supported: "Enterprise multi-repo support necessarily means one physical unified graph."

### 2026-06-05T10:33:58+01:00 - Public / GitHub / Methodology Evidence Deepening

Time marker:

```powershell
Get-Date -Format o
# 2026-06-05T10:33:58.1870532+01:00
```

Web and Context7 searches:

```text
site:github.com/abhigyanpatwari/GitNexus/pull GitNexus auto reindex watcher reindex watcher
site:github.com/abhigyanpatwari/GitNexus/pull GitNexus wiki incremental automatic wiki reindex
site:github.com/abhigyanpatwari/GitNexus/pull GitNexus PR review blast radius detect_changes api_impact
site:github.com/abhigyanpatwari/GitNexus/issues GitNexus OCaml support tree-sitter-ocaml
ctx7 library tree-sitter "Node tree-sitter grammar package parser loading language grammar"
ctx7 docs /tree-sitter/tree-sitter "Node tree-sitter grammar package parser setLanguage language load grammar incremental parsing"
ctx7 library github-actions "pull_request_target workflow security untrusted fork code artifact trusted workflow"
ctx7 docs /websites/github_en_actions "pull_request_target security untrusted fork code workflow_run artifacts permissions"
ctx7 library chokidar "file watcher polling ignored paths await write finish windows docker"
ctx7 docs /paulmillr/chokidar "ignored paths polling awaitWriteFinish windows docker file watching"
```

Public evidence matrix:

| Source | Feature area | Evidence contribution | Planning implication |
| --- | --- | --- | --- |
| https://github.com/abhigyanpatwari/GitNexus/pull/205 | Auto-reindexing | Historical PR attempted PostToolUse auto-reindex after commit/merge, preserved embeddings, documented the stale-index problem, and used synchronous analyze. | Useful intent and failure-mode reference, but not the route to copy. User also said no hooks. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1070 | Auto-reindexing | Later PR corrected docs: PostToolUse is notification-only because synchronous analyze can block and risk DB corruption if killed. | Strong stop rule against hook-driven analyze. Prefer explicit server/API/sweep orchestration with observability and locking. |
| https://github.com/abhigyanpatwari/GitNexus/issues/253 | Auto-reindexing / multi-repo operations | Open feature request for `analyze --all` to reindex known repos, skip missing paths, respect `--force`/`--embeddings`, and print summary. | Supports a batch/sweep freshness mental model and argues for registry-driven repo enumeration. |
| https://github.com/abhigyanpatwari/GitNexus/issues/1400 | Auto-reindexing / Windows | Windows report where analyze created `.gitnexus` files but status/list still showed unindexed. | First implementation slice should verify registry visibility and failure reporting, not just process exit. |
| https://github.com/abhigyanpatwari/GitNexus/issues/326 | Runtime/MCP safety | Parallel heavy MCP calls crashed older GitNexus MCP server, while simpler tools survived. | Auto background work should avoid unbounded concurrency and should expose queue/lock state clearly. |
| https://github.com/abhigyanpatwari/GitNexus/issues/302 | Code Wiki / docs ownership | External generated docs site was closed as not planned; maintainers asked for focused docs PRs and ownership/RFC if adopting a first-party site. | Auto-updating wiki needs ownership, publication target, and update policy before implementation. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1446 | PR review / workflow safety | Fork-safe PR workflow split: untrusted `pull_request` job runs fork code without permissions; trusted `workflow_run` job consumes data artifact and posts results. | Any future GitHub-posting blast-radius review must preserve this trust split. Local report generation should come before posting automation. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1458 | PR workflow UX | ChatOps `/autofix` replaced fragile inline reviewdog UX for large/no-overlap diffs. | PR review UX should have a stable report/check artifact and avoid overreliance on brittle inline comments. |
| https://github.com/abhigyanpatwari/GitNexus/pull/1256 | Multi-repo support | Rust workspace extractor auto-discovers cross-crate contracts from Cargo workspace deps and merges discovered links with group manifest links. | Multi-repo support is already evolving through extractors/contracts/bridge; likely improvement work is targeted hardening/gap filling. |
| https://github.com/abhigyanpatwari/GitNexus/issues/256 | Multi-repo support | March user request asked about cross-repo analysis. | Confirms user demand existed; later local code and docs show substantial group-mode implementation has since appeared. |
| https://github.com/abhigyanpatwari/GitNexus/issues/271 | Enterprise scalability | Open request for multiple indexer/API instances, shared datastore, queue/leases, distributed cache/search, health/readiness/metrics. | Out of current local OSS-style scope unless MAIN expands to SaaS/self-hosted scaling; still useful as a boundary. |
| https://github.com/abhigyanpatwari/GitNexus/pull/305 | Language support analogue | Zig PR shows language support touches CLI/web parity, grammar provenance, exports, containers, type extraction, parser/query parity, syntax highlighting, and detect-changes exposure. | OCaml should be scoped as a full language-onboarding project, not merely `npm install tree-sitter-ocaml`. |
| https://github.com/abhigyanpatwari/GitNexus/pull/317 | Language support cautionary analogue | Scala PR followed the structural pattern but was judged not ready because type extraction/member CALLS correctness was broken. | OCaml acceptance needs type/member/call correctness tests, not just parser load tests. |
| https://www.npmjs.com/package/tree-sitter-ocaml | OCaml feasibility | `tree-sitter-ocaml` exists as an npm grammar package with OCaml implementation/interface/type grammars. | Feasible parser dependency exists, but integration burden remains high. |
| Context7: `/tree-sitter/tree-sitter` | OCaml feasibility | Tree-sitter parser setup requires loading/setting the language grammar; incremental parsing exists, but GitNexus uses its own graph pipeline around grammar output. | Confirms parser availability is only the first layer. Provider/query/resolver/fixtures remain required. |
| Context7: `/paulmillr/chokidar` | Auto-reindexing implementation options | Chokidar supports ignored filters, polling, `awaitWriteFinish`, and atomic write handling. | If watching is used, it should be optional acceleration; sweep/staleness remains the correctness path on Windows/Podman. |
| Context7: `/websites/github_en_actions` and GitHub secure-use docs | PR review / workflow safety | GitHub warns that `pull_request_target` and `workflow_run` with untrusted code can introduce security risks; secure-use guidance emphasizes injection risks and self-hosted runner caution. | PR posting automation requires explicit security design, minimal permissions, artifact validation, and likely no self-hosted runner for untrusted PRs. |

Methodology evidence matrix:

| Source | Research/use implication |
| --- | --- |
| https://developers.openai.com/blog/run-long-horizon-tasks-with-codex | Supports durable project memory, spec/plan/implement/status files, validation after milestones, and continuous documentation updates. This aligns with the four-file bundle. |
| https://dora.dev/capabilities/working-in-small-batches/ | Supports small implementation slices, frequent feedback, and avoiding huge AI-generated PRs. This supports one shared branch with one feature slice active at a time. |
| https://dora.dev/capabilities/trunk-based-development/ | Supports small batches, tests before commit, and keeping the integration branch healthy. This strengthens the shared-branch discipline. |
| https://docs.github.com/en/get-started/using-github/github-flow | Supports a short descriptive branch as a safe collaboration space; compatible with the user's one-branch decision. |
| https://kanbanguides.org/the-kanban-guide/2025.5/ | Supports visualizing workflow, actively managing WIP, and improving process. This argues for explicit queue states and WIP limit of one implementation feature. |
| https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/welcome.html | Supports recording branch/lane, security, and architecture decisions with context and rationale to avoid repeated debate. |

Deepened conclusions:

1. The first implementation slice should not be "watch all files and reindex immediately." Evidence points to a safer registry/staleness/sweep/queue design with dry-run and clear operation records.
2. A batch or sweep model is source-backed by issue #253 and safer for Podman/Windows than relying on file events.
3. Chokidar can help later, but watcher events should be treated as acceleration only; correctness should come from commit/staleness detection and periodic sweep.
4. Code Wiki auto-update depends on Auto-Reindexing and should not auto-call LLMs until provider, budget, language, and publication policy are explicit.
5. PR Review / Blast Radius can start as a local report generated from `detect_changes`, `impact`, and `api_impact`; GitHub posting/check automation is a later security-sensitive slice.
6. Multi-repo improvements are not greenfield; current group/contract/bridge code already exists, so the research should name a concrete gap before planning new work.
7. OCaml is feasible but high-blast-radius because language support must pass provider, parser, query, import, type/member, scope-resolution, and fixture tests.
8. Auto regression forensics and E2E test generation still lack concrete public/local implementation evidence; keep them as defer/light-scoping candidates until their intended user workflows are defined.

### 2026-06-05T10:35:01+01:00 - GitNexus-Assisted Local Index Check

Commands run:

```powershell
gitnexus status
gitnexus list
gitnexus query "ReindexWatcherScheduler reindex queue dryRun sweep" --limit 8
gitnexus query --repo gitnexus-local-features "ReindexWatcherScheduler reindex queue dryRun sweep" --limit 5
gitnexus query --repo gitnexus-local-features "wiki incremental fromCommit currentCommit up-to-date" --limit 5
gitnexus query --repo gitnexus-local-features "detect_changes impact api_impact pull request blast radius" --limit 5
gitnexus query --repo gitnexus-local-features "group sync contracts bridge cross impact workspace extractor" --limit 5
gitnexus query --repo gitnexus-local-features "OCaml SupportedLanguages tree-sitter language provider scope resolver" --limit 5
```

Observed GitNexus route facts:

- `gitnexus status` reports `gitnexus-local-features` is indexed and up to date at commit `b5ce5ab`.
- `gitnexus list` reports 23 indexed repositories.
- Bare `gitnexus query ...` without `--repo` fails because multiple repositories are indexed.
- Future graph-assisted checks must include `--repo gitnexus-local-features`.
- Query logs show vector extension fallback to exact scan on this platform; graph-assisted results remain useful, but timing/output should be interpreted with that caveat.

Graph-assisted findings:

| Query theme | GitNexus surfaced | Research interpretation |
| --- | --- | --- |
| Auto-reindexing | `gitnexus/src/server/reindex-watcher.ts`, `ReindexWatcherScheduler`, `readReindexWatcherConfigFromEnv`, `startReindexJob`, `reindex-operations.ts`, `reindex-api-wiring.test.ts`, `reindex-follow-up.test.ts`, `reindex-freshness-wiring.test.ts` | Confirms a real local reindex control plane and tests. Still does not prove scheduler startup wiring. |
| Code Wiki | `WikiGenerator.run`, `gitnexus/src/core/wiki/generator.ts`, `gitnexus/src/cli/wiki.ts`, wiki DB helpers, `wiki-flags.test.ts` | Confirms mature manual/incremental wiki generation surface. |
| PR review / blast radius | `detect_changes`, `impact`, `api_impact`, `gitnexus-pr-review` skill files, MCP server next-step hints, eval-server impact formatting | Confirms impact/report primitives and review-process skills, but not a finished automated PR review product. |
| Multi-repo | `registerGroupCommands`, `GroupService`, `parseGroupConfig`, `cross-impact.ts`, `ManifestExtractor`, `writeBridge`, group resources | Confirms group/contract/bridge architecture is a substantial existing subsystem. |
| OCaml/language support | Parser loader, `isLanguageAvailable`, `resolveLanguageKey`, scope-resolution phase, parse worker, `LanguageProvider`/tree-sitter-related paths | Confirms the language-onboarding path is multi-layered. OCaml absence remains a negative finding from source search. |

Immediate process rule from this check:

- Any future local GitNexus command used in this work should use explicit repo routing:
  - `gitnexus ... --repo gitnexus-local-features` for host/npm query/context/impact-style commands when multiple host repositories are indexed.
  - `gitnexus status` is safe from the repo root for the host/npm route.
  - `gitnexus-podman ...` is the Podman/container route and should be used only for Podman-mounted repositories.

### 2026-06-05T10:37:26+01:00 - Local History And Deferred-Feature Evidence Pass

Commands run:

```powershell
git log --all --date=short --pretty=format:'%h %ad %s' --grep='regression' --grep='forensic' --grep='test generation' --grep='e2e' --grep='wiki' --grep='reindex' --grep='group' --grep='OCaml' --grep='language support' --grep='PR review' --grep='blast' -i -n 120
rg -n "auto regression|regression forensics|forensics|end-to-end test generation|test generation|generate.*test|swe-bench|trajectory|resolve rate|benchmark|eval|PR Review|blast radius|Code Wiki|auto-updating|auto-reindex|OCaml|multi-repo|unified graph" README.md CHANGELOG.md gitnexus/CHANGELOG.md CONTRIBUTING.md GUARDRAILS.md RUNBOOK.md eval gitnexus/src gitnexus/test -g "*.md" -g "*.ts" -g "*.py"
```

Additional local history findings:

| Area | Evidence from local history/search | Interpretation |
| --- | --- | --- |
| Auto-reindexing | `local: add constrained reindex control plane` appears repeatedly in local branch history; `gitnexus/CHANGELOG.md` documents notification-only hooks in #1070. | Current local branch has reindex-control work, but upstream public history warns away from hook-based automatic analyze. |
| PR review / blast radius | `feat(review): add PR reviewer swarm agents (#1851)`, impact pagination, per-symbol processes in impact results, PR autofix/fork-safe workflow commits. | There is serious adjacent PR-review/reporting/process work. First product slice should still be local report over stable primitives. |
| Code Wiki | Multiple wiki hardening commits: local Claude/Codex providers, timeout/retry handling, language flag, Mermaid sanitization, budget-aware grouping. | Wiki is mature enough that auto-update should orchestrate existing generator and policies, not rebuild it. |
| Multi-repo/group | Many recent group commits: HTTP/gRPC/OpenFeign/Kotlin/Node/Python/Rust/C++ include extractors, bridge/tempfile hardening, Windows EPERM handling. | Multi-repo support is active and broad. "Improvements" need a specific missing behavior to avoid duplicating mature code. |
| Regression forensics | Many regression tests, tripwires, pipeline benchmarks, and eval harness references; no product command named auto-regression-forensics found. | Keep as deferred until it has a user workflow and report contract. |
| E2E test generation | E2E tests exist, and `eval/` has SWE-bench workflows; no generator command or product surface found. | Keep deferred. Could later draw on process traces + PR report schema. |
| OCaml support | No OCaml local code surfaced; language analogue PRs show large acceptance burden. | Separate language-onboarding lane later. |

External adjacent references checked for deferred features:

| Source | Usefulness | Limitation |
| --- | --- | --- |
| https://github.com/konveyor/tackle-test-generator-cli | Reference example for automated unit/UI test generation with Java, Selenium, Crawljax, and coverage goals. | Different project/domain; useful only for future E2E-test-generation methodology, not GitNexus implementation evidence. |
| https://github.com/parsaalian/autoe2e | Reference example for feature-driven E2E test generation research/code. | Not GitNexus-specific; should not drive implementation before local workflow is defined. |
| https://github.com/NousResearch/hermes-agent/issues/486 | Code-wiki design discussion with auto-update/incremental questions, LLM cost/output concerns, hosting questions. | Secondary/comparative evidence only. It reinforces questions we already need to answer for GitNexus wiki auto-refresh. |
| https://github.com/repowise-dev/repowise | Comparative code-intelligence project describing stale wiki notification after commit. | Not GitNexus source; useful only as a parallel pattern that notification/schedule can be safer than hidden mutation. |

Rigor review after broader pass:

- Evidence relevance: strong for Auto-Reindexing, Code Wiki, PR Review primitives, and Multi-Repo existing surface.
- Evidence relevance: weak for Auto Regression Forensics and E2E Test Generation as immediate build targets.
- Falsifiability: the first Auto-Reindexing slice can be tested with stale/fresh registry fixtures, dry-run behavior, queue dispatch, and operation trigger visibility.
- Scope calibration: do not call the project "Enterprise"; call these independent local OSS-style capabilities inspired by public positioning.
- Exploration integrity: preserve negative evidence. The lack of product surfaces for regression forensics and E2E generation is a finding, not a failure.
- Methodological rigor: one shared branch is acceptable only with a WIP limit of one feature slice, focused tests, and canonical checkpoint updates after each slice.

Current feature dependency graph:

```text
Auto-Reindexing
  -> PR Review / Blast Radius
  -> Auto-Updating Code Wiki
  -> Multi-Repo status/sync freshness hardening

PR Review / Blast Radius
  -> Auto Regression Forensics
  -> End-to-End Test Generation

Multi-Repo Support Improvements
  -> PR Review / Blast Radius, if group-aware PR reports are later approved

OCaml Support
  -> mostly independent, but increases parser/provider/test blast radius
```

Current sequencing recommendation:

1. Snapshot current planning/research artifacts.
2. Draft a decision-complete Auto-Reindexing implementation plan.
3. Request `MAIN | READY_FOR_IMPLEMENTATION` for that first slice only.
4. Implement and verify Auto-Reindexing before starting another feature.
5. Plan PR Review / Blast Radius as a local Markdown/JSON report.
6. Plan Auto-Updating Code Wiki after freshness and LLM policy are explicit.
7. Reassess Multi-Repo improvements only after concrete group/report/wiki gaps are known.
8. Keep Regression Forensics, E2E Test Generation, and OCaml deferred.

One-branch working rule:

- Use `local/gitnexus-local-features`.
- Do not create per-feature branches.
- Do not run multiple implementation features in parallel on the same branch.
- Use small commits or explicit snapshots so the shared branch does not become discombobulated.

### 2026-06-05T10:39:32+01:00 - Coordinated Research Tranche, Block 1-2 Deepening

User request:

- Dedicate a 60-90 minute research pass.
- Track time objectively.
- Use the active scratchpad.
- Research in coordinated blocks across the feature set.

Objective time markers:

```powershell
Get-Date -Format o
# 2026-06-05T10:39:32.0861881+01:00

Get-Date -Format o
# 2026-06-05T10:40:11.2470025+01:00

Get-Date -Format o
# 2026-06-05T10:41:58.2308028+01:00

Get-Date -Format o
# 2026-06-05T10:42:18.1492525+01:00
```

Methods/skills used:

- `autoresearch`: used as a coordinated research loop and evidence-capture discipline, not as a separate workspace.
- `superpowers:using-superpowers`: used to confirm skill-first process discipline.
- `superpowers:writing-plans`: used for decomposition discipline and "plan before implementation" shape; no implementation plan is authorized yet.
- Current long-horizon bundle: retained as canonical state; scratchpad remains working evidence only.

Block structure:

| Block | Purpose | Evidence class |
| --- | --- | --- |
| Block 1 | Local source and graph ownership map | `rg`, direct file reads, host `gitnexus query --repo gitnexus-local-features` |
| Block 2 | Public/reference evidence | GitHub PRs/issues, official docs, Context7-style documentation targets, public product-positioning pages |
| Block 3 | Methodology and sequencing synthesis | DORA, OpenAI Codex planning guidance, GitHub Actions security docs, local risk/dependency map |
| Block 4 | Durable promotion | Update `plans.md` and `documentation.md` only with stable conclusions |

Commands run in this tranche:

```powershell
git status --short --branch
Get-Content C:\Users\steve\.codex\skills\0-autoresearch-skill\SKILL.md -TotalCount 220
Get-Content C:\Users\steve\.codex\plugins\cache\openai-curated\superpowers\e2d08a2e\skills\using-superpowers\SKILL.md -TotalCount 220
Get-Content C:\Users\steve\.codex\plugins\cache\openai-curated\superpowers\e2d08a2e\skills\writing-plans\SKILL.md -TotalCount 260
rg -n "PR reviewer|pr review|blast radius|detect_changes|api_impact|pull request|review report|risk report|swarm" gitnexus .github pr-swarm-review eval -g "*.md" -g "*.ts" -g "*.yml" -g "*.yaml"
rg -n "wiki|WikiGenerator|incremental|fromCommit|currentCommit|provider|timeout|review mode|outDir|pages generated|metadata" gitnexus/src gitnexus/test README.md gitnexus/CHANGELOG.md -g "*.md" -g "*.ts"
rg -n "group_status|group sync|group_query|group_contracts|Contract Bridge|cross-impact|ManifestExtractor|workspace|unified graph|multi-repo|multi repo" gitnexus/src gitnexus/test README.md ARCHITECTURE.md gitnexus/CHANGELOG.md -g "*.md" -g "*.ts"
rg -n "regression forensics|auto regression|forensic|failure analysis|root cause|test generation|generate.*test|e2e generator|SWE-bench|eval harness|trajectory" gitnexus eval README.md gitnexus/CHANGELOG.md -g "*.md" -g "*.ts" -g "*.py" -g "*.yml"
rg -n "OCaml|ocaml|SupportedLanguage|SupportedLanguages|LANGUAGE_CONFIGS|LanguageProvider|tree-sitter|scope resolver|extensions" gitnexus-shared gitnexus/src gitnexus/test gitnexus/package.json -g "*.ts" -g "*.json" -g "*.md"
gitnexus query --repo gitnexus-local-features "group_query group_status group_contracts removed tools resources gitnexus://group status contracts" --limit 8
gitnexus query --repo gitnexus-local-features "PR swarm review read-only personas blast radius detect_changes api_impact GitHub Actions fork-safe" --limit 8
gitnexus query --repo gitnexus-local-features "wiki generator incremental commit metadata provider timeout retries auto update after reindex" --limit 8
gitnexus query --repo gitnexus-local-features "SWE-bench eval-server regression forensics test generation agent resolve rate" --limit 8
gitnexus query --repo gitnexus-local-features "OCaml language provider SupportedLanguages tree-sitter grammar provider registry scope resolver" --limit 8
```

Important local-file reads:

| File | Why read | Finding |
| --- | --- | --- |
| `pr-swarm-review/README.md` | Determine whether PR review is already a product feature or a review method. | It is a coordinated, read-only production-readiness PR review process shared across CLIs; it is manually invoked and does not edit, commit, or post. |
| `pr-swarm-review/orchestration.md` | Understand output contract and lane structure. | The contract is seven review lanes with facts first, synthesis last, exact classifications, hidden Unicode checks, and read-only behavior. |
| `gitnexus/skills/gitnexus-pr-review.md` | Compare existing single-agent PR review skill. | It already describes a report workflow over `detect_changes`, `impact`, `context`, and tests coverage signals. Stale command guidance inside this repo-local skill is not the Codex-facing global source of truth. |
| `gitnexus/src/mcp/server.ts` | Identify MCP prompts and workflow guidance. | `detect_impact` already produces a guided impact/risk report prompt; `generate_map` produces architecture docs. |
| `ARCHITECTURE.md` | Resolve multi-repo tool/resource surface. | Current architecture says `query`, `context`, and `impact` are group-aware and group status/contracts are resources. It explicitly says the previously planned `group_query`, `group_context`, `group_impact`, `group_contracts`, and `group_status` MCP tools are intentionally not introduced. |
| `eval/README.md` | Bound regression forensics and E2E generation. | Eval harness measures whether GitNexus improves SWE-bench-style agent performance; it is not a product-level regression-forensics or test-generator feature. |

New alignment / misalignment finding:

| Area | Alignment | Misalignment |
| --- | --- | --- |
| MCP/tools count and group surface | The current source and architecture support multi-repo/group work through registry, `@<group>` routing, Contract Bridge, resources, and CLI group commands. | Some README/positioning material still names group-style tools such as `group_query`, `group_contracts`, and `group_status`, but `ARCHITECTURE.md` says those tools were intentionally not introduced and group status/contracts live as resources. Future planning must target the actual current surface, not stale tables. |
| PR review | Existing skills and PR swarm review strongly align with blast-radius review as an important workflow. | The existing PR swarm is read-only and manually invoked. It is not an automated GitHub PR review service. A product feature should start as a local Markdown/JSON report before any GitHub posting. |
| Auto-reindexing | Public GitNexus docs and third-party reviews agree that stale indexes are a real workflow issue. | Hook-driven auto-analyze was tried historically and later guidance moved toward notification/manual refresh; user also forbids hooks. Correctness should be sweep/queue based. |
| Code Wiki | The wiki generator and CLI are mature; public positioning values fresh graph-backed docs. | Auto-updating wiki is not proven as wired runtime behavior; unattended LLM execution requires provider, cost, language, and publication policy. |
| Regression forensics / E2E test generation | Eval harness and graph/impact data could support future ideas. | No current product command, report schema, or user workflow was found locally. Keep deferred. |
| OCaml support | `tree-sitter-ocaml` exists publicly, so parser feasibility is plausible. | Local support is absent, and language-onboarding evidence shows a full provider/parser/query/resolver/fixture/parity-test project. |

Public/reference sources checked and what they changed:

| Source | Date/status observed | What it contributes | Planning consequence |
| --- | --- | --- | --- |
| GitNexus PR #205: https://github.com/abhigyanpatwari/GitNexus/pull/205 | Merged 2026-03-07 | Historical hook-based auto-reindex attempted synchronous `gitnexus analyze` after commit/merge and preserved embeddings. | Useful problem statement, but not the route to implement because hooks/synchronous analyze have safety issues and user forbids hooks. |
| GitNexus PR #1070: https://github.com/abhigyanpatwari/GitNexus/pull/1070 | Merged later than #205 | Clarified PostToolUse behavior as notification-only rather than auto-reindex. | Reinforces stop rule against hidden hook-driven auto-analyze. |
| GitNexus issue #253: https://github.com/abhigyanpatwari/GitNexus/issues/253 | Open, 2026-03-11 | Requests `analyze --all`, registry enumeration, skipping missing paths, preserving flags, and printing a summary. | Strong support for registry-driven sweep/batch thinking in Auto-Reindexing. |
| GitNexus issue #1400: https://github.com/abhigyanpatwari/GitNexus/issues/1400 | Closed Windows report | Analyze could create files while repo remained unindexed. | Auto-Reindexing must verify registry visibility and operation failure states, not only child process completion. |
| GitNexus PR #1446: https://github.com/abhigyanpatwari/GitNexus/pull/1446 | Merged 2026-05-09 | Fork-safe PR automation used a split workflow so privileged posting does not run fork-controlled code. | Future PR Review automation must preserve trust separation; local report-first avoids this initially. |
| GitNexus PR #1851: https://github.com/abhigyanpatwari/GitNexus/pull/1851 | Merged 2026-05-29 | Adds PR reviewer swarm agents, read-only lanes, exact classifications, and evidence requirements. | Existing PR-review method is mature enough to inform report schema, but not a substitute for runtime automation. |
| GitNexus README: https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md | Opened 2026-06-05 | Documents `analyze`, `wiki`, `serve`, `status`, registry/index model, and multi-repo CLI/MCP surfaces. | Public expected behavior supports stale-index, wiki, and multi-repo value; exact current local source still decides implementation. |
| GitNexus RUNBOOK: https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md | Opened 2026-06-05 | Stale-index remediation remains manual `analyze` / `status` / `list` in official runbook. | Auto-Reindexing is a real gap, not already solved by official runbook. |
| GitNexus AGENTS: https://github.com/abhigyanpatwari/GitNexus/blob/main/AGENTS.md | Opened 2026-06-05 | Confirms PR swarm review as canonical read-only CLI-neutral method and logs group-resource migration. | Aligns with local source: report method exists; group tool tables may be stale. |
| Node.js fs docs: https://nodejs.org/api/fs.html | Node v26 docs opened 2026-06-05 | `fs.watch` can be unreliable or impossible on network filesystems and host filesystems under Docker/Vagrant; polling exists but is slower/less reliable. | File watching must not be the correctness mechanism for Auto-Reindexing, especially on Windows/Podman. |
| GitHub Actions workflow docs: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows | Opened 2026-06-05 | `pull_request_target` and `workflow_run` with untrusted code have security warnings; artifacts can feed later workflows. | PR Review GitHub posting must be a later, security-designed slice. |
| GitHub Actions secure-use docs: https://docs.github.com/en/enterprise-server@3.16/actions/reference/security/secure-use | Opened 2026-06-05 | Advises avoiding privileged triggers when unnecessary and not checking out untrusted code in privileged contexts. | Local report-first PR review is the safe first slice; posting/comment automation needs explicit approval and threat model. |
| DORA small batches: https://dora.dev/capabilities/working-in-small-batches/ | Opened 2026-06-05 | Small batches reduce feedback time and are especially important with AI-generated code. | Supports one shared branch with WIP limit of one feature slice and focused tests. |
| DORA trunk-based development: https://dora.dev/capabilities/trunk-based-development/ | Opened 2026-06-05 | Branch health depends on small batches, green tests, and avoiding long integration phases. | Supports no per-feature branch sprawl; use the shared branch carefully with small verified slices. |
| OpenAI Codex ExecPlans: https://developers.openai.com/cookbook/articles/codex_exec_plans | Opened 2026-06-05 | Long-running Codex work benefits from living plan docs, explicit assumptions, milestones, validation, and retrospective updates. | Confirms four-file long-horizon bundle and plan-before-implementation discipline. |

Feature-by-feature result after this tranche:

| Feature | Current local disposition | Research depth after tranche | Next research/plan action |
| --- | --- | --- | --- |
| Auto-Reindexing | `now` | Decision-grade enough to draft an implementation plan, but not enough to edit source without MAIN approval. | Draft plan for an opt-in server-side freshness sweep using registry validation, staleness checks, queue dispatch, operation visibility, and dry-run default. |
| PR Review / Blast Radius | `next` | Medium evidence strengthened. Existing read-only review/swarm and MCP primitives provide an excellent report schema seed. | Plan a local report command/workflow first; defer GitHub posting. |
| Auto-Updating Code Wiki | `next` | Medium evidence strengthened. Existing wiki generator is mature, but auto-trigger policy is missing. | Plan only after Auto-Reindexing freshness and LLM/provider/cost/publication policy are explicit. |
| Multi-Repo Support Improvements | `defer` | Light/medium evidence changed the question: current group support is already substantial, but docs/surfaces drift. | First improvement may be documentation/surface reconciliation or group-status ergonomics, not unified graph. |
| Auto Regression Forensics | `defer` | Light evidence only. Eval harness exists, product workflow absent. | Wait for PR report schema and CI/failure evidence model. |
| End-to-End Test Generation | `defer` | Light evidence only. E2E tests/eval infrastructure exists, generator workflow absent. | Wait for PR risk model and explicit test-framework target. |
| OCaml Support | `defer` | Light evidence, high implementation burden. Parser package exists; local provider absent. | Treat as a standalone language-support project if later approved. |

Current consolidated sequencing:

1. Finish research documentation and snapshot planning artifacts.
2. Draft decision-complete Auto-Reindexing implementation plan.
3. Ask MAIN for `READY_FOR_IMPLEMENTATION` on Auto-Reindexing only.
4. Implement Auto-Reindexing in the smallest safe opt-in slice.
5. Validate, document, and snapshot the slice before moving on.
6. Plan PR Review / Blast Radius as local Markdown/JSON report.
7. Plan Auto-Updating Code Wiki only after freshness and LLM policy.
8. Reassess multi-repo docs/surface drift before any "improvement" code.
9. Keep regression forensics, E2E generation, and OCaml deferred until their intended workflows are concrete.

Research-time caveat:

- This continuation tranche began at `2026-06-05T10:39:32+01:00`. The whole thread contains earlier research on the same morning, but this checkpoint does not honestly represent a completed 60-90 minute wall-clock research block by itself. Continue objective time tracking if the user wants the full requested wall-clock duration before implementation planning.

### 2026-06-05T10:46:33+01:00 - Block 2B: External Analogues And Deferred-Feature Boundaries

Objective:

- Fan out beyond GitNexus-specific public sources to understand adjacent implementation patterns.
- Keep external products/research clearly subordinate to GitNexus source evidence.
- Check whether the deferred features have enough outside reference shape to refine their later research questions.

Objective time marker:

```powershell
Get-Date -Format o
# 2026-06-05T10:46:33.9744345+01:00
```

Web searches:

```text
open source code wiki generator auto update on git commit repository knowledge graph documentation incremental
open source automated pull request blast radius analysis code review impact analysis GitHub action
open source regression forensics automated root cause analysis CI failures code changes
open source AI end to end test generation from code changes pull request
site:github.com automatic code wiki incremental update repository documentation open source codewiki repowise
site:github.com "blast radius" "pull request" "GitHub Action" code review open source
site:github.com "regression" "root cause" "git bisect" "CI" "GitHub Action" open source
site:github.com "Playwright" "generate tests" "pull request" "AI" open source
git bisect official documentation find commit that introduced regression
CI failure root cause analysis regression bisection open source tool GitHub
github actions bisect regression find bad commit action
software regression root cause analysis git bisect automated research
```

External analogue matrix:

| Source | Feature area | Evidence contribution | Limit / caution for GitNexus |
| --- | --- | --- | --- |
| CodeWiki: https://github.com/FSoft-AI4Code/CodeWiki | Auto-Updating Code Wiki | Open-source repo-level documentation tool with `codewiki generate --update`, hierarchical decomposition, architecture diagrams, and multi-language support. | Useful as a pattern for incremental regeneration and output controls, but GitNexus already has its own graph/wiki generator. Do not import its architecture wholesale. |
| repowise auto-wiki docs: https://docs.repowise.dev/docs/intelligence/auto-wiki | Auto-Updating Code Wiki / Auto-Reindexing dependency | Describes per-file/module/symbol pages, source citations, confidence/freshness status, changed-file propagation, and cascade budgets. | Strong conceptual analogue: freshness/confidence/cascade caps are useful planning terms, but implementation must reuse GitNexus wiki metadata and graph primitives. |
| RepoDoc paper: https://arxiv.org/abs/2604.26523 | Auto-Updating Code Wiki | Research supports knowledge-graph-backed documentation, modular cross-references, Mermaid diagrams, and selective incremental regeneration. | Confirms direction, not code. Treat as methodology/evaluation evidence only. |
| DeepWiki Open: https://github.com/AsyncFuncAI/deepwiki-open | Code Wiki | Open-source AI wiki generator that analyzes code, generates docs, diagrams, and navigable wiki structure. | Useful market/reference context; not directly aligned to GitNexus's local graph and incremental wiki implementation. |
| Blast Radius concept page: https://blast-radius.dev/ | PR Review / Blast Radius / Multi-repo impact | Describes PR diff parsing, API/schema/contract change detection, affected services, and PR comment summary. Project states it is no longer active, but the problem exists. | Validates the shape of a PR impact report, but not priority or implementation viability. Report-first remains safer than automation-first. |
| Kind: https://www.kindagent.dev/ | End-to-End Test Generation | Reads PR diff, generates scenarios, runs app in ephemeral sandbox, uses Playwright, posts PR results. | Commercial SaaS pattern; implies GitHub app, sandbox, preview URL, secrets, and browser infra. Too large for early GitNexus local feature scope. |
| TestNeo: https://testneo.ai/ | E2E generation / release assurance | Frames change-aware verification as impact analysis, verification generation, execution, and release signal. | Commercial product; useful workflow taxonomy only. Requires stronger runtime/test framework scope than GitNexus currently has. |
| Sartor: https://getsartor.com/ | Test generation | Generates tests from commits, opens test PRs, uses coverage-gap mapping and policy guardrails. | Commercial product; reinforces that test generation is its own feature family with GitHub/CI integration, not a small add-on. |
| EvalView GitHub Action: https://github.com/marketplace/actions/evalview-ai-agent-testing | Regression/eval gating | Provides regression gate, deterministic quick mode, optional LLM judge, and autonomous loop guard/revert pattern. | Adjacent to agent evals, not GitNexus product behavior. Useful for future "regression forensics" vocabulary: gate, diff, regression, tool changes. |
| Git bisect docs: https://git-scm.com/docs/git-bisect/2.43.2 | Auto Regression Forensics | Official Git docs define binary search to find the commit that introduced a bug; supports custom terms and performance regression use cases. | A future GitNexus forensics feature should likely combine `git bisect`-style narrowing with graph impact evidence, but this is not currently local product surface. |
| Empirical Software Engineering article: https://link.springer.com/article/10.1007/s10664-024-10479-z | Auto Regression Forensics | Research discusses automated approaches using regression tests, bisection limits, history graph structure, and test transplantation challenges. | Confirms that automated forensics is hard and test-dependent. Keep deferred until a failing-test/CI evidence model exists. |
| PyRCA: https://github.com/salesforce/PyRCA | Root cause analysis | RCA library for metric/time-series/causal graph root causes in microservice systems. | Not directly code-change regression forensics; useful only if future scope expands to runtime telemetry. |

Refined deferred-feature questions:

| Feature | Later research question | Why not now |
| --- | --- | --- |
| Auto-Updating Code Wiki | Should GitNexus page metadata include freshness/confidence/cascade-budget concepts, or can existing commit metadata and wiki summary be enough for the first auto-refresh slice? | Needs Auto-Reindexing freshness and LLM policy first. |
| PR Review / Blast Radius | What exact report schema should be stable before any PR-comment integration: changed symbols, affected processes, API shape drift, tests touched, d=1 callers outside diff, risk level, evidence links? | Can be planned after freshness; GitHub automation needs separate threat model. |
| Multi-Repo Support Improvements | Is the main gap docs/surface drift, group status ergonomics, contract freshness, or true cross-repo impact depth? | Existing group support is already substantial; "multi-repo improvement" is too broad without a named gap. |
| Auto Regression Forensics | What input is required: failing test name, CI log, known-good commit, known-bad commit, flaky confidence, or PR diff? | No current product surface; bisection/test-transplant research shows high complexity. |
| End-to-End Test Generation | Is the intended output executable Playwright tests, one-off browser run reports, generated test PRs, or risk-based test suggestions? | Requires app launch/sandbox/preview/secrets design and readable generated test policy. |
| OCaml Support | Which OCaml grammar(s) are needed: `.ml`, `.mli`, `dune`, module aliases, functors, type/member/call resolution? | Language support is full provider onboarding, not just parser package installation. |

Planning impact:

1. Code Wiki is more plausible as feature 3 after Auto-Reindexing because outside analogues strongly support incremental graph-backed docs, freshness metadata, and cascade limits.
2. Regression forensics and E2E test generation are not "small enterprise features"; each is a separate platform-style feature that needs a crisp user workflow, safety model, and verification corpus.
3. PR Review / Blast Radius remains the right second candidate because it can reuse GitNexus's existing graph primitives and manual PR review assets without needing sandboxed execution or generated code.
4. Multi-repo improvements should probably begin with a docs/API-surface reconciliation issue, because stale group-tool tables are already a concrete observed gap.

### 2026-06-05T10:49:52+01:00 - Coordinated Block A-C Continuation: Method, Intent, And Local Shape

User request:

- Dedicate a 60-90 minute research tranche.
- Track objective time.
- Use this scratchpad.
- Research in coordinated blocks rather than isolated one-off searches.

Objective time markers:

```powershell
Get-Date -Format o
# 2026-06-05T10:49:52.2376303+01:00

Get-Date -Format o
# 2026-06-05T10:50:04.8063243+01:00

Get-Date -Format o
# 2026-06-05T10:50:53.6905795+01:00

Get-Date -Format o
# 2026-06-05T10:52:24.2300296+01:00
```

Skills / process guidance used:

- `autoresearch`: used as the two-loop discipline: source discovery, evidence capture, synthesis, and promotion to durable docs.
- `superpowers:using-superpowers`: used to re-check skill-first discipline for this work.
- Context7: used for Node.js `fs.watch` documentation because Auto-Reindexing correctness depends on current Node filesystem behavior.

Block A - methodology and long-horizon execution:

| Source | Evidence | Planning impact |
| --- | --- | --- |
| DORA working in small batches: https://dora.dev/capabilities/working-in-small-batches/ | Small batches shorten feedback loops, are especially important with AI-assisted code, should be independently testable, and should avoid huge generated changes. | Supports one shared branch only if feature work is sliced into independently testable increments and not batched into one large PR-like change. |
| DORA trunk-based development: https://dora.dev/capabilities/trunk-based-development/ | Trunk-based work relies on small batches, frequent integration, green tests, and avoiding long integration phases. | Our local equivalent is one shared branch, one active implementation feature, focused tests before moving to the next feature, and no branch pile-up. |
| Trunk Based Development short-lived feature branch guidance: https://trunkbaseddevelopment.com/short-lived-feature-branches/ | Long-lived feature branches increase integration risk; short-lived task/topic branches are different from long-running shared feature branches. | Because MAIN chose one branch for all local features, the compensating controls must be explicit snapshots, WIP limit one, and completion gates per feature slice. |
| OpenAI Codex ExecPlans: https://developers.openai.com/cookbook/articles/codex_exec_plans | Long-running Codex work benefits from living plans, durable assumptions, milestones, validation checkpoints, and retrospective updates. | Confirms the four-file bundle as the control surface and reinforces that implementation needs a decision-complete plan first. |

Method conclusion:

- The project should not use "one feature per branch" for this workstream because MAIN has selected one shared branch.
- The project also should not allow "one shared branch" to become "all features mixed together."
- The correct operating model is one shared branch with a hard WIP limit of one implementation feature, plus small verified slices and durable checkpoints.

Block B - public feature intent and external constraints:

| Feature | Public / external evidence | Intended local interpretation |
| --- | --- | --- |
| Auto-Reindexing | GitNexus issue #253 requests `analyze --all`; issue #1400 shows Windows/registry visibility failures; PR #205 tried hook-based refresh; PR #1070 later moved hook behavior toward notification-only. | Intended function is to keep registered repo indexes fresh without hidden hooks. First local shape should be opt-in server-side freshness sweep, registry validation, staleness check, queue dispatch, and operation visibility. |
| Auto-Updating Code Wiki | GitNexus README documents `gitnexus wiki` options; issue #302 says generated docs could feed a docs site; CodeWiki/RepoDoc/repowise analogues support incremental graph-backed docs with freshness/confidence concepts. | Intended function is to refresh existing graph-backed wiki output after graph freshness, not to invent a new docs generator. Needs LLM provider/cost/publication policy before unattended execution. |
| PR Review / Blast Radius | GitNexus PR swarm review docs are read-only and evidence-grounded; GitHub Actions secure-use docs warn against privileged untrusted PR workflows; GitNexus PR #1446 used fork-safe split workflow patterns. | Intended first local function is a Markdown/JSON risk report over existing graph primitives. GitHub PR comments/checks are a later security-designed slice. |
| Auto Regression Forensics | Git docs define `git bisect run`; regression RCA papers/tools show bisection and failure evidence are test-dependent. | Intended future function needs a failing-test/CI evidence model before product design. Keep deferred. |
| End-to-End Test Generation | Commercial tools such as Kind/TestNeo/Sartor show PR-diff-driven Playwright/test generation requires sandbox, preview URL, secrets, policy, and CI integration. | Intended future function is too broad without a named test framework and execution environment. Keep deferred. |
| Multi-Repo Support Improvements | Current local `ARCHITECTURE.md` says `query`, `context`, and `impact` are group-aware and group status/contracts are resources; README-style tables still show group tools. | Intended near-term work is likely docs/surface reconciliation or group-status ergonomics, not a new unified graph project. |
| OCaml Support | Tree-sitter has an OCaml grammar, but local GitNexus language registry has no OCaml provider. | Intended future function is a full language-provider onboarding project with parser, queries, resolver behavior, fixtures, and tests. Keep deferred. |

Block C - local implementation/dependency shape:

Commands run:

```powershell
rg -n "class ReindexWatcherScheduler|startReindexJob|ReindexQueue|ReindexTrigger|checkStalenessAsync|listRegisteredRepos|WikiGenerator|incremental|detect_changes|api_impact|group_status|group_query|OCaml|ocaml|SWE-bench|generate.*test" gitnexus gitnexus-shared eval pr-swarm-review ARCHITECTURE.md README.md -g "*.ts" -g "*.md" -g "*.json" -g "*.yml" -g "*.yaml"
gitnexus query --repo gitnexus-local-features "reindex watcher scheduler queue startReindexJob staleness registry dry run auto reindex tests" --limit 10
gitnexus query --repo gitnexus-local-features "wiki generator incremental metadata provider timeout retries stale commit update after reindex tests" --limit 10
```

Important local reads:

| File | Why it matters |
| --- | --- |
| `gitnexus/src/server/reindex-watcher.ts` | Already has `ReindexWatcherScheduler`, env parsing, dry-run default, debounce, ignored paths, mark-all-dirty, sweep/manual/watch reasons, and injectable `requestReindex`. |
| `gitnexus/src/server/reindex-control.ts` | Already has `ReindexQueue`, same-repo coalescing, different-repo rejection while active, and graph-read blocking only during pending-rerun overlap. |
| `gitnexus/src/server/reindex-operations.ts` | Operation ledger exists but trigger union is currently only `direct` and `pending-rerun`; auto-reindex should not be hidden as `direct`. |
| `gitnexus/src/server/api.ts` | `startReindexJob` exists as an internal closure; first plan must define whether/how to create a server-local helper boundary rather than calling HTTP from inside the server. |
| `gitnexus/src/core/wiki/generator.ts` | Existing wiki generator already supports full, incremental, and up-to-date modes plus metadata and LLM routing. |
| `pr-swarm-review/README.md` and `pr-swarm-review/orchestration.md` | PR review assets are mature but explicitly read-only and manually invoked. |
| `ARCHITECTURE.md` | Source truth for current multi-repo surface and group resource model. |
| `eval/README.md` | Eval harness measures GitNexus impact on SWE-bench-style agent performance; it is not a product regression-forensics or E2E-generation feature. |

Context7 / official Node result:

- Context7 `/nodejs/node` confirms `fs.watch` is not fully consistent across platforms.
- It may be unreliable or impossible on network filesystems and host filesystems under virtualization such as Docker.
- `fs.watchFile()` uses stat polling, but is slower and less reliable.
- Planning consequence: Auto-Reindexing correctness must come from commit staleness sweeps and registry validation, not native watcher events.

Coordinated conclusion:

1. Auto-Reindexing remains the only feature ready for decision-complete implementation planning.
2. PR Review / Blast Radius and Auto-Updating Code Wiki have enough evidence for next-phase planning, but they should not be implemented before the freshness foundation.
3. Multi-Repo Support Improvements should be reframed as a current-surface reconciliation task unless MAIN later names a concrete cross-repo behavior gap.
4. Auto Regression Forensics, End-to-End Test Generation, and OCaml are too broad for near-term implementation and should remain research-only.
5. One shared branch is acceptable only with strong discipline: one active feature, small testable slices, frequent documentation checkpoints, and no hidden source edits before MAIN approval.

Research-time caveat:

- This continuation block adds a structured research pass but still does not honestly equal a full 60-90 minutes of wall-clock work by itself. The scratchpad records exact timestamps so future agents do not inflate the time claim.

### 2026-06-05T10:55:38+01:00 - GitHub PR/Issue Evidence Deepening

Objective:

- Inspect GitNexus PR/issue evidence directly enough to distinguish intended Enterprise behavior from OSS behavior and avoid building from stale positioning text alone.

Objective time marker:

```powershell
Get-Date -Format o
# 2026-06-05T10:55:38.8942642+01:00
```

Sources opened:

| Source | Observed evidence | Planning consequence |
| --- | --- | --- |
| GitNexus PR #205: https://github.com/abhigyanpatwari/GitNexus/pull/205 | The initial proposal added PostToolUse auto-reindex after git commit/merge, preserved embeddings by reading `meta.json`, and explained that stale indexes cause agents to work from outdated graphs. Review comments later recorded why synchronous hook-triggered analyze is dangerous: long blocking, timeout risk, possible inconsistent DB state, and race/corruption concerns. | Confirms staleness is a real product problem. Also confirms that hidden/synchronous hook execution is not the safe route for our local feature. |
| GitNexus PR #1070: https://github.com/abhigyanpatwari/GitNexus/pull/1070 | README/AGENTS/skill docs were corrected because the hook was notification-only, not auto-reindex. The PR explicitly left the Enterprise "Auto-reindexing" line intact as a distinct Enterprise feature. | Strong alignment: OSS hook notification is not Enterprise auto-reindexing. Our local implementation should be opt-in server orchestration, not a hook doc rewrite. |
| GitNexus issue #253: https://github.com/abhigyanpatwari/GitNexus/issues/253 | Requests `gitnexus analyze --all` over all known repos, reading the same source as `list`, skipping missing paths, respecting flags, and printing succeeded/skipped/failed summary. | Supports registry-driven sweep semantics and failure summaries for Auto-Reindexing. Also informs possible future CLI ergonomics, but first slice should stay server-side unless MAIN chooses a CLI feature. |
| GitNexus issue #1400: https://github.com/abhigyanpatwari/GitNexus/issues/1400 | Windows report where analyze created `.gitnexus` files but repo was not recognized in registry/status/list until later fixes. | Auto-Reindexing must verify registry visibility and index-finalization state; child process exit alone is insufficient as a product signal. |
| GitNexus PR #1446: https://github.com/abhigyanpatwari/GitNexus/pull/1446 | Adds a two-workflow fork-safe PR automation pattern: untrusted `pull_request` job runs with `permissions: {}` and uploads diff artifact; trusted `workflow_run` job never touches fork code and validates metadata before posting. | Future PR Review automation should reuse this trust-separation pattern. Not needed for the first PR-review slice, which should remain local report-only. |
| GitNexus PR #1851: https://github.com/abhigyanpatwari/GitNexus/pull/1851 | PR reviewer swarm is evidence-grounded and read-only, with explicit lane responsibilities and later hardening around read-only Bash policy and canonical cross-CLI prompt files. | Good report schema/reference for PR Review / Blast Radius, but not a deployed automated PR-review product. |

Refined intended-function notes:

- Auto-Reindexing intended function: not "make hooks run analyze"; rather, remove the stale-index manual burden while avoiding hidden hook/database hazards.
- PR Review intended function: not "let agents freely comment on PRs"; rather, produce evidence-grounded blast-radius findings, then only later automate publication with strict trust separation.
- Auto-Updating Code Wiki intended function: likely "docs stay current after graph refresh," but no GitHub PR/issue evidence found yet that proves unattended wiki generation policy. Treat LLM/provider/cost/publish behavior as unresolved.

### 2026-06-05T10:57:03+01:00 - Code Wiki Analogue Deepening

Objective:

- Understand the intended behavior of "auto-updating Code Wiki" by comparing GitNexus's existing wiki generator with public/open documentation systems.
- Keep this as research for the later feature; do not let it jump ahead of Auto-Reindexing.

Objective time marker:

```powershell
Get-Date -Format o
# 2026-06-05T10:57:03.8425753+01:00
```

Sources opened:

| Source | Evidence | Planning consequence |
| --- | --- | --- |
| CodeWiki GitHub: https://github.com/FSoft-AI4Code/CodeWiki | Open-source repo documentation framework; supports `codewiki generate`, `--github-pages`, `--create-branch`, and `codewiki generate --update` for incremental changed-module regeneration. Outputs `docs/`, module docs, metadata, module tree, and HTML viewer. | Confirms a plausible user expectation for Code Wiki: explicit generation, optional branch/viewer publishing, and incremental updates. GitNexus should reuse its own wiki generator rather than importing CodeWiki architecture. |
| repowise Auto Wiki docs: https://docs.repowise.dev/docs/intelligence/auto-wiki | Describes file/module/symbol pages with citations, confidence score, freshness status, dependency-graph propagation, and cascade budget for large refactors. | Useful vocabulary for GitNexus planning: freshness status, confidence, cited source ranges, and cascade budget. These may be future design terms, not first-slice requirements unless MAIN approves. |
| RepoDoc paper: https://arxiv.org/abs/2604.26523 | Knowledge-graph-backed docs use module clustering, Mermaid diagrams, cross-references, and semantic impact propagation for selective regeneration; reports faster/lower-token incremental updates. | Strong evidence that graph-backed incremental wiki updates fit GitNexus's architecture. Supports sequencing after Auto-Reindexing because freshness is the prerequisite. |
| DeepWiki Open: https://github.com/AsyncFuncAI/deepwiki-open | Open-source wiki generator for GitHub/GitLab/Bitbucket repositories, producing documentation, diagrams, and navigable wiki structure. | Confirms the product category, but does not imply GitNexus should build a new interactive wiki stack for this local feature. |

Local contrast:

- `gitnexus/src/core/wiki/generator.ts` already has full/incremental/up-to-date modes, `WikiMeta`, module files, module tree, LLM provider routing, timeouts/retries through CLI wiring, and HTML viewer generation.
- The missing local behavior is not "how to generate a wiki"; it is "when and under what policy should an existing wiki be refreshed automatically."

Feature planning implication:

- Auto-Updating Code Wiki should remain Task 3.
- The first plausible slice should be: after a successful Auto-Reindexing freshness sweep, detect whether a wiki already exists and whether its metadata is behind; if policy permits unattended LLM usage, run the existing generator and record status/pages/duration/skipped reason.
- Open questions before implementation: LLM provider availability, cost controls, language setting, output publication/branch behavior, large-refactor cascade caps, and whether a skipped result should be visible in server operations.

### 2026-06-05T10:58:11+01:00 - Deferred Features Boundary Check

Objective:

- Check whether Auto Regression Forensics and End-to-End Test Generation have enough intended-function clarity to move earlier.
- Keep this as a boundary check, not implementation planning.

Objective time marker:

```powershell
Get-Date -Format o
# 2026-06-05T10:58:11.0659192+01:00
```

Sources opened:

| Source | Feature area | Evidence | Planning consequence |
| --- | --- | --- | --- |
| Git `bisect` docs: https://git-scm.com/docs/git-bisect/2.50.0.html | Auto Regression Forensics | `git bisect` identifies a first bad commit using good/bad marks and can run an automated test script with `git bisect run`; exit 125 can skip untestable revisions. | A future forensics feature likely needs known-good/known-bad commits plus a reliable test command. GitNexus graph evidence can enrich the report, but cannot replace the failing-test oracle. |
| SWE-bench paper: https://arxiv.org/abs/2310.06770 | Regression/eval | SWE-bench tasks use real GitHub issues and require multi-file reasoning in realistic codebases. | Local `eval/` aligns with measuring agent improvement, not with product-level regression forensics. Keep separate. |
| SWE-bench harness docs: https://www.swebench.com/SWE-bench/api/harness/ | Regression/eval | Evaluation reports distinguish fail-to-pass and pass-to-pass behavior, and use Dockerized repos at specific commits. | Good vocabulary for future regression evaluation, but too heavy for near-term GitNexus feature implementation. |
| Assrt: https://assrt.ai/ | E2E test generation | Open-source/self-hosted product crawls a web app, generates Playwright code, and can repair selectors. Requires URL/app runtime and CI/test environment. | Confirms E2E generation is an environment-heavy feature. GitNexus lacks a named app runtime/preview URL/test framework scope for this workstream. |
| TestForge paper: https://arxiv.org/abs/2503.14713 | Test generation | Agentic test generation improves tests through execution and coverage feedback; evaluation uses real-world repositories and mutation score/coverage metrics. | Any serious test-generation feature needs execution feedback and a quality metric, not just generated files. |

Deferred-feature conclusion:

- Auto Regression Forensics should stay deferred until we define the evidence contract: failing command/log, known-good ref, known-bad ref, skip policy, and how graph impact findings are reported alongside bisection output.
- End-to-End Test Generation should stay deferred until we define the execution contract: app launch command, browser/test framework, secrets policy, generated-test ownership, whether tests are committed, and how false positives are reviewed.
- Local `eval/` should not be mistaken for either product feature. It benchmarks whether GitNexus helps agents solve tasks; it does not expose a user workflow for regression forensics or generated E2E tests.

### 2026-06-05T10:59:21+01:00 - OCaml Support Boundary Check

Objective:

- Confirm whether OCaml support is a near-term parser toggle or a full language-support project.

Objective time marker:

```powershell
Get-Date -Format o
# 2026-06-05T10:59:21.1908880+01:00
```

Sources / commands:

```powershell
rg -n "export const SUPPORTED|SupportedLanguage|LANGUAGE_CONFIGS|tree-sitter-ocaml|ocaml|extensions" gitnexus-shared\src gitnexus\src\core\ingestion\languages gitnexus\package.json gitnexus\src\core\ingestion\tree-sitter-queries.ts -g "*.ts" -g "*.json"
gitnexus query --repo gitnexus-local-features "language support provider tree-sitter queries supported languages add new language tests parser resolver OCaml" --limit 10
```

Findings:

- Public Tree-sitter evidence confirms `tree-sitter/tree-sitter-ocaml` exists and was updated recently.
- Local `gitnexus-shared/src/languages.ts` has an exhaustive `SupportedLanguages` enum and no OCaml member.
- Local `gitnexus-shared/src/language-detection.ts` has an exhaustive extension map and no `.ml` / `.mli` entries.
- Local `gitnexus/src/core/ingestion/languages/index.ts` has an exhaustive provider table and no OCaml provider.
- Local `gitnexus/src/core/ingestion/tree-sitter-queries.ts` has an exhaustive language-query map and no OCaml query set.

Conclusion:

- OCaml support is feasible in principle because a grammar exists, but not small.
- Minimum work likely includes enum/extension/syntax additions, dependency/build handling, parser loader integration, an OCaml `LanguageProvider`, tree-sitter queries, import/module resolution, method/type/call extraction tests, fixtures, and possibly Dune/module/functor handling.
- Keep OCaml deferred and do not mix it into Auto-Reindexing, PR Review, or Code Wiki work.

### 2026-06-05T17:25:47+01:00 - PR Review / Blast Radius Intended Function Deep Dive

Objective:

- Research what the PR Review / Blast Radius feature is intended to do.
- Inspect GitNexus GitHub PRs/issues, local GitNexus primitives, external blast-radius examples, and the user-supplied BlastRadius PDF.
- Keep this as preimplementation research. Do not authorize source changes.

Objective time markers:

```powershell
Get-Date -Format o
# 2026-06-05T17:25:47.8261025+01:00
# 2026-06-05T17:34:58.6110651+01:00
```

Local GitNexus evidence:

| Source | Evidence | Planning consequence |
| --- | --- | --- |
| `C:\Users\steve\.agents\skills\gitnexus-pr-review\SKILL.md` | Defines a manual PR review workflow: read PR diff, run `detect_changes`, inspect `impact` and `context`, summarize risk, findings, missing coverage, and recommendation. | Existing GitNexus PR review guidance is report/review oriented, not automatic GitHub mutation. |
| `pr-swarm-review/README.md` and `pr-swarm-review/orchestration.md` | Defines read-only coordinated review lanes: facts, branch hygiene, risk, test/CI, security boundary, docs/DoD, synthesis critic. Manual invocation; no hooks; no edits; no GitHub posting. | Strong local precedent: PR Review should begin as read-only/report-first. |
| `gitnexus/src/mcp/tools.ts` and `gitnexus/src/mcp/local/local-backend.ts` | Existing primitives include `detect_changes`, `impact`, and `api_impact`. `detect_changes` maps git-diff hunks to changed symbols/processes; `impact` traverses blast radius; `api_impact` reports route consumers, response shape, middleware, mismatches, and risk. | First implementation can compose existing primitives rather than invent a new graph engine. |
| `gitnexus/src/cli/detect-changes-format.ts` and `gitnexus/src/cli/index.ts` | CLI has `detect-changes`, `impact`, and other direct commands, but no first-class `pr-review` report command. Existing `detect-changes` output is compact text, not a complete PR report schema. | A future local slice would likely add a report formatter/CLI wrapper if MAIN approves. |

GitNexus GitHub evidence:

| Source | Fact / inference | Evidence | Planning consequence |
| --- | --- | --- | --- |
| GitNexus PR #1851: https://github.com/abhigyanpatwari/GitNexus/pull/1851 | Fact | Adds PR reviewer swarm agents as read-only review roles with exact classifications and evidence citations. | Intended PR review behavior includes multi-lane risk review and evidence-backed recommendation, but it is a workflow asset, not a graph-native CLI feature. |
| GitNexus issue #1901: https://github.com/abhigyanpatwari/GitNexus/issues/1901 | Fact | Proposes stable graph-mapping primitives for external diff integrations: `symbols-for-ranges` and `impact-for-symbols`; explicitly says external platforms should own PR/MR semantics and reporting. | Do not overbuild GitNexus into a full PR platform integration first. Keep provider semantics and GitHub automation out of the first local slice. |
| GitNexus issue #1828: https://github.com/abhigyanpatwari/GitNexus/issues/1828 | Fact | Earlier structured graph mapping API proposal; superseded by #1901, with optional `map-diff` deliberately left out. | Confirms the narrower boundary in #1901 is intentional. |
| GitNexus PR #892 and issue #855 | Fact | `detect_changes` existed in backend/MCP before direct CLI; PR #892 fixed CLI surface drift. | Any PR Review surface must keep CLI/docs/tool behavior aligned and tested. |
| GitNexus issue #758 and PR #779 | Fact | `detect_changes` was made more rigorous by using `git diff -U0` and mapping hunks to symbol line ranges. | Changed-symbol evidence should be hunk/range based, not changed-file based. |
| GitNexus issue #415 and PR #416 | Fact | Added/Modified/Deleted distinction was proposed because new symbols can inflate risk; PR #416 closed unmerged. | Current local report must disclose that change-type-aware risk is not guaranteed. |
| GitNexus issue #414 and PR #1818 | Fact | Impact analysis needed pagination/limits for hub symbols; PR #1818 added `limit`, `offset`, `summaryOnly`, and depth counts. | PR Review must be bounded and summary-first to avoid giant output. |
| GitNexus PR #1867 | Fact | Adds per-symbol process participation to `impact` by-depth items when not summary-only. | Detailed report can drill into process participation after bounded summary. |
| GitNexus PR #482 and PR #1852 | Fact | `api_impact` and indirect call/consumer tracing make API-route blast-radius analysis richer. | API changed files should get an optional API-impact section when route context is available. |
| GitNexus issue #1903 | Fact | Worktree/path ambiguity can make `detect_changes --repo <path>` unreliable when duplicate repo names collide. | PR Review must use explicit repo identity and warn on stale/ambiguous index resolution. |
| GitNexus PRs #1522, #1523, #388, #394, #1446, #1454, #1458 | Fact | GitHub PR-comment automation required correct `--comment`, trusted-contributor guards, fork handling, least-privilege token permissions, split trusted/untrusted workflow design, and ChatOps safeguards. | GitHub posting/Actions automation is security-sensitive and should be a later approved slice, not the first local report feature. |

External evidence / analogues:

| Source | Evidence | Planning consequence |
| --- | --- | --- |
| BlastRadius lablab page: https://lablab.ai/ai-hackathons/ibm-bob-hackathon/ghost-commiter/blastradius-pr-impact-analysis | Product pitch: paste GitHub PR URL, fetch diff, trace call chains up to 5 hops, assign risk/confidence, statically verify edges, find missing tests, generate test stubs, stream SSE, render graph, persist report, post PR comment. | Useful aspirational product shape, but not GitNexus source authority. GitNexus can borrow report vocabulary, not implementation assumptions. |
| `tazwaryayyyy/BlastRadius`: https://github.com/tazwaryayyyy/BlastRadius | README describes two-stage TraceAgent/RemediationAgent, BLOCK/PROCEED verdict, missing-test stubs, GitHub Actions PR comment integration, context prioritization, and explicit context budget transparency. | Confirms the external category: PR impact intelligence is framed around downstream call chains, uncovered critical paths, and merge verdicts. |
| BlastRadius workflow `.github/workflows/blastradius.yml` | Posts PR comments by calling a deployed API URL from GitHub Actions. | Demonstrates automation shape, but it uses an external service and token-bearing GitHub workflow. This should remain out of first GitNexus slice. |
| BlastRadius backend `diff_parser.py`, `trace_agent.py`, `ast_verifier.py` | Uses regex diff symbol extraction, LLM reasoning, and lightweight Python/JS edge verification. | GitNexus already has stronger indexed graph primitives; do not copy this architecture. It is a comparison point only. |
| User PDF `C:\Users\steve\Downloads\z8utq3ndf19mi6tjlcdtg175-1779001225476_tikfb9j9xadtk9sc1oly0ezz.pdf` | Seven-page pitch deck: problem, two Bob calls, 5-hop chain tracing, AST-verified edges, missing test coverage, generated test stubs, incident estimate, BLOCK verdict, Bob session log, live GitHub PR examples. | Good concise product narrative. For GitNexus planning, it supports a report with changed symbols, transitive impact paths, test coverage gaps, risk/verdict, and evidence/caveats. |
| GitHub topic `blast-radius`: https://github.com/topics/blast-radius | Public repos cluster around dependency graphs, risk scoring, local-first code intelligence, MCP, diff-aware review, and infra blast-radius tools. | Confirms "blast radius" is a broad pattern, not one canonical product. Use as vocabulary support, not implementation authority. |
| `scheidydude/codeindex`: https://github.com/scheidydude/codeindex | File-level dependency index, blast score, markdown/JSON output, optional hooks and MCP. | Reinforces value of CLI + markdown/JSON report output. Hooks remain out of scope for this workstream. |
| `sverklo/sverklo`: https://github.com/sverklo/sverklo | Local-first MCP with symbol graph, blast radius, `review_diff`, risk-scored diff review, and GitHub-review JSON/action support. | Strong external analogue for local-first, agent-facing diff review. Still not a reason to add dependencies or copy architecture. |

Synthesis:

- The intended PR Review / Blast Radius feature is not just "review changed lines." It should answer: what changed, what downstream symbols/processes/routes are affected, what risk level follows, what test/coverage gaps exist, and what recommendation should a reviewer act on.
- GitNexus-specific evidence points toward a graph-native report composed from `detect_changes`, `impact`, and `api_impact`.
- GitNexus issue #1901 is the most important boundary correction: external PR/MR platforms should own provider semantics, merge-base selection, job lifecycle, and reporting. GitNexus should expose stable graph mapping and impact primitives.
- Existing PR swarm assets and security-related PRs strongly argue that first implementation should be read-only/local and should not post to GitHub, mutate workflows, add hooks, or require tokens.
- External BlastRadius examples justify a future richer product direction: PR URL ingestion, graph visualization, generated test stubs, remediation summary, and PR comment automation. Those are later slices, not the first GitNexus local slice.

Research conclusion for planning:

- Keep PR Review / Blast Radius as `medium now`, after Auto-Reindexing snapshot/approval.
- First safe implementation candidate remains a local report-first workflow, but it should be explicitly framed as a thin composition over existing primitives, not a final platform-integration API.
- The report should support Markdown and JSON, bounded output, explicit stale/ambiguous-index warnings, fact-vs-inference caveats, and no GitHub side effects.
- Before implementation, MAIN should decide whether the first write scope is:
  - high-level local `gitnexus pr-review` report command; or
  - lower-level stable primitives aligned with issue #1901 (`symbols-for-ranges`, `impact-for-symbols`) with a report wrapper later.

### 2026-06-07T20:43+01:00 - GitHub PR/Issue/Fork Evidence Refresh

Objective:

- Refresh the feature plan against live GitHub issues, PRs, forks, and adjacent GitNexus repos.
- Answer whether the current plan is cogent when grounded in upstream issue/PR evidence.
- Check whether any public GitNexus fork appears to have already implemented the target enterprise/local-feature set.
- Keep this as scratchpad evidence only. The current queue and checkpoint truth remain in `plans.md`, `feature-map.md`, and `documentation.md`.

Objective time markers:

```powershell
Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
# 2026-06-07T20:43:03+01:00
# 2026-06-07T20:47:07+01:00
```

Research method:

- Used the `autoresearch` skill pattern lightly: query matrix, source-class separation, synthesis, uncertainty check.
- Used GitHub CLI and web search for direct issue/PR/repo inspection.
- Treated upstream GitNexus issues/PRs as primary evidence.
- Treated forks and adjacent repos as reference-code evidence only after inspecting source/tree/compare data.
- Treated repo descriptions, README marketing, and topic search as secondary evidence.

Commands / searches run:

```powershell
gh repo view abhigyanpatwari/GitNexus --json nameWithOwner,isFork,forkCount,stargazerCount,updatedAt,defaultBranchRef,url
gh search issues "reindex" --repo abhigyanpatwari/GitNexus --limit 30 --json number,title,state,url,updatedAt,labels
gh search issues "wiki" --repo abhigyanpatwari/GitNexus --limit 30 --json number,title,state,url,updatedAt,labels
gh search issues "detect_changes impact PR" --repo abhigyanpatwari/GitNexus --limit 30 --json number,title,state,url,updatedAt,labels
gh search issues "OCaml" --repo abhigyanpatwari/GitNexus --limit 20 --json number,title,state,url,updatedAt,labels
gh search prs "reindex" --repo abhigyanpatwari/GitNexus --limit 30 --json number,title,state,url,updatedAt
gh search prs "wiki" --repo abhigyanpatwari/GitNexus --limit 30 --json number,title,state,url,updatedAt
gh search prs "group cross repo contract" --repo abhigyanpatwari/GitNexus --limit 30 --json number,title,state,url,updatedAt
gh api "repos/abhigyanpatwari/GitNexus/forks?per_page=30&sort=stargazers"
gh api "repos/abhigyanpatwari/GitNexus/compare/main...nantas:nantas-dev"
gh api "repos/abhigyanpatwari/GitNexus/compare/main...Trenza1ore:main"
gh search code "repo:nantas/GitNexus auto-reindex"
gh search code "repo:nantas/GitNexus pr-impact"
gh search code "repo:nantas/GitNexus wiki refresh"
gh search code "repo:nantas/GitNexus OCaml"
gh search code "repo:abhigyanpatwari/GitNexus symbols-for-ranges"
gh search code "repo:abhigyanpatwari/GitNexus tree-sitter-ocaml"
```

#### Upstream Issue/PR Evidence Matrix

| Feature area | Source | Evidence | Planning consequence |
| --- | --- | --- | --- |
| Auto-Reindexing | GitNexus issue #90: https://github.com/abhigyanpatwari/GitNexus/issues/90 | Requested an MCP tool to refresh the knowledge graph after code changes. Maintainer reply said stale notification already exists and "Best solution is to add a filewatcher." | Confirms automatic freshness is a real intended capability. It also shows a naive MCP command is not enough if agents ignore it. |
| Auto-Reindexing | GitNexus issue #76: https://github.com/abhigyanpatwari/GitNexus/issues/76 | Full re-index after branch switch or small changes is impractical for large repos; comments point toward incremental indexing and branch/changed-file awareness. | Supports freshness work, but also warns that auto-refresh should be efficient and not just force rebuilds. |
| Auto-Reindexing | GitNexus PR #1479: https://github.com/abhigyanpatwari/GitNexus/pull/1479 | Incremental analyze became default using parse cache, DB writeback, crash recovery, and equivalence checks. | Any auto-reindex plan should reuse the incremental analyze path and preserve full vs incremental equivalence assumptions. |
| Auto-Reindexing | GitNexus issue #1496: https://github.com/abhigyanpatwari/GitNexus/issues/1496 | Requests daemon-side `POST /reindex` because eval-server consumers cannot refresh a warm daemon without restart. | Strong evidence for a later server/daemon refresh endpoint, but not necessary for the already completed local V1 freshness sweep. |
| Auto-Reindexing | GitNexus PR #205 and PR #1070: https://github.com/abhigyanpatwari/GitNexus/pull/205 and https://github.com/abhigyanpatwari/GitNexus/pull/1070 | #205 originally framed hook auto-reindex, but review/docs later clarified the hook should be notification-only to avoid blocking, timeouts, and DB corruption risk. | Confirms our local "no hooks as implementation route" rule is aligned with upstream hardening. |
| Auto-Reindexing / Ops | GitNexus issue #344: https://github.com/abhigyanpatwari/GitNexus/issues/344 | Production users report 25+ repo deployment needs: cron-friendly reindex, embedding preservation, dirty worktree checks, smoke tests, version drift doctor, graph verification. | Good operational reference for future Podman/runtime validation. It is not a direct upstream feature implementation. |
| Auto-Updating Code Wiki | GitNexus issue #1558: https://github.com/abhigyanpatwari/GitNexus/issues/1558 | User asks whether `gitnexus wiki` can be called in a coding agent and reuse agent LLM config. Comment warns GitNexus should not peek into coding-agent secrets. | Strong policy evidence: wiki mutation/provider execution must not assume access to agent secrets. |
| Auto-Updating Code Wiki | GitNexus issue #1957: https://github.com/abhigyanpatwari/GitNexus/issues/1957 | Requests Copilot support for wiki generation, but no acceptance criteria. | Confirms provider support pressure, not enough to authorize mutation or provider execution. |
| Auto-Updating Code Wiki | GitNexus PR #1769 and PR #2039: https://github.com/abhigyanpatwari/GitNexus/pull/1769 and https://github.com/abhigyanpatwari/GitNexus/pull/2039 | Adds local Claude/Codex providers, then OpenCode provider, for `gitnexus wiki`. PR text keeps `gitnexus wiki` as CLI entrypoint; no server/MCP wiki mutation surface is added. | Supports current Task 2 direction: status/provider-readiness first, explicit mutation/provider policy before output writes. |
| PR Impact / Blast Radius | GitNexus issue #1901: https://github.com/abhigyanpatwari/GitNexus/issues/1901 | Proposes stable graph-mapping primitives: `symbols-for-ranges` and `impact-for-symbols`; says external PR/MR platforms should own diff/provider semantics and reporting. | This is the most important boundary evidence for PR Impact. Local pipeline should remain deterministic and graph-first; GitHub automation is a later layer. |
| PR Impact / Blast Radius | GitNexus issue #758: https://github.com/abhigyanpatwari/GitNexus/issues/758 | Critiques file-level `detect_changes` and calls for actual diff-hunk to symbol-range mapping. | Validates the current `diff ranges -> symbols -> impact -> report` framing. |
| PR Impact / Blast Radius | GitNexus issue #415: https://github.com/abhigyanpatwari/GitNexus/issues/415 | Risk is inflated when added symbols are treated like modified symbols; deleted symbols should be higher risk. | Supports explicit added/modified/deleted handling and cautious verdict rules. |
| PR Impact / Blast Radius | GitNexus PR #1867: https://github.com/abhigyanpatwari/GitNexus/pull/1867 | Adds per-symbol process participation to `impact` by-depth output. | Supports richer PR impact report sections without inventing a new graph model. |
| GitHub PR automation boundary | GitNexus PR #1446: https://github.com/abhigyanpatwari/GitNexus/pull/1446 | Implements a fork-safe two-workflow PR autofix pipeline with untrusted `pull_request` data production and trusted `workflow_run` publication. | Strong architecture reference for later token-bearing PR automation, but out of the current local V1. |
| Multi-Repo | GitNexus issue #306: https://github.com/abhigyanpatwari/GitNexus/issues/306 | Requests cross-repo HTTP API bridge (`HTTP_CALLS`) so frontend/backend graphs connect across repos. | Confirms enterprise expectation is cross-repo relationship resolution, not merely multiple registered repos. |
| Multi-Repo | GitNexus PR #984: https://github.com/abhigyanpatwari/GitNexus/pull/984 | Merged group-aware `query`, `context`, and `impact` with `repo: "@group"` routing and group resources. | Supports the completed Task 3 documentation/surface reconciliation. Unified graph expansion remains separate. |
| Multi-Repo | GitNexus PR #1583: https://github.com/abhigyanpatwari/GitNexus/pull/1583 | Open cross-repo call trace PR with pluggable resolver; review concerns include missing resolver file and depth limits. | Useful future reference, but not production-ready reference code to copy. |
| OCaml | GitNexus issue #1368: https://github.com/abhigyanpatwari/GitNexus/issues/1368 | Requests `.ml` / `.mli` support with tree-sitter-ocaml, top-level lets, modules, type definitions, opens, and calls. Claims a working fork implementation exists. | Supports OCaml as a real intended language feature. Public reference fork was not found in this pass, so local implementation should remain evidence-tested and experimental. |
| Regression/E2E | GitNexus issue #554: https://github.com/abhigyanpatwari/GitNexus/issues/554 | Proposes temporal robustness testing: mutate graph, re-run eval, compare degradation/recovery/noise. | Supports future regression-forensics/eval direction, but not a direct product feature implementation. |

#### Fork / Adjacent Repository Scan

| Repo | Type | Evidence found | Feature relevance | Disposition |
| --- | --- | --- | --- | --- |
| `abhigyanpatwari/GitNexus` | Upstream | `forkCount: 4747`, default branch `main`, updated 2026-06-07. | Primary source of issues/PRs and current intent. | Source of truth. |
| `nxpatterns/gitnexus` | Fork | Compare: `ahead_by: 0`, `behind_by: 98`. | Mirror/behind fork; no target feature implementation. | Not useful as implementation reference. |
| `digitalapplied/gitnexus` | Fork | Compare: `ahead_by: 0`, `behind_by: 889`. | Mirror/behind fork; no target feature implementation. | Not useful as implementation reference. |
| `nantas/GitNexus` | Fork | Compare: `ahead_by: 514`, `behind_by: 872`; large Unity/runtime/benchmark divergence. Tree contains `benchmarks/u2-e2e`, Unity runtime/process docs, rule-lab, query-context benchmarks, many Unity reports. | Useful for E2E/benchmark methodology and agent-context validation patterns. No exact `auto-reindex`, `pr-impact`, wiki refresh, or OCaml implementation found by targeted code search. | Adjacent reference only; not a drop-in enterprise-feature fork. |
| `Trenza1ore/GitNexus-Cangjie` | Fork | Compare: `ahead_by: 3`, `behind_by: 659`; changed files add Cangjie language provider, parser/queries/import resolver/type extractor, tests, porting notes. | Useful as a language-onboarding pattern for non-core language support. It is Cangjie, not OCaml. | Useful analogue for future language-support methodology. |
| `leeex1/GitNexus` | Fork | Compare: `ahead_by: 0`, `behind_by: 64`. | Mirror/behind fork. | Not useful as implementation reference. |
| `heliopaivajr/GitNexus` | Fork | Compare: `ahead_by: 0`, `behind_by: 7`. | Near-current mirror/behind fork. | Not useful as implementation reference. |
| `Akon-Labs/gitnexus-check` | Adjacent repo, not fork | GitHub Action computes PR diff stats, decides lazy vs full reindex, uploads bundles to Hub, fetches a Context Pack, writes `context-pack.json`, `system-prompt.md`, and MCP config for PR review. | Closest public reference for GitNexus PR-check/PR-review automation. It depends on a Hub and token model, not local OSS-only CLI. | Strong future reference for GitHub automation boundary; not current local V1. |
| `maddieunlawful958/gitnexus-stable-ops` | Adjacent repo, not fork | Contains shell scripts for `gitnexus-auto-reindex.sh`, `gitnexus-reindex-all.sh`, smoke tests, embedding-flag preservation, dirty-worktree checks, and an agent-graph reindexer. README is generic/low-specificity, but script source is concrete. | Useful ops reference for reindex safety and smoke tests. | Medium-trust reference after source inspection; do not copy wholesale. |
| `tintinweb/pi-gitnexus` | Adjacent repo, not fork | Repo description: GitNexus knowledge graph integration for Pi coding agent. | Tooling/integration reference only. | Not evidence of target enterprise features. |
| `antomy-gc/gitnexus-opencode` | Adjacent repo, not fork | Repo description: OpenCode integration with GitNexus. | Provider/tool integration reference. | Not evidence of target enterprise features. |

#### Direct Reference-Code Notes

`Akon-Labs/gitnexus-check`:

- `src/main.ts` flow:
  - validate PR event and action inputs,
  - resolve repo on Hub,
  - compute local diff stats,
  - decide lazy vs full reindex,
  - bundle/upload PR head if reindexing,
  - fetch Context Pack,
  - render artifacts for Claude PR review.
- `src/diff.ts`:
  - uses `git diff --numstat` and `git diff --name-status`,
  - tracks added/deleted/renamed/modified file status,
  - treats diff failures conservatively by forcing full reindex,
  - forces reindex for big diffs, renames, deep-review label, or lazy disabled.
- `src/templates/system-prompt.md`:
  - tells the reviewer to read the Context Pack first,
  - treats MCP as follow-up only,
  - emphasizes graph-level findings, cross-repo consumers, boundary crossings, and concise PR comments.

Planning consequence:

- This is strong evidence that a richer GitNexus PR automation product likely uses:
  - a precomputed context pack,
  - diff stats,
  - lazy/full reindex decision,
  - MCP follow-up,
  - a strict output/comment protocol.
- It also confirms why our local PR Impact V1 should stay local/read-only: the real GitHub automation shape needs Hub/token/workflow decisions.

`maddieunlawful958/gitnexus-stable-ops`:

- `bin/gitnexus-auto-reindex.sh` checks `.gitnexus/meta.json.lastCommit` against `git rev-parse HEAD`, skips if current, and preserves `--embeddings` based on `stats.embeddings`.
- `bin/gitnexus-reindex-all.sh` reads the registry, skips missing repos, skips dirty worktrees unless explicitly allowed, and preserves embeddings.
- `bin/gitnexus-smoke-test.sh` runs analyze/status/list/context/cypher/impact and verifies JSON outputs with `jq`.
- `lib/common.sh` centralizes `embedding_flag`, dirty repo checks, and empty repo skip logic.

Planning consequence:

- Useful concrete support for reindex safety rules:
  - preserve embeddings,
  - skip dirty worktrees by default,
  - verify registry/list/status/context/impact after reindex,
  - make batch reindex summarize skipped/missing repos.
- It is an ops toolkit, not an upstream architecture mandate.

`nantas/GitNexus`:

- Large divergent fork, but the sampled plan and tree point to Unity runtime/process/E2E benchmark work rather than the current target enterprise features.
- The U2 E2E plan uses staged gates, preflight, analyze timing capture, scenario-driven tool calls, timing/token metrics, JSON/JSONL/Markdown reports, and fail-fast checkpoint artifacts.

Planning consequence:

- Useful methodology reference for future E2E/regression/benchmark slices.
- No evidence that this fork implemented Auto-Reindexing, Auto-Updating Wiki, PR Impact, or OCaml under names we searched.

`Trenza1ore/GitNexus-Cangjie`:

- Adds a new language provider and porting notes for Cangjie, including enum/config/provider/parser/query/import/type extraction and tests.

Planning consequence:

- Useful language-onboarding analogue for future OCaml depth work.
- It should not be mistaken for OCaml reference code.

#### Negative Evidence

Targeted GitHub code searches returned no matches for likely local-feature names:

| Query | Result |
| --- | --- |
| `repo:nantas/GitNexus auto-reindex` | No code results |
| `repo:nantas/GitNexus pr-impact` | No code results |
| `repo:nantas/GitNexus wiki refresh` | No code results |
| `repo:nantas/GitNexus OCaml` | No code results |
| `repo:nantas/GitNexus e2e` | No code result from GitHub code search, but tree inspection found `benchmarks/u2-e2e` and many E2E report files |
| `repo:abhigyanpatwari/GitNexus symbols-for-ranges` | No code results; issue #1901 remains proposal evidence |
| `repo:abhigyanpatwari/GitNexus tree-sitter-ocaml` | No code results; issue #1368 remains proposal evidence |

Negative evidence caveat:

- Absence from GitHub search does not prove no private/public fork implementation exists under different names.
- It does mean no obvious public implementation was found in the inspected top forks and adjacent repos.

#### Updated Synthesis

- Yes, the plan is cogent when grounded in GitHub issues/PRs:
  - Auto-Reindexing is justified by #90, #76, #1479, #1496, #344, #205, and #1070.
  - Wiki mutation/provider policy is justified by #1558, #1957, #1769, and #2039.
  - PR Impact/GitHub automation boundary is justified by #1901, #758, #415, #1867, #1446, and `Akon-Labs/gitnexus-check`.
  - Multi-Repo future work is justified by #306, #984, and #1583.
  - OCaml is justified by #1368, but public reference code remains unconfirmed.
  - Regression/E2E direction is supported by #554 and `nantas/GitNexus` benchmark methodology, but not by a ready product implementation.

- No inspected public fork appears to have implemented the exact target enterprise/local-feature set for us.
- The best reference-code sources are adjacent, not drop-in:
  - `Akon-Labs/gitnexus-check` for future PR automation/context-pack architecture.
  - `maddieunlawful958/gitnexus-stable-ops` for reindex ops/smoke-test safety.
  - `nantas/GitNexus` for E2E/benchmark/reporting methodology.
  - `Trenza1ore/GitNexus-Cangjie` for language-onboarding methodology.

#### Planning Consequences For Next Work

- Do not reopen broad feature implementation just because a public fork exists; no inspected fork provides a clean implementation to merge.
- Keep the current post-tranche next task as `Task 2 Wiki Mutation / Manual Refresh Policy readiness`.
- For Task 2, use #1558 and the local provider PRs as the policy anchor:
  - no secret peeking,
  - no provider execution from server endpoints without explicit policy,
  - no wiki output mutation until output path, rollback, status, and reporting are named.
- For later Task 4 GitHub automation, use `Akon-Labs/gitnexus-check` and PR #1446 as architecture references:
  - separate untrusted PR data from trusted publishing,
  - precompute a context pack,
  - keep MCP follow-up bounded,
  - define token permissions and dry-run behavior before source work.
- For future Auto-Reindexing ops hardening, use stable-ops as a checklist, not code to copy:
  - embedding preservation,
  - dirty worktree policy,
  - registry/list/status validation,
  - smoke tests and drift checks.

#### Uncertainties / Adversarial Check

What could make this conclusion wrong:

- A private or differently named fork may contain OCaml, wiki mutation, or PR automation code that was not discoverable by public GitHub search.
- GitHub code search may miss generated/bundled code, non-default branches, or terms that differ from our local feature names.
- Adjacent repos may be stale, generated, or not maintained; source inspection helps but does not make them upstream truth.
- Upstream may have new PRs after this timestamp; future agents should re-run targeted searches before making security-sensitive or API-shaping decisions.

Smallest next experiment if continuing research:

- Inspect current upstream `gitnexus/src/cli/wiki.ts`, `core/wiki/*`, and server API surfaces locally against #1558/#1769/#2039, then draft the Task 2 wiki mutation/manual refresh policy packet with explicit no-secret, no-server-provider-execution, output-path, and rollback rules.

### 2026-06-07T20:58+01:00 - Wiki Mutation / Manual Refresh Deepening

Objective:

- Deepen the active `Task 2 Wiki Mutation / Manual Refresh Policy` readiness lane.
- Compare local wiki implementation against upstream GitHub issues/PRs and current README behavior.
- Decide whether the next defensible step is implementation, policy readiness, or deferral.

Objective time tracking:

- Start observed: `2026-06-07T20:58:33+01:00`.
- End observed: `2026-06-07T21:03:55+01:00` for this focused deepening pass.
- This was a targeted follow-on to the broader GitHub/fork evidence refresh above, not a fresh 30-40 minute full feature sweep.

#### Local Source Evidence

| Surface | Evidence | Consequence |
| --- | --- | --- |
| `gitnexus/src/core/wiki/auto-refresh.ts` | `planWikiAutoRefresh()` defaults to `dryRun = true` and only sets `shouldRunGenerator`, `willMutateOutput`, and `willRunLLM` when `dryRun: false` and `mutateOutput: true` are both explicit. | Existing core already models a safe mutation gate. The next question is policy/surface selection, not whether mutation can be represented. |
| `gitnexus/src/core/wiki/auto-refresh.ts` | Planner skips stale graph, missing wiki metadata by default, corrupt metadata, and provider-not-ready states. | Manual refresh should preserve these gates rather than bypass them. |
| `gitnexus/src/core/wiki/auto-refresh.ts` | `readWikiAutoRefreshMeta(storagePath)` reads `storagePath/wiki/meta.json`. | Wiki output currently lives in GitNexus storage, not repo docs, unless another publishing step is added later. |
| `gitnexus/src/server/api.ts` | `GET /api/wiki/auto-refresh` calls the planner with `dryRun: true` and `mutateOutput: false`; it does not call `runWikiAutoRefresh()` or `WikiGenerator`. | Current server API is intentionally status-only/read-only. A mutation-capable HTTP endpoint would be a new risk boundary. |
| `gitnexus/test/unit/wiki-auto-refresh-api-wiring.test.ts` | Test asserts the route is read-only and does not reference `runWikiAutoRefresh`, `WikiGenerator`, or `detectLocalCLI`. | Read-only server behavior is locked by tests; changing it should be treated as a deliberate product/security change. |
| `gitnexus/src/core/wiki/provider-readiness.ts` | Local CLI providers are classified as not server-ready via `local-cli-provider-not-server-ready`. | Server-side status must not spawn local coding-agent CLIs. Manual/foreground CLI remains the safer provider execution route. |
| `gitnexus/src/cli/wiki.ts` | `gitnexus wiki` is the current mutating/manual generation command, supporting `--force`, `--review`, `--lang`, `--timeout`, `--retries`, provider config, and optional gist publishing. | A V1 manual refresh policy can reuse this foreground CLI route rather than inventing background mutation first. |
| `gitnexus/src/core/wiki/generator.ts` | `WikiGenerator.run()` writes `wiki/` artifacts under storage path: module tree JSON, module markdown, `overview.md`, `meta.json`, and HTML viewer. | Any mutation approval must name this output write set and rollback/reporting behavior. |
| `gitnexus/src/core/wiki/generator.ts` | Local branch includes `GROUPING_TOKEN_BUDGET` and batched grouping. | The major grouping-overflow fix from upstream is present locally. |
| `gitnexus/src/core/wiki/generator.ts` | Local branch does not show `DEFAULT_GRAPH_FIELD_BUDGET` or `truncateText()` caps for graph-reference fields. | The open graph-field prompt overflow PR is not present locally; background auto-refresh would inherit this unresolved large-repo risk. |
| `gitnexus/src/core/wiki/local-cli-client.ts`, `llm-client.ts`, `wiki.ts` | Local branch supports Cursor/Claude/Codex wiki providers, but not OpenCode in the wiki provider path. | Upstream OpenCode PR #2039 is useful reference, but not local behavior in this checkout. |

#### GitHub / Public Evidence

| Source | Finding | Planning consequence |
| --- | --- | --- |
| GitNexus README, Wiki Generation: https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md | Public wiki command is still `gitnexus wiki`; docs describe `--force`, `--timeout`, `--retries`, and `--lang`. | Upstream public interface favors CLI/manual generation, not an exposed mutation API. |
| GitNexus README, Docker section: https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md | Docker route runs the CLI/server backend inside the container and indexes mounted repos from `/workspace`. | Container/server runtime is a normal GitNexus route, but wiki mutation still needs explicit execution/output policy. |
| Issue #1558: https://github.com/abhigyanpatwari/GitNexus/issues/1558 | User asks whether `gitnexus wiki` can be called from a coding agent and reuse agent LLM config; maintainer comment warns against peeking into other tools' secrets and notes agent/MCP sandbox boundaries. | Do not design wiki refresh around stealing or discovering coding-agent credentials. Local providers must be explicit and foreground, or HTTP credentials must be configured directly for GitNexus. |
| PR #1769: https://github.com/abhigyanpatwari/GitNexus/pull/1769 | Adds Claude/Codex local CLI wiki providers; collaborator says no Express route change is needed; final review/CI addressed timeout, subprocess, empty-output, and test-contract risks. | Local providers belong to CLI wiki first. Provider execution from server/API remains intentionally avoided. |
| PR #2039: https://github.com/abhigyanpatwari/GitNexus/pull/2039 | Adds OpenCode as a local CLI wiki provider upstream; scope states no server or MCP wiki surface was added. | Confirms the upstream pattern: add local provider support to CLI path, not background server mutation. Local branch is behind this provider addition. |
| Issue #891: https://github.com/abhigyanpatwari/GitNexus/issues/891 | Requests partial regeneration and better logs so failed wiki parts can be regenerated without discarding useful output. | A manual refresh policy should include failed-module reporting and avoid blind destructive regeneration. |
| Issue #1290: https://github.com/abhigyanpatwari/GitNexus/issues/1290 | Large project hit input context overflow: 370,035 tokens vs 131,072 limit. | Large-repo safety is central; auto-refresh must not silently loop expensive failed generation. |
| Issue #1537 / PR #1651: https://github.com/abhigyanpatwari/GitNexus/issues/1537 and https://github.com/abhigyanpatwari/GitNexus/pull/1651 | Hidden 60s default timeout was removed; `--timeout` and `--retries` validation and timeout surfacing were tightened. | Manual refresh should preserve explicit timeout/retry controls and expose failures clearly. |
| Issue #627 / PR #1832: https://github.com/abhigyanpatwari/GitNexus/issues/627 and https://github.com/abhigyanpatwari/GitNexus/pull/1832 | Budget-aware grouping was added to prevent grouping prompt overflow; PR notes no real TVM-scale E2E with API key was run. | Batch grouping mitigates one large-repo failure mode but does not make unattended refresh risk-free. |
| PR #1494: https://github.com/abhigyanpatwari/GitNexus/pull/1494 | Open PR proposes capping graph reference fields because `SOURCE_CODE` truncation alone is insufficient for dense cross-reference clusters. | There is still known prompt-size risk in module generation; this argues against silent/background mutation as the next step. |
| Factory AutoWiki docs: https://docs.factory.ai/cli/features/wiki/web-viewer | Comparable AutoWiki UX separates one-time refresh, recurring-on-push refresh, local command execution, cloud execution, version history, export, and GitHub Wiki sync. | External comparator supports making refresh mode explicit. It also shows recurring refresh and GitHub sync are separate later policy surfaces, not hidden side effects. |

#### Deficiencies / Open Design Questions

1. Mutation surface is unresolved:
   - Existing `GET /api/wiki/auto-refresh` is read-only.
   - `runWikiAutoRefresh()` exists but has no exposed mutation route in local server API.
   - Changing this would cross from status/reporting into provider execution and file mutation.

2. Provider execution boundary is unresolved:
   - Local CLI providers are explicitly not server-ready.
   - `gitnexus wiki` can use local providers in foreground CLI.
   - A server endpoint that spawns local providers would contradict current readiness policy and tests.

3. Output ownership is unresolved:
   - Current generator writes GitNexus storage artifacts under `storagePath/wiki`.
   - GitHub Wiki sync, repo-doc writes, gist publishing, and web UI publishing are separate surfaces and should not be implied.

4. Large-repo behavior is not fully settled:
   - Batched grouping exists locally.
   - Graph-reference field caps from PR #1494 are not present locally.
   - Known issue #891 asks for partial regeneration/logging, meaning failed-module recovery remains product work.

5. Local/upstream version skew exists:
   - Upstream merged OpenCode provider support in #2039.
   - Local branch wiki provider path is Cursor/Claude/Codex only.
   - Do not document OpenCode as locally available for wiki until the branch contains that code.

#### Recommended Policy Outcome

Recommended next step:

- Treat Task 2 as a policy/readiness packet, then implement only a narrow manual refresh slice if the packet is accepted.

Recommended V1 shape:

- Foreground/manual route first:
  - use `gitnexus wiki` or a small CLI-facing planner/report command;
  - no unattended server mutation;
  - no MCP mutation;
  - no GitHub Wiki sync;
  - no gist publishing unless explicitly requested by CLI flag/user interaction.

- Preserve planner gates:
  - require fresh graph;
  - require existing wiki metadata unless `createIfMissing` is explicitly chosen;
  - require provider readiness;
  - default to dry-run/report-only;
  - require explicit mutation opt-in.

- Preserve provider boundary:
  - local CLI providers may run only in foreground CLI;
  - server/API status may report local provider as not server-ready;
  - HTTP providers may be server-ready only via direct GitNexus env/saved config, without leaking secrets.

- Preserve output boundary:
  - default writes are only `storagePath/wiki`;
  - report exact files/directories that may change;
  - surface `WikiRunResult` including mode, generated pages, and failed modules;
  - do not commit, publish, sync, or push generated docs in V1.

#### Candidate Implementation Slices

| Candidate | Description | Recommendation |
| --- | --- | --- |
| Policy-only runbook | Document exact manual refresh commands, safe defaults, provider boundary, output path, and stop rules. | `now`, if we want no source change yet. |
| CLI dry-run/status command | Expose planner output in CLI form for current repo without mutating output. | `now/next`, low risk if tests lock dry-run behavior. |
| CLI explicit refresh wrapper | Use `runWikiAutoRefresh()` with `dryRun: false` and `mutateOutput: true` only behind an explicit CLI flag, preserving `gitnexus wiki` provider mechanics. | `next`, after policy packet names write set. |
| Server mutation endpoint | Add POST endpoint that can invoke provider and mutate wiki output. | `defer`; needs auth/rate-limit/provider policy, operation ledger, and secret boundary. |
| GitHub Wiki sync / PR comments / CI refresh | Publish generated wiki to GitHub surfaces or run on push. | `defer`; belongs with token-bearing GitHub automation policy. |
| Large-repo prompt hardening | Bring in/replicate graph-reference field caps similar to PR #1494. | `next/dependency`; likely should happen before recurring unattended refresh. |

#### Proposed Stop Rules

- Stop before source edits if the chosen slice writes outside `storagePath/wiki`.
- Stop before source edits if the chosen slice spawns local providers from server/API/MCP.
- Stop before source edits if the chosen slice needs GitHub tokens, GitHub Wiki sync, gist publishing, or CI workflow changes.
- Stop before source edits if recurring/on-push refresh is requested before manual one-time refresh is proven.
- Stop if local branch version skew with upstream provider support needs a merge/rebase decision.

#### Test Plan If Implementation Proceeds

- Planner tests:
  - stale graph skip;
  - missing meta skip unless explicit create;
  - corrupt meta skip;
  - provider-not-ready skip;
  - dry-run by default;
  - mutation only with `dryRun: false` and `mutateOutput: true`.

- Provider-readiness tests:
  - local CLI providers remain not server-ready;
  - HTTP env/saved config readiness does not leak API key/base URL;
  - invalid base URL does not leak raw value.

- CLI tests:
  - dry-run/status output is deterministic;
  - explicit refresh surfaces `WikiRunResult`;
  - failed generator returns failed status and error message;
  - no gist/publish/sync side effects in V1.

- API tests:
  - existing `GET /api/wiki/auto-refresh` remains read-only unless a separate approved route is introduced;
  - no route spawns `detectLocalCLI` or `WikiGenerator` accidentally.

#### Bottom Line

Yes, deeper investigation is warranted and now documented. The evidence supports moving toward a manual/foreground wiki refresh workflow, but not a hidden or server-side mutation path yet. The next defensible action is to draft the Task 2 readiness packet with a narrow write set and explicit provider/output boundaries, then implement only the accepted slice with TDD.

### 2026-06-07T21:05+01:00 - GitHub Import / Port Assessment For Wiki Lane

Prompting question:

- Have we looked on GitHub properly enough?
- Should we import code from upstream PRs or forks?

Short answer:

- We have now checked upstream PRs, upstream `main`, GitHub code search, and repo/fork-style searches well enough to make an import decision for the wiki lane.
- Do not wholesale import upstream `main` or any fork.
- Consider one small port candidate before unattended wiki refresh: PR #1494 graph-field prompt caps.
- Treat OpenCode provider support from PR #2039 as a planned provider-port candidate only if MAIN wants OpenCode locally; do not merge it blindly.

#### Commands / Evidence

| Check | Result |
| --- | --- |
| `git fetch origin main` | Updated `origin/main` to `4fc2ffa5`. |
| `git fetch origin pull/1494/head:refs/remotes/origin/pr/1494` | Fetched open PR #1494 for read-only diff inspection. |
| `git fetch origin pull/1832/head:refs/remotes/origin/pr/1832` | Fetched merged grouping-overflow PR #1832 for read-only comparison. |
| `git fetch origin pull/1769/head:refs/remotes/origin/pr/1769` | Fetched merged Claude/Codex provider PR #1769 for read-only comparison. |
| `git merge-base HEAD origin/main` | Merge-base is `0fc0211d`, confirming our local feature branch diverges from current upstream. |
| `git diff --stat HEAD..origin/main -- gitnexus/src/core/wiki ...` | Shows upstream `main` would delete local `auto-refresh.ts` and `provider-readiness.ts` because those are local-feature work, not upstream main. |
| `gh search code "runWikiAutoRefresh"` | No public GitHub code results. |
| `gh search code "planWikiAutoRefresh"` | No public GitHub code results. |
| `gh search code "api/wiki/auto-refresh"` | No public GitHub code results. |
| `gh search repos "GitNexus auto-refresh wiki"` | No matching repos. |
| `gh search repos "GitNexus wiki refresh"` | No matching repos. |
| `gh search code "gitnexus wiki --force"` | Mostly upstream README mirrors, docs, and skill references; no alternate implementation found. |
| `git log --left-right --cherry-pick HEAD...origin/main -- wiki files` | Key wiki delta is local `feat: add wiki provider readiness status` versus upstream `feat(wiki): add opencode local provider (#2039)`. |

#### Import Candidates

| Candidate | Source | Status | Import disposition |
| --- | --- | --- | --- |
| Wiki auto-refresh planner/runner | Local branch only | No public implementation found via GitHub code search. | Already local; nothing to import. |
| Read-only `/api/wiki/auto-refresh` status endpoint | Local branch only | No public endpoint implementation found via GitHub code search. | Already local; preserve. |
| Graph-field prompt caps | PR #1494: https://github.com/abhigyanpatwari/GitNexus/pull/1494 | Open PR, small diff: adds `DEFAULT_GRAPH_FIELD_BUDGET`, `truncateText()`, and caps `INTRA_CALLS`, `OUTGOING_CALLS`, `INCOMING_CALLS`, `PROCESSES`. | Good port candidate, but only with TDD because PR has no dedicated golden/focused tests in the inspected diff. |
| Budget-aware grouping | PR #1832: https://github.com/abhigyanpatwari/GitNexus/pull/1832 | Merged upstream and already present locally via `GROUPING_TOKEN_BUDGET` / `batchedGrouping`. | No import needed. |
| Claude/Codex local CLI providers | PR #1769: https://github.com/abhigyanpatwari/GitNexus/pull/1769 | Merged upstream and already present locally. | No import needed. |
| OpenCode local CLI provider | PR #2039: https://github.com/abhigyanpatwari/GitNexus/pull/2039 | Merged upstream, not present in local wiki provider path. | Possible planned port, not automatic import; must update local auto-refresh provider-readiness policy too. |
| Fork implementation for wiki refresh | GitHub repo/code searches | No obvious public implementation found. | Nothing to import. |

#### Why Not Import Upstream Main Wholesale

- Current `origin/main` has upstream OpenCode wiki provider support, but it does not have our local auto-refresh planner/readiness/status endpoint files.
- A broad merge/rebase would combine unrelated upstream churn with local feature work and could erase or conflict with the local wiki status slice.
- The branch is intentionally a local-feature lane; import should happen as small TDD slices with explicit write sets.

#### PR #1494 Port Assessment

PR #1494 is the strongest import candidate because it directly addresses a risk that matters for auto-updating wiki:

- Current local branch has grouping prompt batching.
- Current local branch does not cap graph reference prompt fields.
- PR #1494 adds a small cap around:
  - `INTRA_CALLS`
  - `OUTGOING_CALLS`
  - `INCOMING_CALLS`
  - `PROCESSES`
- That reduces deterministic large-cluster failure risk before any recurring/unattended refresh.

Port caveat:

- Do not cherry-pick it raw.
- Add focused tests first:
  - assert oversized graph fields are truncated independently;
  - assert source truncation message remains compatible;
  - assert all four graph fields carry field-specific truncation labels;
  - assert normal small fields are unchanged.

Recommended disposition:

- If Task 2 moves toward any mutation-capable wiki refresh, do PR #1494-style graph-field caps as a preparatory TDD hardening slice.
- Keep it separate from provider policy and server/API mutation decisions.

#### PR #2039 OpenCode Port Assessment

PR #2039 is useful, but less urgent for the wiki mutation lane:

- It adds `opencode` to `LocalAgentProvider` and `LLMProvider`.
- It routes through `opencode run --format json --dir <repo> [--model ...]`.
- It parses OpenCode JSON event output.
- It preserves most environment variables but strips `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`.
- It includes review discussion around parser robustness, no read-only sandbox flag, and environment trust posture.

Local integration caveat:

- Our local `provider-readiness.ts` has a `LOCAL_PROVIDERS` set. If OpenCode is ported, this must also be updated so server status still reports OpenCode as `local-cli-provider-not-server-ready`.
- Importing OpenCode without updating readiness would create a misleading server-readiness policy.

Recommended disposition:

- Defer unless the human specifically wants OpenCode as a local wiki provider.
- If accepted, port as its own TDD slice:
  - provider union/config/model persistence;
  - local CLI invocation/parser tests;
  - provider-readiness local-provider test;
  - no server/MCP provider execution.

#### Fork Search Conclusion

No inspected public fork or adjacent repo provides a drop-in implementation for:

- wiki auto-refresh planner;
- mutation-capable wiki refresh endpoint;
- server-side wiki mutation policy;
- GitHub Wiki sync for GitNexus;
- local manual refresh wrapper around `runWikiAutoRefresh()`.

So the best route is not "import a feature"; it is:

1. use upstream PRs as reference evidence;
2. port small safety fixes where they directly reduce risk;
3. keep Task 2 implementation local and TDD-driven.

#### Recommended Next Action

Before a mutation-capable wiki refresh slice:

1. Draft the Task 2 readiness packet:
   - foreground CLI only;
   - output limited to `storagePath/wiki`;
   - no server/MCP mutation;
   - local providers only in foreground CLI;
   - no gist/GitHub Wiki/CI sync.
2. Add PR #1494-style graph-field prompt caps as a small hardening slice if MAIN approves that write set.
3. Only then implement a manual refresh wrapper or policy runbook.

Do not import code yet in the current research turn. The correct importable item is now identified, but it needs a named implementation slice and tests.

### 2026-06-07T21:10+01:00 - Fork Audit For Useful Modifications

Objective:

- Look specifically for GitNexus forks where people made modifications that may be useful to our enterprise/local-feature work.
- Filter out plain mirrors, stale forks, and README-only copies.
- Classify useful fork deltas against our feature map rather than only searching for exact wiki terms.

Objective time tracking:

- Start observed: `2026-06-07T21:10:29+01:00`.
- Status: in progress.

#### Method

- Listed recent forks from `repos/abhigyanpatwari/GitNexus/forks`.
- Compared fork default branches against upstream `abhigyanpatwari/GitNexus:main` using the GitHub compare API.
- Treated forks with `ahead_by = 0` as non-useful mirrors for this purpose.
- Inspected commit subjects and changed files for forks with `ahead_by > 0`.
- Used code search as a supplementary check, but did not rely on it alone because GitHub code-search qualifier parsing was inconsistent through `gh search code`.

#### Initial Recent-Fork Window

First 30 recent forks:

| Fork | Ahead? | Finding | Feature relevance |
| --- | ---: | --- | --- |
| `hieutt1010/GitNexus` | 2 | Commit `test`; changed only `gitnexus-web/package-lock.json`. | Not useful. |
| `ian-hailey/GitNexus` | 1 | Adds vLLM support in web LLM provider settings: `SettingsPanel`, web LLM agent/types/settings/locales. | Potential future Web UI/provider configurability reference, not current wiki/manual-refresh lane. |
| `LeoSemAcento/GitNexus` | 1 | Adds progress callbacks for heavy sequential scope-resolution phases. | Potential ingestion/progress-observability reference; not current wiki/manual-refresh lane. |
| All other first-30 forks | 0 | Behind or identical to upstream. | Not useful as modification sources. |

Second window, forks 31-60:

| Fork | Ahead? | Finding | Feature relevance |
| --- | ---: | --- | --- |
| `huangyan200/GitNexus` | 1 | Guards optional grammar query loaders for Dart/Kotlin/Swift. | Potential parser robustness reference; not a direct enterprise feature. |
| All other forks 31-60 | 0 | Behind upstream. | Not useful as modification sources. |

Third window, forks 61-100:

| Fork | Ahead? | Finding | Feature relevance |
| --- | ---: | --- | --- |
| `mieshi-laoren/GitNexus` | 1 | Adds opt-in SOFA framework extractor for RPC and SOFAMQ topic-pattern detection across group sync/extractors/config/types. | Potentially useful for future multi-repo/group contract extraction depth; not current wiki lane. |
| `adambak033/GitNexus` | 6 | Adds tRPC pattern detection, curried call detection, route extraction, Function/Const dedup, process-route linking, plus local-backend cwd auto-detection for repo-less MCP calls. | High-signal reference for PR Impact/Multi-Repo route/process precision and MCP ergonomics. Worth deeper inspection before future Task 3/4 work. |
| Most other forks 61-100 | 0 | Behind upstream. | Not useful as modification sources. |
| `alexunbrebertry/GitNexus` | compare failed | GitHub compare API returned 404. | Needs retry only if later evidence suggests relevance. |

#### Interim Useful-Fork Candidates

| Candidate | Why it may help | Import posture |
| --- | --- | --- |
| `adambak033/GitNexus` | Touches tRPC route extraction, process-route linking, TypeScript captures, parse worker, and MCP local-backend cwd auto-detection. These map to PR Impact route evidence and multi-repo/repo-selection ergonomics. | Inspect deeply before any import. Likely reference/port candidates, not blind merge. |
| `mieshi-laoren/GitNexus` | Adds SOFA RPC/MQ extraction to group sync. This maps to multi-repo contract extraction depth. | Reference candidate for future multi-repo improvements, not current wiki task. |
| `ian-hailey/GitNexus` | Adds vLLM provider support in web settings. | Possible future provider configurability reference, but not local CLI/server wiki policy. |
| `LeoSemAcento/GitNexus` | Adds progress callbacks to heavy ingestion phases. | Possible observability/performance reference, not current feature queue. |
| `huangyan200/GitNexus` | Optional grammar query loader guard. | Possible parser-hardening reference, not feature-priority. |

#### Interim Synthesis

- No recent ahead fork found so far implements wiki auto-refresh, server-side wiki mutation, or a manual refresh wrapper.
- The strongest useful fork so far is `adambak033/GitNexus`, but it is useful for route/process extraction and MCP ergonomics, not wiki refresh.
- The strongest wiki-specific import candidate remains upstream PR #1494, not a fork.

Next audit step:

- Inspect `adambak033/GitNexus` diff more deeply because it touches features that support PR Impact / Blast Radius and Multi-Repo Support Improvements.
- Then inspect `mieshi-laoren/GitNexus` for group-contract extraction relevance.

#### Deeper Inspection Of Useful Fork Candidates

Fetched fork refs for read-only local diff inspection:

- `forks/adambak033/main`
- `forks/mieshi-laoren/main`
- `forks/ian-hailey/main`
- `forks/LeoSemAcento/main`

These fetches did not change the working branch.

##### `adambak033/GitNexus`

Diff shape:

- 12 files changed.
- 393 insertions, 12 deletions.
- No test files in the inspected diff.

Main changes:

- Adds `gitnexus/src/core/ingestion/route-extractors/trpc.ts`.
- Adds tRPC procedure extraction for `.query()`, `.mutation()`, and `.subscription()`.
- Maps procedures to synthetic `/trpc/<path>` routes with:
  - `GET` for query,
  - `POST` for mutation,
  - `WS` for subscription.
- Adds TypeScript HOC-in-pair captures so patterns like `create: procedure.mutation(async () => ...)` become named function declarations instead of anonymous file-level calls.
- Adds curried/chained call capture for patterns like `workflow(db)(input)`.
- Adds Function/Const dedup for arrow/function-valued variable declarators.
- Improves process-route linking by matching route `(filePath, methodName)` before falling back to file-only.
- Adds MCP local-backend cwd auto-detection when multiple repos are registered and no explicit repo parameter is supplied.

Why it matters:

- This is directly relevant to PR Impact / Blast Radius because route evidence and process attribution are central to a useful PR impact report.
- It is also relevant to Multi-Repo Support Improvements because cwd-based repo selection reduces agent friction when multiple repos are indexed.
- It is not directly relevant to wiki manual refresh.

Risks / caveats:

- No tests were present in the inspected diff.
- The tRPC extractor uses regex heuristics and file-path heuristics (`/routers/`, `/trpc/`, `/server/`), so a port would need fixture coverage before trusting it.
- Process-route linking changes graph semantics; this could improve precision but needs regression tests for existing route/process behavior.
- Cwd auto-detection may be valuable, but our local multi-repo guidance already says explicit repo selection matters when ambiguous.

Import posture:

- Do not import now.
- Mark as high-signal reference for a future Task 4/Task 3 readiness slice:
  - `Task 4`: route-aware PR Impact improvements.
  - `Task 3`: MCP repo selection ergonomics.
- If ported later, use TDD and split into at least two slices:
  1. tRPC route/process precision;
  2. cwd repo auto-detection.

##### `mieshi-laoren/GitNexus`

Diff shape:

- 9 files changed.
- 246 insertions, 7 deletions.
- No test files in the inspected diff.

Main changes:

- Adds `gitnexus/src/core/group/extractors/sofa-extractor.ts`.
- Adds opt-in `detect.sofa` config defaulting to false.
- Extracts SOFA RPC contracts from XML:
  - `<sofa:service interface="...">` plus `sofa:binding.tr` as provider.
  - `<sofa:reference interface="...">` as consumer.
- Extends Java topic patterns for SOFAMQ/OpenMessaging:
  - `consumer.subscribe(topic, tag, listener)` as topic consumer.
  - `new Message(topic, tag, body)` as topic provider.
- Registers the extractor in group sync.

Why it matters:

- This is relevant to Multi-Repo Support Improvements where group sync and service-contract extraction become deeper.
- It is domain-specific but useful as an example of opt-in enterprise framework extraction.

Risks / caveats:

- No tests were present in the inspected diff.
- It adds package changes and a regex XML extractor.
- SOFA is a domain-specific enterprise framework; it should not enter our current generic local-feature tranche unless we explicitly prioritize enterprise Java/SOFA ecosystems.

Import posture:

- Do not import now.
- Keep as reference for future group-contract extraction architecture:
  - opt-in detector flag,
  - extractor registration point,
  - confidence/meta shape,
  - XML-plus-code pattern split.

##### `ian-hailey/GitNexus`

Diff shape:

- 7 web files changed.
- 200 insertions, 4 deletions.

Main changes:

- Adds vLLM as a Web UI LLM provider.
- Adds base URL, model fetching via `/models`, optional API key, provider settings, and localization strings.

Why it matters:

- Useful for future Web UI provider configurability.
- Possibly relevant if we later expose local/self-hosted model choices in the UI.

Import posture:

- Do not import now.
- Not relevant to current CLI/server wiki policy.

##### `LeoSemAcento/GitNexus`

Diff shape:

- 2 ingestion pipeline files changed.
- 24 insertions.

Main changes:

- Adds progress callbacks to heavy sequential scope-resolution phases.

Why it matters:

- Potential observability/performance UX reference for long-running analyze work.
- Not directly tied to the current wiki/manual refresh decision.

Import posture:

- Do not import now.
- Potential reference for future Auto-Reindexing observability.

#### Top-Star Fork Pass

The top-star fork check surfaced older but useful forks:

| Fork | Ahead? | Finding | Feature relevance |
| --- | ---: | --- | --- |
| `nxpatterns/gitnexus` | 0 | Top-star fork, but behind upstream with no ahead commits. | No importable modifications. |
| `nantas/GitNexus` | 514 | Major divergent Unity/rule-lab/eval fork with large rule-driven runtime verification, skills, reports, and E2E material. | Useful methodology/eval reference for regression forensics, E2E, and language/framework-specific verification. Not drop-in. |
| `Trenza1ore/GitNexus-Cangjie` | 3 | Experimental Cangjie language support with parser/config/provider/query/import/type extraction and fixtures. | Useful language-onboarding reference for future OCaml/language work. Not current wiki. |
| `renatobardi/GitNexus` | 14 | Deep wiki documentation plus Oracle Cloud ARM deployment/systemd/nginx/CI deployment scripts. | Useful deployment/runbook reference. Not current local-feature implementation. |
| `brukcodes/GitNexus` | 1 | Fixes filename language detection and syntax-highlighting path parsing with a unit test. | Possible small parser/UI correctness reference. |
| `cyberblicc-sketch/GitNexus` | 5 | Adds MoneyPrinterX Advanced eval/case material, sample queries, wiki prompt pack, and demo walkthrough. | Useful eval/wiki-prompt methodology reference, not implementation. |

#### Fork Audit Synthesis

- Yes, there are forks with useful modifications.
- No inspected fork provides a drop-in implementation for:
  - auto-updating wiki mutation,
  - manual refresh wrapper,
  - server-side wiki mutation endpoint,
  - GitHub Wiki sync,
  - or a PR Impact product equivalent.
- The useful forks map mostly to adjacent lanes:
  - `adambak033/GitNexus`: PR Impact route/process precision and MCP repo ergonomics.
  - `mieshi-laoren/GitNexus`: Multi-Repo/group contract extraction depth.
  - `nantas/GitNexus`: regression/eval methodology and long-running verification artifacts.
  - `Trenza1ore/GitNexus-Cangjie`: language support methodology.
  - `renatobardi/GitNexus`: deployment/runbook patterns.

Updated recommendation:

- For the current Task 2 wiki/manual-refresh lane:
  - do not import fork code;
  - use upstream PR #1494 as the only near-term port candidate, because it directly reduces wiki large-repo prompt risk.
- For later Task 4 PR Impact:
  - inspect `adambak033/GitNexus` in a dedicated readiness pass before route/API impact improvements.
- For later Task 3 Multi-Repo:
  - inspect `mieshi-laoren/GitNexus` before group contract extraction improvements.
- For later regression/eval planning:
  - use `nantas/GitNexus` as methodology/reference material, not code to merge.

Open caveat:

- The fork universe is very large, so this is not mathematically exhaustive.
- It is a decision-grade sample across recent forks, actually-ahead forks in the recent window, and top-star forks.
- Future agents should re-run targeted compare searches before importing anything from forks.

### 2026-06-07T21:20+01:00 - Fork Evaluation / Test Methodology

Problem:

- Some forks contain useful modifications.
- Importing fork code directly risks mixing unrelated work, stale assumptions, missing tests, and divergent architecture into the local feature branch.
- We need a repeatable method for testing whether a fork idea is worth porting.

Core rule:

- Test the behavior, not the fork.
- Treat a fork as a hypothesis source and reference implementation, not as an authority.
- Port only the smallest useful behavior into our branch after local tests define the expected outcome.

#### Methodology

1. Identify the candidate behavior.

   Record:

   - source fork / PR / commit;
   - changed files;
   - claimed behavior;
   - which GitNexus feature lane it supports;
   - whether it is generic product behavior or domain-specific behavior.

2. Classify the import posture.

   Use one of:

   | Posture | Meaning | Example |
   | --- | --- | --- |
   | `reference-only` | Useful idea, not ready or not in scope to port. | `mieshi-laoren` SOFA extractor while Task 2 wiki is active. |
   | `TDD-port candidate` | Useful behavior, but port must start with local failing tests. | PR #1494 graph-field wiki prompt caps. |
   | `research-before-port` | Useful but architecture/security implications are unclear. | `adambak033` MCP cwd repo auto-detection. |
   | `reject` | Not relevant, stale, untested, or harmful. | Package-lock-only fork changes. |
   | `upstream-sync candidate` | Already merged upstream and worth bringing in through a planned rebase/merge. | OpenCode provider only if MAIN wants that provider locally. |

3. Define the local acceptance test before importing.

   The test must fail on our current branch for the right reason.

   Examples:

   - For PR #1494 graph-field caps:
     - create an oversized graph-reference field fixture;
     - assert `INTRA_CALLS`, `OUTGOING_CALLS`, `INCOMING_CALLS`, and `PROCESSES` are independently truncated;
     - assert small fields remain unchanged;
     - assert truncation labels identify the field.

   - For `adambak033` tRPC extraction:
     - create a tRPC router fixture with query/mutation/subscription procedures;
     - assert routes map to `/trpc/<path>`;
     - assert method names link to the correct process entry;
     - assert unrelated object call pairs are not falsely treated as tRPC routes.

   - For `mieshi-laoren` SOFA extraction:
     - create XML provider/reference fixtures;
     - assert contracts are opt-in only via `detect.sofa`;
     - assert provider/consumer roles and confidence metadata;
     - assert non-SOFA XML is ignored.

4. Port the minimum behavior.

   Allowed:

   - copy/adapt the smallest relevant functions;
   - preserve local architecture and naming;
   - add local tests near existing test patterns;
   - split unrelated fork ideas into separate slices.

   Not allowed:

   - wholesale merge a fork;
   - import unrelated package-lock churn;
   - import generated docs or local machine paths as product code;
   - take behavior without tests;
   - silently broaden scope from one feature lane to another.

5. Verify locally.

   Minimum verification:

   - targeted tests for the imported behavior;
   - adjacent tests for the touched subsystem;
   - `npm run build` or typecheck when TypeScript surfaces change;
   - `git diff --check`;
   - source diff review for unrelated fork artifacts.

6. Decide disposition.

   After testing:

   - `adopt`: behavior passes, scope is clean, tests are durable;
   - `revise`: behavior useful but needs redesign;
   - `defer`: useful but not current lane;
   - `reject`: fails tests, too broad, too risky, or stale.

7. Record the outcome.

   Update the scratchpad or feature map with:

   - candidate source;
   - tests added;
   - command results;
   - imported files/functions;
   - reasons for adoption/defer/reject;
   - any remaining risks.

#### Scoring Rubric

Before porting, score each candidate:

| Criterion | Question | Weight |
| --- | --- | --- |
| Feature alignment | Does it support an active or near-term feature lane? | High |
| Behavioral clarity | Can we state exact expected behavior? | High |
| Testability | Can we make a small failing test locally? | High |
| Scope size | Can it be ported without broad merge churn? | High |
| Safety | Does it avoid secrets, network writes, GitHub tokens, or server mutation? | High |
| Upstream status | Is it merged upstream, open PR, or independent fork-only? | Medium |
| Maintenance | Does it fit existing local patterns? | Medium |
| Domain specificity | Is it generally useful or tied to one enterprise framework? | Medium |

Recommended threshold:

- Only port when feature alignment, behavioral clarity, testability, and scope size are all strong.
- If any high-weight criterion is weak, keep the fork as reference-only until a later readiness pass.

#### Current Candidate Dispositions

| Candidate | Current disposition | Reason |
| --- | --- | --- |
| PR #1494 graph-field wiki caps | `TDD-port candidate` | Directly reduces wiki large-repo prompt risk; small code delta; should be tested locally before port. |
| `adambak033` tRPC route/process changes | `research-before-port` | Strong for PR Impact route evidence, but touches graph semantics and lacks tests. |
| `adambak033` MCP cwd repo auto-detection | `research-before-port` | Ergonomic for multi-repo agents, but ambiguity rules must be tested against current repo-selection policy. |
| `mieshi-laoren` SOFA extractor | `reference-only` | Useful opt-in enterprise extraction pattern, but domain-specific and not current lane. |
| `ian-hailey` vLLM Web UI provider | `reference-only` | Useful for future web provider settings, not current CLI/server wiki policy. |
| `LeoSemAcento` progress callbacks | `reference-only` | Potential observability idea for analyze/reindex, not current feature slice. |
| `nantas` Unity/rule-lab/eval fork | `reference-only` | Strong methodology/eval material, too divergent for code import. |
| `Trenza1ore` Cangjie support | `reference-only` | Good language-porting reference, not OCaml code and not current lane. |

#### Practical Next Step

If MAIN wants to test/import something now, the safest first fork/PR-derived experiment is:

```text
Task 2 hardening slice:
Port PR #1494-style graph-field prompt caps into WikiGenerator using TDD.
```

Suggested local TDD order:

1. Add a failing unit test that forces oversized formatted graph fields into `generateLeafPage` prompt assembly.
2. Assert field-specific truncation labels and unchanged small fields.
3. Add the smallest `truncateText()` / graph-field cap implementation.
4. Run focused wiki tests plus build/typecheck.
5. Record whether this becomes a prerequisite for any manual/auto wiki refresh mutation.

### 2026-06-07T21:20+01:00 - Source-Backed Software Engineering Methodology Block

Objective:

- Research software development / software engineering methodology for how we should evaluate GitNexus forks, PRs, and feature implementations.
- Convert the research into an operational method for this long-horizon workstream.
- Avoid vague labels like "Agile" unless they become concrete rules we can verify.

Objective time tracking:

- Start observed before context compaction: `2026-06-07T21:20:28+01:00`.
- Continuation observed after context compaction: `2026-06-07T21:24:14+01:00`.
- Source-review checkpoint: `2026-06-07T21:26:59+01:00`.
- Documentation/checkpoint timestamp: `2026-06-07T21:28:48+01:00`.
- Mode: focused source synthesis block, not exhaustive methodology survey.

Skills / local workflow references used:

- `autoresearch`: used lightly for a research loop shape: source discovery, synthesis, and durable notes.
- Superpowers `test-driven-development`: used as the local implementation discipline reference for behavior changes.
- Superpowers `verification-before-completion`: used as the local completion gate reference.

#### Source Matrix

| Source | Type | What it contributes to our method |
| --- | --- | --- |
| https://agilemanifesto.org/ and https://agilemanifesto.org/principles.html | Primary methodology source | Agile's useful core for this project is not ceremony; it is frequent working software, responding to change, simplicity, technical excellence, and regular reflection. |
| https://martinfowler.com/bliki/TestDrivenDevelopment.html | Primary practitioner source | TDD means write the next test, make it pass, then refactor; Fowler also stresses writing a list of test cases first and using sequencing to drive design. |
| https://www.informit.com/articles/article.aspx?p=359417 | Michael Feathers / legacy-code excerpt | Existing code is hard to test after the fact; designing for testability and getting legacy behavior under tests is the safety path before risky changes. |
| https://en.wikipedia.org/wiki/Characterization_test | Secondary but concise definition | Characterization/golden-master tests document observed behavior so changes can detect unintended behavior drift. Useful for current GitNexus behavior before ports. |
| https://dora.dev/capabilities/working-in-small-batches/ | DORA / Google Cloud research capability | Small batches reduce feedback time, are especially important with AI coding, and should be independent, valuable, small, and testable. |
| https://dora.dev/capabilities/continuous-integration/ | DORA capability | CI depends on small batches, automated tests, quick feedback, and immediate repair of broken builds. |
| https://dora.dev/capabilities/continuous-delivery/ | DORA capability | Continuous delivery is supported by test automation, CI, trunk-based development, and continuous testing. |
| https://google.github.io/eng-practices/review/developer/small-cls.html | Google engineering practice | Small changes are easier to review, less likely to introduce bugs, simpler to roll back, and should include related tests. |
| https://docs.github.com/en/get-started/using-github/github-flow | GitHub workflow docs | Branches are safe workspaces; commits should be isolated complete changes; unrelated changes normally deserve separate branches. For this project, the human-selected single branch means unrelated feature work must not overlap. |
| https://martinfowler.com/bliki/BranchByAbstraction.html | Migration pattern | Large replacements should be made gradually through an abstraction, with multiple implementations coexisting and tests proving equivalence where practical. |
| https://martinfowler.com/articles/feature-toggles.html | Delivery / safety pattern | Feature toggles can hide incomplete code paths, but they add complexity and must be constrained. Use only when a feature genuinely needs opt-in/dark-launch behavior. |
| https://martinfowler.com/bliki/StranglerFigApplication.html | Modernization pattern | Prefer gradual replacement/addition over wholesale rewrite when existing behavior is hard to fully specify. |
| https://adr.github.io/ | ADR reference hub | ADRs capture a single significant decision, its rationale, tradeoffs, and consequences. |
| https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/welcome.html and https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html | ADR process guidance | ADRs avoid repeated decision churn; accepted ADRs form a decision log and should be superseded by new ADRs rather than silently rewritten. |
| https://framework.scaledagile.com/spikes | Agile/XP spike guidance | Spikes are time-boxed research/prototype activities used to reduce uncertainty before implementation. |
| https://developers.openai.com/codex/use-cases/follow-goals | OpenAI Codex docs | Codex goals are for long-running work with a verifiable stopping condition. This supports one feature goal at a time once readiness is established. |
| https://developers.openai.com/codex/noninteractive | OpenAI Codex docs | Non-interactive Codex can run with explicit sandbox permissions and machine-readable output; use least privilege for automation. |
| https://developers.openai.com/codex/workflows | OpenAI Codex docs | Codex works best with explicit context and a clear definition of done. |
| https://developers.openai.com/blog/run-long-horizon-tasks-with-codex | OpenAI Codex blog | Long-horizon Codex work needs persistent focus, verification, and repair loops; our four-file bundle plus scratchpad supports that. |

#### Synthesis

Adopt this method for GitNexus local enterprise features:

```text
Evidence-Gated Small-Batch Porting

source evidence -> local behavior characterization -> failing test -> minimal implementation -> focused verification -> checkpoint/decision record
```

This is the better route than either of the extremes:

- not blind fork merging;
- not endless research without writing tests;
- not "one big enterprise-feature implementation";
- not treating an upstream/fork diff as authoritative merely because it exists.

#### Operational Rules For This Workstream

1. Research before implementation when the behavior is not locally obvious.

   Use a spike when there is uncertainty about intended behavior, local source ownership, or safe implementation shape. The spike must produce a decision, a test plan, or a defer/reject verdict.

2. Characterize current behavior before changing shared subsystems.

   For wiki generation, graph extraction, impact analysis, group sync, route extraction, and language parsing, first add a characterization or golden-file fixture when existing behavior could be accidentally disturbed.

3. Use TDD for each behavior-changing slice.

   The local rule stays:

   ```text
   failing test -> verify red -> minimal green -> verify green -> refactor -> verify again
   ```

   Tests-after are allowed only for pure documentation, mechanical formatting, or explicitly throwaway spikes that are not kept.

4. Keep batches small even on the one shared branch.

   The project decision is one shared branch: `local/gitnexus-local-features`.

   That is compatible with DORA/GitHub/Google small-batch guidance only if:

   - one feature is active at a time;
   - each commit is an isolated complete change;
   - unrelated feature work does not overlap;
   - every slice has a test/checkpoint before moving on.

5. Prefer gradual migration patterns for broad changes.

   If a feature wants to replace an existing path, prefer a wrapper, adapter, branch-by-abstraction, or opt-in path over a broad rewrite. Use feature toggles only when opt-in behavior is genuinely needed and retire them when no longer useful.

6. Record significant decisions.

   Use the long-horizon bundle for normal decisions. If a decision has architectural consequences across later tasks, promote it to a short ADR-style note or a clear decision section in `documentation.md`.

7. Verify before completion.

   No feature or slice is complete until fresh verification evidence exists:

   - targeted test or golden-file check;
   - adjacent subsystem tests when graph/parser/wiki behavior is touched;
   - `git diff --check`;
   - build/typecheck when TypeScript public surfaces or shared types change;
   - scratchpad/documentation update with commands and outcomes.

#### Fork / PR Evaluation Method Update

For every candidate fork, PR, or external implementation:

1. Treat it as a hypothesis source.
2. Extract the smallest behavior claim.
3. Decide import posture:
   - `reference-only`
   - `spike`
   - `TDD-port candidate`
   - `reject`
   - `upstream-sync candidate`
4. Write the local failing test before porting retained code.
5. Port only the minimum implementation needed to satisfy the test.
6. Run focused and adjacent checks.
7. Record adopt/revise/defer/reject with evidence.

This means:

- PR #1494 remains a strong `TDD-port candidate` for wiki graph-field caps.
- `adambak033/GitNexus` remains a `spike` / `research-before-port` candidate for route/process precision and MCP repo ergonomics.
- `mieshi-laoren/GitNexus` remains `reference-only` unless Multi-Repo group-contract depth becomes active.
- `nantas/GitNexus` remains methodology/eval reference, not importable implementation.

#### Stop Rules

Stop and re-research or ask MAIN to decide when:

- we cannot state the behavior in a testable sentence;
- the proposed slice cannot be made small;
- current behavior cannot be characterized and the blast radius is shared;
- the port requires broad merge churn;
- a fork/PR changes package locks, generated files, or unrelated subsystems without clear need;
- a feature needs tokens, SaaS posting, GitHub Actions mutation, hooks, or hidden background behavior;
- the test cannot be made to fail for the right reason.

#### Immediate Impact On Feature Order

This methodology supports the current task order:

1. Wiki hardening / manual refresh planning first, because source ownership is mapped and the likely first import candidate can be tested with a small wiki fixture.
2. Multi-Repo improvements after a separate spike if they rely on group-contract extraction or repo-selection policy.
3. PR Impact after route/process/diff-to-symbol behavior is specified with golden reports.
4. Larger automation, generated tests, regression forensics, and OCaml only after their own readiness spikes.

The practical next implementation candidate remains:

```text
Task 2 hardening slice:
Port PR #1494-style graph-field prompt caps into WikiGenerator using TDD.
```

No source implementation is implied by this methodology note alone; it defines how the next authorized implementation slice should proceed.

### 2026-06-07T21:42+01:00 - Pre-Research Planning Note: Agent Endurance Is Not Drift Immunity

User prompt:

- MAIN observed that autonomous agents are mediated by computation and are not biologically susceptible to fatigue.
- MAIN also noted that considerable work has already happened and asked whether the best route is to plan end-to-end and conduct premortems as needed.
- Requested research focus: best way to plan end-to-end using Codex, how to plan in sufficient depth, and how to keep the plan from drifting while still leaving it agile enough to adapt.

Working distinction recorded before the forum/methodology research block:

- The premise is directionally right: autonomous agents do not get physically tired in the human sense.
- The operational risk is different: agents can still drift, lose context, overfit to stale assumptions, loop on weak evidence, or keep pushing after verification says stop.
- Therefore the control problem is not fatigue management; it is state, scope, evidence, and stop-rule management.

Initial planning synthesis to verify through research:

```text
Plan the whole journey at the map/risk/gate level.
Plan only the next selected slice at executable step-by-step detail.
After each slice, checkpoint evidence and update the map before continuing.
```

Implications for this GitNexus workstream:

1. Keep the end-to-end feature map visible for all enterprise/local features.
2. Keep WIP to one selected implementation feature at a time on the shared branch.
3. Require readiness/research before implementation when behavior, security, mutation, or source ownership is uncertain.
4. Use premortems for policy-heavy or mutation-heavy slices before editing source.
5. Use TDD for behavior changes once the slice is approved and sufficiently mapped.
6. Verify before claiming completion, and document commands/outcomes in the long-horizon bundle.
7. Treat scratchpads as evidence and synthesis, not as authority over `plans.md`, `feature-map.md`, or `documentation.md`.

Research block opened at `2026-06-07T21:42:43+01:00`.

### 2026-06-07T21:52+01:00 - Forum And Methodology Research Block: Practical Software Development Methodology For Agentic GitNexus Work

Objective timing:

- Start: `2026-06-07T21:42:43+01:00`
- Checkpoint/end: `2026-06-07T21:54:00+01:00`
- Duration: approximately 11 minutes 17 seconds of focused source discovery plus synthesis.

Research question:

- What software development methodology should guide autonomous Codex work on the remaining GitNexus local enterprise-feature slices?
- How do we plan end-to-end without freezing the plan too early?
- How do we keep the plan agile enough to adapt without drifting or becoming discombobulated?

#### Source Classes Checked

Official / primary methodology sources:

| Source | Link | Useful signal |
| --- | --- | --- |
| OpenAI Codex long-horizon task guidance | https://developers.openai.com/blog/run-long-horizon-tasks-with-codex | Long-running Codex work needs durable task context and checkpoints, not just repeated prompts. |
| OpenAI Codex goals | https://developers.openai.com/codex/use-cases/follow-goals | Goals are useful when completion can be tied to concrete evidence and a stopping condition. |
| OpenAI Codex workflows | https://developers.openai.com/codex/workflows | Codex work benefits from explicit context, verification surfaces, and repeatable workflows. |
| OpenAI AGENTS.md guide | https://developers.openai.com/codex/guides/agents-md | Stable repo-wide rules belong in project instructions loaded before task execution. |
| Agile Manifesto principles | https://agilemanifesto.org/principles.html | Prefer early/continuous delivery, responsiveness to change, simplicity, and regular reflection. |
| Scrum Guide 2020 | https://scrumguides.org/scrum-guide.html | Scrum's useful core is empiricism: transparency, inspection, adaptation, one objective at a time, Definition of Done, and small plans for selected work. |
| Kanban Guide 2025 | https://kanbanguides.org/the-kanban-guide/2025.5/ | Useful for visualizing flow and limiting WIP; less ceremony-heavy than sprint-centered planning. |
| DORA small batches | https://dora.dev/capabilities/working-in-small-batches/ | Small batches reduce integration/review risk; especially relevant when AI can produce large diffs quickly. |
| Google small CLs | https://google.github.io/eng-practices/review/developer/small-cls.html | Reviewability improves when changes are small, coherent, and separately understandable. |
| Martin Fowler TDD | https://martinfowler.com/bliki/TestDrivenDevelopment.html | TDD is a disciplined feedback loop: test first, make it pass, refactor. |
| Martin Fowler Branch by Abstraction | https://martinfowler.com/bliki/BranchByAbstraction.html | Broad changes should be migrated gradually when direct replacement is risky. |
| Basecamp Shape Up | https://basecamp.com/shapeup | Useful concepts: shape work before building, set appetite/bounds, and avoid endless open-ended implementation. |
| Premortem guidance | https://www.atlassian.com/team-playbook/plays/pre-mortem and https://hbr.org/2007/09/performing-a-project-premortem | Assume failure in advance to expose risks and convert them into mitigations. |
| Trunk-based development / continuous integration commentary | https://www.atlassian.com/continuous-delivery/continuous-integration/trunk-based-development | Reinforces small, frequent, tested integration; relevant because this workstream uses one shared branch. |

Forum / practitioner field reports:

| Source | Link | Field-report signal |
| --- | --- | --- |
| Reddit ExperiencedDevs on large / AI-heavy PR review | https://www.reddit.com/r/ExperiencedDevs/comments/1tbqunh/first_time_in_a_position_reviewing_pull_requests/ | Experienced reviewers strongly prefer small, well-defined PRs; large AI-heavy diffs become hard to review safely. |
| Reddit ExperiencedDevs on good code review | https://www.reddit.com/r/ExperiencedDevs/comments/vsyeje | Repeated field signal: tests and automation should catch correctness/style; code review should focus on design, maintainability, and test quality. |
| HN on long vibe-coded PRs | https://news.ycombinator.com/item?id=45744209 | Field reports caution that agent-generated code can shift cost from writing to review; reviewability must be designed before generation. |
| HN on productive Claude Code use | https://news.ycombinator.com/item?id=47494890 | Useful field signal: decomposition makes AI-generated work more reviewable because the expected shape is known before code appears. |
| Reddit Agile on Scrum/Kanban | https://www.reddit.com/r/agile/comments/1fe9g44 | Practitioners often recommend starting from visible flow and continuous improvement rather than blindly adopting ceremony. |
| Reddit Agile methodology discussion | https://www.reddit.com/r/agile/comments/1r4vnq1/what_are_the_methodologies_you_mostly_use_in/ | Agile is treated by practitioners as a mindset; XP/TDD/Lean/Kanban practices are often more actionable than framework labels. |
| Software Engineering SE on Agile and planning | https://softwareengineering.stackexchange.com/questions/249972/is-it-true-use-agile-methodology-results-less-planning | Good agile practice is not "less planning"; it is planning at the right horizon and revising from evidence. |
| Software Engineering SE on adapting Scrum toward Kanban | https://softwareengineering.stackexchange.com/questions/229879/how-can-scrum-be-adapted-to-a-volunteer-setting | Useful for our single-agent/shared-branch situation: ordered backlog, WIP limits, clear done state, and fewer ceremonies can still preserve agility. |
| Reddit ExperiencedDevs on trunk-based development and large features | https://www.reddit.com/r/ExperiencedDevs/comments/1sxt1zu/is_trunk_based_development_a_wrong_choice_in_the_iot_context/ and https://www.reddit.com/r/ExperiencedDevs/comments/1arr585/how_do_you_actually_implement_small_prs_for_a_large_feature_any_tips_for_making_this_more_efficient/ | Field reports support small PR/slice discipline while acknowledging that large features sometimes need a feature-lane or staged release boundary. |

#### Forum Synthesis

The forums do not converge on a single named methodology. They converge on constraints:

- Avoid large, hard-to-review changes, especially when AI/agents can generate code quickly.
- Avoid ceremony for ceremony's sake.
- Keep work visible and ordered.
- Limit WIP.
- Require tests and automated checks before review/completion claims.
- Use design/planning before big work, but do not turn future unknowns into fake certainty.
- Split work into coherent slices before writing code, not after the diff has already sprawled.

Negative forum evidence:

- Scrum is frequently criticized when it becomes estimation theater, sprint pressure, or waterfall with more meetings.
- Kanban is frequently favored for reactive/maintenance work, but only if WIP limits and definition-of-done discipline are real.
- AI-generated code increases the need for small slices and reviewable structure; it does not remove the need for engineering judgment.
- Trunk-style or shared-branch development is not the same as uncontrolled merging. The forum and CI/CD sources both assume strong tests, small changes, and explicit release/feature boundaries.

#### Recommended Methodology For GitNexus

Use a hybrid that is explicit but lightweight:

```text
Evidence-Gated Small-Batch Kanban + TDD + Premortem
```

Meaning:

1. Kanban for flow:
   - keep one selected task active;
   - keep the queue visible in `plans.md`;
   - use `documentation.md` as the checkpoint authority;
   - avoid unrelated WIP on the shared branch.

2. Shape Up style shaping for uncertain work:
   - define appetite and boundaries before building;
   - decide what is out of scope;
   - do not build from vague enterprise-feature labels.

3. Agile empiricism:
   - inspect actual local code and behavior;
   - adapt the plan after each verified slice;
   - do not pretend future implementation details are known before source ownership and tests are mapped.

4. TDD for behavior changes:
   - failing test first;
   - verify red;
   - minimal green;
   - verify;
   - refactor only while tests stay green.

5. Premortems for risky slices:
   - mandatory for mutation, provider execution, GitHub tokens, CI/workflow changes, generated tests, background automation, and broad parser/resolver work.

6. ADR / decision capture when consequences persist:
   - normal task decisions go in `documentation.md`;
   - cross-feature architecture or policy decisions should get an ADR-style note or a clearly marked decision block.

7. Shared-branch discipline:
   - the current one-branch decision is workable only if we keep slices small, verified, and checkpointed;
   - if a slice needs dormant or broad feature work, use an explicit feature boundary in the plan rather than quietly blending it with unrelated tasks.

#### Planning Depth Rule

Plan now in three layers:

| Layer | Depth now | Purpose |
| --- | --- | --- |
| End-to-end feature map | Deep enough now | Maintain sequence, dependencies, gates, risk model, and deferred boundaries. |
| Next selected task | Decision-complete now | Exact goal shape, write set, source ownership, tests, stop rules, and premortem. |
| Later implementation details | Light now | Keep as hypotheses until readiness evidence exists. |

This resolves the tension between deep planning and agility:

- Deep plan the route and controls.
- Shallow plan the unknown internals.
- Deep plan the next slice only when it becomes active.

#### Premortem Template For Each Selected Task

Before source edits on a risky slice, answer:

| Prompt | Required answer |
| --- | --- |
| It is later and this failed. What happened? | Concrete failure story. |
| What early warning would have shown this? | Log, test, diff pattern, stale doc, or ambiguity signal. |
| How do we prevent it? | Boundary, test, dry-run, fixture, policy, or smaller slice. |
| How do we detect it before completion? | Command/check/review artifact. |
| What is the recovery action? | Revert, defer, redesign, or MAIN decision. |
| What is the stop rule? | Exact condition that blocks autonomous continuation. |

Current GitNexus premortem seed list:

- Wiki mutation writes generated docs to the wrong place.
- Wiki provider execution burns tokens, requires secrets, or mutates state unexpectedly.
- GitHub PR automation comments on the wrong PR or handles forked PRs unsafely.
- Generated E2E tests become brittle snapshots of mocked behavior rather than useful tests.
- OCaml scope grows from experimental captures into full Dune/PPX/module-resolution work without approval.
- Multi-repo docs/tooling drift from actual CLI/MCP behavior.
- The shared branch accumulates unrelated feature WIP and becomes hard to reason about.
- An agent keeps going after stale graph/index evidence, failed verification, or unclear source ownership.

#### Concrete Rule To Promote Into Planning Docs Later

Recommended durable rule:

```text
For GitNexus local enterprise-feature work, use Evidence-Gated Small-Batch Kanban:
one selected task at a time, shaped before implementation, premortemed when risky,
implemented with TDD when behavior changes, verified before completion, and
checkpointed before the next task starts.
```

This should eventually be reflected compactly in:

- `AGENTS.md` for stable workflow rule;
- `plans.md` for queue operation;
- `documentation.md` for checkpoint policy;
- `feature-map.md` for feature dependency/status mapping.

Do not copy this whole scratchpad block into the control files. Promote only the compact rule and any specific decisions MAIN accepts.

### 2026-06-07T22:03+01:00 - Reconciliation Of ChatGPT / Claude Methodology Notes

Input:

- MAIN provided three pasted methodology notes:
  - first pasted text: ChatGPT synthesis on agentic coding methodology;
  - second pasted text: Claude synthesis on agentic coding / agentic engineering;
  - third pasted text: additional agentic-engineering architecture and production-practice summary.

Status of these inputs:

- Treat as secondary synthesis, not primary evidence.
- Do not copy their claims into control docs unless independently source-checked or already corroborated by prior research.
- Use them to identify convergence, gaps, and useful wording for the GitNexus workflow.

#### Convergence With Current GitNexus Methodology

The pasted notes strongly align with the current scratchpad conclusion:

```text
Evidence-Gated Small-Batch Kanban + TDD + Premortem
```

Shared points:

| Theme | Pasted-note signal | GitNexus consequence |
| --- | --- | --- |
| Spec-first / issue-first | Agents work better from clear goal, scope, constraints, acceptance criteria, and done definition. | Keep selected-task packets explicit before source work. |
| Explore before editing | Agents should inspect repo structure, patterns, tests, and conventions before coding. | Preserve readiness/research before implementation, especially for policy-heavy slices. |
| Plan before code | Plan files/checklists reduce drift and survive context loss. | Keep `plans.md`, `feature-map.md`, and `documentation.md` authoritative. |
| Small diffs | Large AI-generated changes shift cost into review. | Keep one selected task and small verified slices on `local/gitnexus-local-features`. |
| Verification gates | Tests/lint/typecheck/build/review are the real completion surface. | No completion claim without fresh verification evidence. |
| Fresh review | A separate reviewer or fresh context catches implementer assumptions. | Use review passes before broad or risky feature promotion. |
| TDD with caution | TDD helps when tests are controlled; agent-generated tests can be weakened or misleading. | Use TDD for behavior changes, but review tests as first-class artifacts. |
| Context files | `AGENTS.md` / repo instructions help when short, current, and operational. | Keep `AGENTS.md` compact; do not dump scratchpad material into it. |
| Human architecture gate | Humans should retain architecture/security/product decisions. | MAIN approvals remain required for mutation, tokens, CI, provider execution, and broad semantics. |

#### Useful Additions From The Pasted Notes

1. Verification bottleneck framing.

   The pasted notes repeatedly argue that AI/agentic coding makes code generation cheaper while review and verification can become the bottleneck. This is a useful way to explain why the GitNexus workflow must optimize for:

   - small slices;
   - deterministic tests;
   - golden outputs where possible;
   - exact write sets;
   - fresh diff review;
   - no hidden broad rewrites.

2. Agent action-bias warning.

   The notes flag that agents may patch when no patch is needed. This reinforces an existing GitNexus rule:

   ```text
   reproduce or characterize before patching; if no change is needed, report evidence instead.
   ```

3. Context-file skepticism.

   The notes mention possible evidence that instruction files can hurt when bloated, stale, or irrelevant. This supports the current local policy:

   - `AGENTS.md` should hold durable workflow/routing rules only;
   - scratchpads hold working evidence;
   - `documentation.md` holds current truth;
   - do not promote every research note into project instructions.

4. Structured delegation wording.

   The first pasted note's phrase "structured delegation" is a good shorthand:

   ```text
   Agentic GitNexus work is structured delegation, not uncontrolled autonomy.
   ```

5. Determinism over autonomy.

   The third pasted note emphasizes controlled workflows over open-ended auto-loops. For GitNexus, this means:

   - no hidden hooks as the implementation route;
   - no unbounded background mutation;
   - no token-bearing automation without explicit security boundary;
   - no infinite retries in non-interactive Codex runs.

6. Observability / traceability.

   The third pasted note emphasizes tracing. For this repo, the practical equivalent is:

   - scratchpad evidence;
   - command outputs;
   - golden files;
   - status docs;
   - exact selected-task packets;
   - commits/checkpoints after coherent slices.

#### Points To Treat Carefully

Some pasted-note claims are useful but should not be accepted blindly:

| Claim type | Why careful | GitNexus handling |
| --- | --- | --- |
| Quantitative claims about papers, studies, or "10x fewer" cycles | Need primary-source verification before becoming planning authority. | Keep as prompts for future research, not durable rule text. |
| Claims that many tools universally read `AGENTS.md` | Tool support changes and may vary. | Codex `AGENTS.md` support is enough for our local rule; no need to overclaim. |
| Broad "multi-agent swarm" architecture claims | Interesting for agent systems, but GitNexus feature work currently uses selected-task control, not a swarm runtime. | Treat as future orchestration context only. |
| RAG/vector memory as long-term memory | Useful generally, but this workstream already has a four-file long-horizon bundle and GitNexus graph/indexes. | Do not introduce new memory architecture unless needed. |
| "Autonomous agents can work without rest" | True only regarding biological fatigue. | Still enforce drift, verification, and stop-rule controls. |

#### Reconciled Methodology Statement

Recommended working statement:

```text
GitNexus local enterprise-feature work uses structured delegation:
clear selected-task packets, repo exploration before edits, shaped small slices,
TDD for behavior changes, fresh verification, documented checkpoints, and MAIN
approval for product/security/mutation boundaries.
```

Shorter label:

```text
Structured Delegation via Evidence-Gated Small-Batch Kanban.
```

This does not replace the existing methodology. It clarifies the human/agent relationship:

- MAIN owns priorities, approvals, and policy boundaries.
- Codex owns disciplined execution inside the selected-task packet.
- The long-horizon bundle owns continuity.
- Tests/builds/diffs/source evidence own completion claims.

#### Actionable Update Candidate

Consider promoting only this compact rule later:

```text
For this workstream, autonomy means structured delegation, not unbounded action:
work one selected task at a time, explore before editing, keep slices small,
use TDD for behavior changes, verify before completion, checkpoint evidence,
and stop for MAIN approval on mutation, token, provider, CI, or broad architecture boundaries.
```

Do not promote the pasted notes wholesale. The control docs should stay compact.
