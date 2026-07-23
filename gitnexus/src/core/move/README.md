# Move compiler integration

GitNexus's compiler-first ingestion for Move packages. Packages are discovered
from `Move.toml`, queried live over MCP via `move-flow` (`facts` + `call_graph`,
never persisted or replayed), and projected into the standard knowledge graph.

```text
Move package
  -> move-flow MCP (facts + call_graph)
  -> Pass A: per-package nodes + deferred PendingRefs
  -> global cross-package index
  -> Pass B: resolve refs + synthesize external symbols
  -> GitNexus nodes and relationships
  -> consistency validation
```

Ingestion runs in two passes around a global cross-package index. Pass A
(`facts-mapper.ts`) maps compiler facts for one package to deterministic nodes
(Module, Function, Struct, Enum, Const) and emits cross-package references it
cannot yet resolve as typed `PendingRef` values. Pass B (`move-linker.ts`) runs
once every package is mapped: a descriptor-driven `resolveRefs` engine looks each
ref up in the accumulated index, synthesizing stub nodes for external
(non-repo) targets and recording anything unresolved as a `DroppedRef`. The
`MoveIngestAccumulator` (in `move-ingest.ts`) holds the shared state across
passes; `consistency.ts` validates the result.

Compiler identity is recorded in the repository metadata; changing it forces a
full rebuild. Env knobs: `GITNEXUS_MOVE_FLOW_TIMEOUT_MS`,
`GITNEXUS_MOVE_FLOW_CONCURRENCY` (supplemental `function_usage` fan-out, default
`4`), `GITNEXUS_SKIP_MOVE_FLOW=1`, and `MOVE_FLOW` (see `provision.ts`).

## Upstream references

- [Aptos Core](https://github.com/aptos-labs/aptos-core) contains the upstream
  Move compiler and runtime. MoveFlow releases are built from matching
  `move-flow-v<version>` tags in this repository.
- [MoveFlow in Aptos AI](https://github.com/aptos-labs/aptos-ai) provides the
  `move-flow` binary and MCP tools consumed by this integration. GitNexus
  currently targets
  [MoveFlow 2.0.0](https://github.com/aptos-labs/aptos-ai/releases/tag/move-flow-v2.0.0).
- [The Move Book](https://aptos-labs.github.io/move-book/) is the language
  reference for Move concepts represented in the graph.
