# Using GitNexus across gRPC microservices

## When to use this guide

This guide is for teams whose product lives in **several separate Git repositories** — one per service — and whose services talk to each other over **gRPC** (possibly alongside HTTP and message topics). GitNexus indexes each repo independently, then a _group_ stitches the per-repo indexes into a single cross-repo view that the `impact`, `query`, and `context` tools can traverse. If your services live in one monorepo, much of this still applies — set each service as a member of a group and use the `service` prefix to scope queries — but the walkthrough assumes the harder multi-repo case.

## Mental model

- Each repository has its own `.gitnexus/` index (a LadybugDB graph of symbols, relationships, processes). `gitnexus analyze` in each repo produces that index completely independently.
- A **group** is a higher-level construct stored at `~/.gitnexus/groups/<group>/` that references the per-repo indexes by their registry name.
- Sync-time extractors walk each member repo and emit **contracts** — provider or consumer records keyed by a canonical `contractId` (`grpc::auth.AuthService/Login`, `http::GET::/orders`, etc.).
- The sync step matches providers and consumers that share a `contractId` and writes **cross-links** to `<groupDir>/contracts.json`. Those cross-links are what lets `impact({repo: "@<group>", target: "X"})` hop from one repo into another.
- Contracts come from three places: automatic contract extractors (`grpc-extractor`, `http-route-extractor`, `topic-extractor`), a manifest escape hatch (`config.links` in `group.yaml`), and — for same-name symbol matches where no contract is declared — the exact-match matching cascade in [`matching.ts`](../../gitnexus/src/core/group/matching.ts).
- Each repo stays editable and re-indexable on its own. Re-run `gitnexus analyze` in a repo when it changes, then `gitnexus group sync <group>` to refresh `contracts.json`. `gitnexus group status` reports which members are stale.

## Prerequisites

- GitNexus installed and runnable as `gitnexus` or `npx gitnexus` (see the root [README.md](../../README.md)).
- Each service repository checked out locally. No requirement that they share a parent directory — the group references them by registry name.
- Write access to `~/.gitnexus/` (the default gitnexus home; see `getDefaultGitnexusDir` in [`storage.ts`](../../gitnexus/src/core/group/storage.ts)).

## Step-by-step walkthrough

The example uses three services — a TypeScript API gateway, a Go orders service, and a Python inventory service — with gRPC between them. The gateway is an `orders` consumer; the orders service is both an `orders` provider and an `inventory` consumer; the inventory service is an `inventory` provider.

### 1. Index each repository

Run `analyze` from inside each service repo (or pass the path). The CLI surface lives in [`gitnexus/src/cli/analyze.ts`](../../gitnexus/src/cli/analyze.ts) and is wired in [`gitnexus/src/cli/index.ts`](../../gitnexus/src/cli/index.ts).

```bash
cd ~/code/gateway && npx gitnexus analyze
cd ~/code/orders  && npx gitnexus analyze
cd ~/code/inventory && npx gitnexus analyze
```

Useful flags:

- `--force` — reindex even if up to date.
- `--embeddings` — generate embedding vectors (needed only if you want semantic search; the exact-match cross-repo cascade does **not** need them).
- `--name <alias>` — register the repo under a specific alias when two repos share a basename (e.g. two `api/` folders).
- `--skip-git` — index a checkout that isn't a git repo.

Each run writes a `.gitnexus/` folder in the repo and registers the repo in `~/.gitnexus/registry.json`. Confirm with `npx gitnexus list`.

### 2. Author `group.yaml`

Create the group directory and edit the config. Either use the CLI scaffolder or write the file directly — both produce the same shape consumed by [`config-parser.ts`](../../gitnexus/src/core/group/config-parser.ts).

```bash
npx gitnexus group create payments-platform
# or manually:
mkdir -p ~/.gitnexus/groups/payments-platform
$EDITOR   ~/.gitnexus/groups/payments-platform/group.yaml
```

Minimal working `group.yaml`:

```yaml
version: 1
name: payments-platform
description: Gateway + orders + inventory (gRPC)

repos:
  gateway: gateway
  orders: orders
  inventory: inventory

# Only add explicit links when the automatic extractors miss something —
# see "When automatic extraction isn't enough" below.
links: []

packages: {}

detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: false

matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
  # Exclude noisy paths from cross-link matching (contracts are still extracted)
  exclude_links_paths: [/ping, /health, /healthcheck]
  exclude_links_param_only_paths: true
```

Field notes (schema in [`types.ts`](../../gitnexus/src/core/group/types.ts)):

- `version` — must be `1`. The parser rejects anything else.
- `name` — required; used for the group directory name and all CLI / MCP calls.
- `repos` — a mapping from **group path** (a logical name you choose; can be a hierarchy like `backend/orders`) to **registry name** (the name shown by `npx gitnexus list`). Both sides appear throughout the tooling: contract rows use the group path; `@<group>/<groupPath>` routes tools to a single member.
- `links` — optional manifest escape hatch, one entry per explicit cross-repo contract. Validated by the parser: `from` and `to` must be known repo paths, `type` must be one of `http | grpc | topic | lib | custom`, and `role` must be `provider | consumer`.
- `detect` — toggles per extractor family. Defaults (set in `config-parser.ts`) turn `http`, `grpc`, `topics`, and `shared_libs` on; disable the ones you don't use to speed up sync.
- `matching` — thresholds for the matching cascade. The exact match is always run; other strategies depend on indexer state. Two optional fields reduce false-positive cross-links in large groups:
  - `exclude_links_paths` — list of HTTP paths to exclude from cross-link matching (default `[]`). Contracts at these paths are still extracted and visible in the registry, but they don't produce cross-repo links. Useful for health-check endpoints (`/ping`, `/health`) that every service exposes. Trailing slashes are normalized.
  - `exclude_links_param_only_paths` — when `true`, exclude routes where every segment is `{param}` (e.g. `/{param}`, `/{param}/{param}`) from cross-link matching (default `false`). Mixed routes like `/users/{param}` are not affected.

### 3. Sync the group

```bash
npx gitnexus group sync payments-platform --verbose
```

What this does (see [`sync.ts`](../../gitnexus/src/core/group/sync.ts)):

1. Opens each member's per-repo LadybugDB.
2. Runs the HTTP, gRPC, and topic extractors against the source files.
3. Applies manifest `links` through [`manifest-extractor.ts`](../../gitnexus/src/core/group/extractors/manifest-extractor.ts).
4. Runs the exact-match cascade, joining providers and consumers that share a normalized `contractId`.
5. Writes `contracts.json` in the group directory.

Flags:

- `--exact-only` — stop after the exact cascade; skip BM25 and embedding fallback.
- `--skip-embeddings` — run exact plus BM25 but not embedding-based matching.
- `--allow-stale` — don't warn if a member's index is stale.
- `--json` — machine-readable output.

The same operation is available over MCP as `group_sync({ name: "payments-platform" })` — see [`tools.ts`](../../gitnexus/src/mcp/tools.ts).

### 4. Inspect the registry

Use `gitnexus group contracts` for the CLI view or read the `gitnexus://group/<name>/contracts` MCP resource for the same data.

```bash
npx gitnexus group contracts payments-platform --type grpc --json
```

A shortened response:

```json
{
  "contracts": [
    {
      "contractId": "grpc::orders.OrderService/PlaceOrder",
      "type": "grpc",
      "role": "provider",
      "repo": "orders",
      "symbolRef": { "filePath": "internal/grpc/order_server.go", "name": "RegisterOrderServiceServer" },
      "confidence": 0.8,
      "meta": { "service": "OrderService", "method": "PlaceOrder", "source": "go_register" }
    },
    {
      "contractId": "grpc::orders.OrderService/PlaceOrder",
      "type": "grpc",
      "role": "consumer",
      "repo": "gateway",
      "symbolRef": { "filePath": "src/clients/orders.ts", "name": "OrderServiceClient" },
      "confidence": 0.75,
      "meta": { "service": "OrderService", "source": "ts_generated_client" }
    }
  ],
  "crossLinks": [
    {
      "from": { "repo": "gateway", "symbolUid": "…", "symbolRef": { "filePath": "src/clients/orders.ts", "name": "OrderServiceClient" } },
      "to":   { "repo": "orders",  "symbolUid": "…", "symbolRef": { "filePath": "internal/grpc/order_server.go", "name": "RegisterOrderServiceServer" } },
      "type": "grpc",
      "contractId": "grpc::orders.OrderService/PlaceOrder",
      "matchType": "exact",
      "confidence": 1.0
    }
  ]
}
```

Staleness of the underlying indexes shows up in `npx gitnexus group status payments-platform` or the `gitnexus://group/<name>/status` resource.

### 5. Run cross-repo impact with `@<group>` routing

From any shell (you do **not** have to `cd` into a member repo), the normal `impact` / `query` / `context` tools accept `repo: "@<group>"` to fan out across all members, or `repo: "@<group>/<memberPath>"` to target one member. Routing is implemented in [`resolve-at-member.ts`](../../gitnexus/src/core/group/resolve-at-member.ts) and described in [`tools.ts`](../../gitnexus/src/mcp/tools.ts).

Example MCP calls:

```json
{"tool": "impact", "arguments": {
  "repo": "@payments-platform/orders",
  "target": "PlaceOrder",
  "direction": "upstream",
  "crossDepth": 2
}}
```

```json
{"tool": "query", "arguments": {
  "repo": "@payments-platform",
  "query": "retry logic around PlaceOrder"
}}
```

The CLI equivalents still exist for scripting:

```bash
npx gitnexus group impact payments-platform \
  --repo orders --target PlaceOrder --direction upstream --cross-depth 2
```

Phase 1 walks within the anchor member; Phase 2 hops across the Contract Bridge wherever a cross-link endpoint matches an impacted symbol. See [`cross-impact.ts`](../../gitnexus/src/core/group/cross-impact.ts) for the bridge query.

## How gRPC extraction works

`GrpcExtractor` ([`grpc-extractor.ts`](../../gitnexus/src/core/group/extractors/grpc-extractor.ts)) runs two passes per member repo:

1. **Proto map.** Every `**/*.proto` file is parsed to enumerate `service Foo { rpc Bar(...) }` blocks and (transitively) resolve the package name. Each RPC method becomes a provider contract with `contractId = grpc::<package>.<Service>/<Method>` and `confidence = 0.85`. Parsing uses the vendored `tree-sitter-proto` grammar when available and falls back to a length-preserving manual parser (`extractServiceBlocks`) otherwise, so `.proto` extraction works on platforms where the grammar fails to build.
2. **Source scan.** Every source file whose extension matches [`GRPC_SCAN_GLOB`](../../gitnexus/src/core/group/extractors/grpc-patterns/index.ts) is parsed by its language plugin:

| Language | Provider signal | Consumer signal |
|----------|-----------------|-----------------|
| Go ([`go.ts`](../../gitnexus/src/core/group/extractors/grpc-patterns/go.ts)) | `pb.RegisterXxxServer(...)`, `pb.UnimplementedXxxServer` embedded in struct | `pb.NewXxxClient(conn)` |
| Java ([`java.ts`](../../gitnexus/src/core/group/extractors/grpc-patterns/java.ts)) | `extends XxxServiceGrpc.XxxServiceImplBase` (with or without `@GrpcService`) | `XxxServiceGrpc.newBlockingStub(...)`, `newStub(...)` |
| Python ([`python.ts`](../../gitnexus/src/core/group/extractors/grpc-patterns/python.ts)) | `add_XxxServicer_to_server(...)` (bare or `_pb2_grpc.` attribute form) | `XxxStub(channel)` (ignores `Mock`/`Test`/`Fake`/`Stub`) |
| Node / TS ([`node.ts`](../../gitnexus/src/core/group/extractors/grpc-patterns/node.ts)) | NestJS `@GrpcMethod('Service','Method')` | `@GrpcClient` field typed `XxxServiceClient`, `client.getService<X>('Service')`, `new XxxServiceClient(...)`, `new foo.bar.XxxService(...)` in files that call `loadPackageDefinition` |

For each source-scan detection the extractor looks up the short service name in the proto map and picks:

- `grpc::<package>.<Service>/<Method>` when a method is named and the service resolves against the proto map,
- `grpc::<package>.<Service>/*` (wildcard) when only the service is known, or
- `grpc::<ServiceName>/*` when no `.proto` is available at all.

Provider detections land at confidence 0.8 (with proto) or 0.65 (without); consumers at 0.75 or 0.55. NestJS `@GrpcMethod` is fixed at 0.8 because the decorator is self-describing.

### Matching

`matching.ts` lowercases the package/service segment before comparing contract ids, so bindings that capitalize names differently (`auth.AuthService` vs `auth.authservice`) still match. Method names are compared case-sensitively because gRPC's wire path is case-sensitive. Service-only wildcards (`grpc::pkg.Svc/*`) match any method on the same service during cross-linking.

### Known limitations

- **Ambiguous proto resolution.** If a short service name exists in more than one `.proto` file and the source-scan hit can't be narrowed down by shared directory segments (`resolveProtoConflict` refuses to guess), the extractor skips contract emission and logs a warning.
- **Proto packages must be resolvable locally.** Transitive imports that point outside the repo produce an empty package segment, which means the contract id collapses to `grpc::<Service>/<Method>`. Cross-repo matches still work as long as both sides agree on the empty package.
- **Rewrite rules are not implemented.** If the provider repo writes `grpc::orders.OrderService/PlaceOrder` and the consumer repo writes `grpc::orderspb.OrderService/PlaceOrder`, they won't cross-link automatically. Use `config.links` to declare the correspondence (see below).
- **One sync = one snapshot.** Contracts are extracted against the indexed snapshot of each repo. Re-index first, then re-sync; the `status` command and resource surface staleness.

## When automatic extraction isn't enough

The escape hatch is the `links` list in `group.yaml`, handled by [`ManifestExtractor`](../../gitnexus/src/core/group/extractors/manifest-extractor.ts). Each entry is a **one-directional** provider/consumer declaration:

```yaml
version: 1
name: payments-platform
repos:
  gateway: gateway
  orders: orders
  inventory: inventory

links:
  # Explicit gRPC method: use when naming mismatches stop the
  # automatic matcher from cross-linking.
  - from: gateway
    to: orders
    type: grpc
    contract: OrderService/PlaceOrder
    role: consumer

  # Service-level link when you don't want to enumerate methods.
  - from: orders
    to: inventory
    type: grpc
    contract: InventoryService
    role: consumer

  # Works for HTTP too — use `METHOD::/path` form for the exact
  # handler, or just `/path` for a method-agnostic wildcard.
  - from: gateway
    to: orders
    type: http
    contract: POST::/orders
    role: consumer
```

What the manifest extractor does (see [`manifest-extractor.ts`](../../gitnexus/src/core/group/extractors/manifest-extractor.ts)):

1. Builds a canonical `contractId` with `buildContractId` — the same canonicalization used by the automatic extractors, so manifest links cross-match automatic contracts on the other side.
2. Tries to resolve each side to a real graph symbol (the `Route` node for HTTP, a `Function|Method` / `Class|Interface` for gRPC, a `Package|Module` for `lib`).
3. If resolution fails, falls back to a deterministic synthetic uid (`manifest::<repo>::<contractId>`) so both sides still line up in cross-impact — name-only links still work when the symbol isn't in the graph.
4. Emits both a provider and a consumer `StoredContract` (confidence `1.0`, `source: "manifest"`) and a `CrossLink` with `matchType: "manifest"`.

Use `links` for exactly the cases the extractor can't infer: different package names across repos (see #701), hand-rolled transports, cases where the provider repo isn't checked out locally but you still want a record, or any contract whose provider and consumer simply don't share a surface the extractors know how to pattern-match.

History: the manifest extractor used to be silently skipped by the sync pipeline; that was fixed in [#827](https://github.com/abhigyanpatwari/GitNexus/pull/827) (tracking issue #826). If you ever see `config.links` with zero cross-links in `contracts.json`, make sure you're on a build that includes that fix, then re-run `group sync`.

## Troubleshooting

1. **`contracts.json` is empty after a sync.** Either no member repo contained a recognizable gRPC pattern, or the extractors are disabled in `detect`. Confirm `detect.grpc: true` and re-run with `--verbose`.
2. **A known provider/consumer pair doesn't cross-link.** Most common cause: the package segment differs. Check the raw contract ids with `gitnexus group contracts <name> --unmatched` — if you see two same-method contracts with different package prefixes, add a manifest `links:` entry to bridge them (no automatic rewrite rules yet).
3. **`matchType: "manifest"` is missing entirely.** The extractor needs `config.links` to be non-empty and the sync pipeline to actually call it — verify you're on a post-#827 build. Empty contract rows for manifest links usually mean `resolveSymbol` couldn't find a graph match; the synthetic uid still lets cross-impact work, it just won't carry a file path.
4. **Ambiguous proto warnings.** Look for `[grpc-extractor] Ambiguous proto resolution` in the sync logs; that means a service name exists in multiple `.proto` files under the same repo and the path-distance heuristic couldn't pick a winner. Resolve by renaming the service or declaring the intended pairing in `config.links`.
5. **Cross-impact says "stale".** Both sides need a fresh per-repo index _and_ a fresh group sync. Order matters: `gitnexus analyze` in each changed repo, then `gitnexus group sync <name>`. Use `gitnexus group status <name>` to see which side is behind.

## Related docs and references

- [AGENTS.md](../../AGENTS.md) — authoritative list of MCP tools and resources, including group-mode routing and the `gitnexus://group/…` resources.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — overall data flow and the call-resolution DAG that the per-repo indexer uses.
- [`gitnexus/src/core/group/`](../../gitnexus/src/core/group/) — `service.ts`, `sync.ts`, `config-parser.ts`, `matching.ts`.
- [`gitnexus/src/core/group/extractors/grpc-extractor.ts`](../../gitnexus/src/core/group/extractors/grpc-extractor.ts) and [`grpc-patterns/`](../../gitnexus/src/core/group/extractors/grpc-patterns/) — gRPC detection.
- [`gitnexus/src/core/group/extractors/manifest-extractor.ts`](../../gitnexus/src/core/group/extractors/manifest-extractor.ts) — the `config.links` escape hatch.
- [`gitnexus/src/mcp/tools.ts`](../../gitnexus/src/mcp/tools.ts) — MCP tool schemas (`group_list`, `group_sync`, plus `@<group>` routing on `impact` / `query` / `context`).
- [`gitnexus/src/cli/group.ts`](../../gitnexus/src/cli/group.ts) — CLI command definitions and flags.
- Upstream issues: [#701](https://github.com/abhigyanpatwari/GitNexus/issues/701), [#826](https://github.com/abhigyanpatwari/GitNexus/issues/826), [#906](https://github.com/abhigyanpatwari/GitNexus/issues/906).
