# Move compiler integration

This directory implements GitNexus's compiler-first ingestion for Move packages.
GitNexus discovers packages from `Move.toml`, communicates with `move-flow` over
MCP, and projects compiler facts into the standard GitNexus knowledge graph.
Declaration and semantic data come from the compiler-backed `facts` and
`call_graph` queries rather than raw-source parsing.

Cold compiler builds for large packages may take several minutes. Tool calls
default to a five-minute timeout; override it in milliseconds with
`GITNEXUS_MOVE_FLOW_TIMEOUT_MS` when a repository needs a larger budget.

## Runtime provisioning

When `analyze` finds a `Move.toml`, it resolves `move-flow` from the authoritative
`MOVE_FLOW` path, the verified managed cache, `PATH`, or finally the pinned
release in `release.ts`. Managed releases live under
`~/.gitnexus/tools/move-flow` by default, are downloaded over HTTPS, checked
against `SHA256SUMS`, version-probed, and atomically published while a
heartbeat lease serializes concurrent installers.

Set `GITNEXUS_SKIP_MOVE_FLOW=1` to disable automatic downloads. The umbrella
`GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` does the same while also disabling optional
grammars. Air-gapped hosts should set `MOVE_FLOW` to a preinstalled compatible
binary or pre-seed the managed cache. Advanced trusted-release overrides are
`GITNEXUS_MOVE_FLOW_DIR`, `GITNEXUS_MOVE_FLOW_VERSION`,
`GITNEXUS_MOVE_FLOW_REPO`, `GITNEXUS_MOVE_FLOW_TAG`,
`GITNEXUS_MOVE_FLOW_COMPAT`, and `GITNEXUS_MOVE_FLOW_HTTP_TIMEOUT_MS`.

The repository metadata records the compiler identity used for Move facts.
Changing that identity forces a full rebuild. If an existing compiler-backed
graph needs updating while the compiler is unavailable, analysis fails before
mutating the graph; restore `move-flow` or set `MOVE_FLOW` and retry.
Managed identities include the verified binary hash; explicit and `PATH`
identities use their locator and reported version, so replace a same-version
local build with `gitnexus analyze --force`.
Filesystem errors while discovering `Move.toml` are also surfaced instead of
silently treating the repository as non-Move.

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
