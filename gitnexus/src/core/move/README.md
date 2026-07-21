# Move compiler integration

This directory implements GitNexus's compiler-first ingestion for Move packages.
GitNexus discovers packages from `Move.toml`, communicates with `move-flow` over
MCP, and projects compiler facts into the standard GitNexus knowledge graph.
Declaration and semantic data come from the compiler-backed `facts` and
`call_graph` queries rather than raw-source parsing.

Cold compiler builds for large packages may take several minutes. Tool calls
default to a five-minute timeout; override it in milliseconds with
`GITNEXUS_MOVE_FLOW_TIMEOUT_MS` when a repository needs a larger budget.

```text
Move package
  -> move-flow MCP
  -> compiler facts and call graph
  -> GitNexus nodes and relationships
  -> consistency validation
```

## Components

- `mcp-client.ts` owns the `move-flow mcp` process, JSON-RPC transport, and the
  client contract consumed by ingestion.
- `compiler-facts.ts` defines the normalized compiler response shapes used by
  downstream projections.
- `move-ingest.ts` implements the standalone ingestion phase, including package
  discovery, compiler queries, and cross-package resolution.
- `facts-mapper.ts` maps compiler facts to deterministic GitNexus nodes and
  relationships.
- `consistency.ts` validates the resulting graph and reports incomplete or
  malformed compiler evidence.

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
