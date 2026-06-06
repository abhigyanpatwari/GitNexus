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
