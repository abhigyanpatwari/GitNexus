# NexusForge Agentic Fork Roadmap

This roadmap is for the independent fork. It is intentionally not scoped around
what is easiest to merge upstream. It is scoped around making the fork a strong
agentic coding platform.

## Guiding Principles

- Keep static graph correctness as the foundation.
- Make stale context hard to produce and easy to detect.
- Treat cross-repo boundaries as normal, not exceptional.
- Let agents ask for risk, context, and runtime evidence before editing.
- Give humans a visual way to inspect and guide the agent's architectural
  context.
- Preserve local-first privacy defaults.

## Phase 0 - Fork Foundation

- [x] Add fork notes and roadmap.
- [x] Choose a permanent project name.
- [x] Decide whether the CLI remains `gitnexus` during development or moves to a
      new command name.
- [x] Update visible UI copy once the permanent name is chosen.
- [x] Audit README sections that point to upstream badges, npm packages,
      enterprise offers, and signed upstream Docker images.

## Phase 1 - Agent Safety Tools

Small, high-signal features that make the fork immediately more useful for
agentic coding.

- [x] Add MCP tool `get_impact_score`.
- [x] Score incoming edges, outgoing edges, process participation, route/tool
      exposure, centrality, and cross-repo contract exposure.
- [x] Return `score`, `risk`, `reasons`, `top_callers`,
      `affected_processes`, and `recommended_preflight`.
- [x] Add `export_context` for Markdown, JSONL, and compact JSON graph
      neighborhoods.
- [x] Add token-budget and hop-count controls for exports.

Acceptance target: before editing a symbol, an agent can cheaply ask how risky
the edit is and export the relevant graph neighborhood.

## Phase 2 - Diff-Aware Incremental Indexing

This is the highest-leverage core engine change.

- [x] Add `.gitnexus/file-manifest.json` with scanned file size and mtime
      metadata for diff-aware freshness checks.
- [x] Add `.gitnexus/index-manifest.json` with file hashes, emitted nodes,
      emitted edges, parse diagnostics, and dependency ownership.
- [x] Track file-to-node and file-to-edge ownership during ingestion.
- [x] Implement delete/upsert support in the LadybugDB load path.
- [x] Add `gitnexus analyze --incremental`.
- [x] Add invalidation for changed exports and importing files.
- [x] Initially recompute global phases such as MRO, communities, and processes;
      optimize them later.

Acceptance target: editing one file updates the graph without a full rebuild.

## Phase 3 - Watch Mode And Live UI Sync

- [x] Add `gitnexus watch`.
- [x] Debounce file events and coalesce bursts from agent edits.
- [x] Reuse diff-aware analyze checks so watch does not force no-op rebuilds.
- [x] Add HTTP/SSE or WebSocket events from `gitnexus serve`.
- [x] Refresh the web graph without a full page reload.
- [x] Surface stale, syncing, synced, and failed states in the UI.

Acceptance target: agent edits appear in the graph within seconds.

## Phase 4 - Semantic Anchor Nodes

- [x] Add semantic fields to node metadata: `summary`, `purpose`, `tags`,
      `anchorModel`, `anchorHash`, `anchorVersion`, and `anchorGeneratedAt`.
- [x] Generate heuristic summaries first.
- [x] Add optional LLM enrichment with caching by content hash.
- [x] Surface heuristic anchors in `context` and web selected-node details.
- [x] Use anchors in `query`, `export_context`, and generated skills.
- [x] Add richer web node details for `purpose`, `tags`, and anchor metadata.

Acceptance target: search can find purpose-related code even when names do not
match the user's words.

## Phase 5 - Executable Skills

- [x] Extend generated skills with `skill.json` metadata.
- [x] Add one generic MCP tool `run_skill({ repo, skill, action, args })`.
- [x] Support actions such as `summarize`, `list_entry_points`, `impact`,
      `validate_change`, and `export_context`.
- [x] Add generated validation commands per skill where detectable.

Acceptance target: an agent can ask a module-level skill for safe, structured
context without manually traversing raw graph nodes.

## Phase 6 - Cross-Repo Contract Intelligence

Repo groups already exist. This phase deepens accuracy and product polish.

- [x] Auto-trigger group sync after member repo analysis.
- [x] Harden HTTP route and fetch matching across common frameworks.
  - [x] Node/TypeScript source-scan coverage: Next.js App Router handlers, quoted HTTP option keys, and common custom HTTP client wrappers.
  - [x] Python source-scan coverage: Flask routes, Django URLConf entries, and `httpx`/`aiohttp` clients with literal `base_url` joins.
  - [x] Java/Spring source-scan coverage: named `path`/`value` mapping arguments and generic `RequestMapping(method = RequestMethod.X)` routes.
  - [x] Go source-scan coverage: Gin/Echo/Chi-style routes, `net/http` providers, stdlib clients, and Resty clients.
  - [x] PHP source-scan coverage: Laravel routes, Laravel HTTP facade, Guzzle clients, and HTTP `file_get_contents` calls.
- [x] Import OpenAPI contracts when present.
- [x] Expand gRPC/proto mapping and generated-client detection.
- [x] Add topic contract detection for Kafka, NATS, RabbitMQ, SNS, and SQS.
- [x] Show stale group-contract state in MCP resources and the web UI.

Acceptance target: changing a backend API can automatically flag frontend,
worker, and service consumers across repositories.

## Phase 7 - Runtime And Log Overlay

- [x] Add runtime tables/nodes for services, spans, routes, errors, and log
      patterns.
- [x] Import OTLP JSON, structured logs JSONL, and stack traces.
- [x] Map runtime signals to static nodes by route, span name, stack frame, and
      symbol fallback.
- [x] Store call count, error rate, p95 latency, environment, and time window.
- [x] Add MCP tool `runtime_context`.
- [x] Enrich impact reports with runtime failure and latency signals.

Acceptance target: an agent can prioritize fixes using production behavior, not
only static structure.

## Phase 8 - 3D Agent Operations View

The web app already has a Three.js graph mode. This phase turns it into a
human-guided agent context console.

- [x] Add an initial health heatmap mode based on dependency load.
- [x] Add graph modes for structure, impact, runtime, health, and agent focus.
- [x] Stream agent tool activity into the graph view.
- [x] Highlight nodes currently read, written, or cited by the agent.
- [x] Add context clipping from selected 3D clusters.
- [x] Export clipped context to Markdown, JSONL, or chat.
- [x] Add a dependency-count heatmap.
- [x] Add heatmaps for centrality, complexity, churn, and runtime error rate.

Acceptance target: a human can visually select the area an agent should care
about and export it as bounded context.

## Phase 9 - Collaborative Context Lake

- [x] Define portable context snapshot format.
- [x] Include schema version, repo fingerprint, commit hash, contracts, semantic
      anchors, and optional runtime summaries.
- [x] Add `gitnexus context push` and `gitnexus context pull`.
- [x] Support local folder and S3-compatible backends first.
- [x] Add checksums, signing hooks, and redaction rules.

Acceptance target: a team can share the same architectural map without every
machine rebuilding it from scratch.
