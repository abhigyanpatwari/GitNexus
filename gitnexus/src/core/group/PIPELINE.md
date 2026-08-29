# Group Analysis Pipeline

Flow chart of the cross-repo contract extraction + matching pipeline.
This covers what runs **inside this PR** (extractors + manifest) and
the downstream handoff to the bridge storage (PR #795) and
cross-impact query (PR #606).

## High-level overview

```mermaid
flowchart TD
  A[group.yaml] --> B[GroupConfig parser]
  B --> C{For each repo<br/>in group}
  C --> D[Per-repo LadybugDB<br/>indexed by main pipeline]

  D --> E1[TopicExtractor]
  D --> E2[HttpRouteExtractor]
  D --> E3[GrpcExtractor]
  D --> E4[GraphqlExtractor]

  E1 --> F[ExtractedContract array<br/>per repo]
  E2 --> F
  E3 --> F
  E4 --> F

  B --> M[ManifestExtractor]
  M --> G[Manifest contracts<br/>+ cross-links]

  F --> H[Contract matching<br/>exact + wildcard]
  G --> H

  H --> I[(bridge.lbug<br/>#795)]

  I --> J[runGroupImpact<br/>#606]
  J --> K[CrossRepoImpact]
```

## Per-repo extractor pipeline

Each extractor under `src/core/group/extractors/` follows the same
two-strategy shape:

```mermaid
flowchart TD
  R[RepoHandle + CypherExecutor<br/>for this repo] --> S{Graph-assisted<br/>Strategy A<br/>available?}

  S -->|yes| A1[Cypher query against<br/>per-repo LadybugDB]
  A1 --> A2{non-empty<br/>result?}
  A2 -->|yes| OUT[ExtractedContract array]
  A2 -->|no| B1

  S -->|no| B1[Source-scan Strategy B]
  B1 --> B2[glob repo source files]
  B2 --> B3{ext in registry?}
  B3 -->|yes| B4[Per-language plugin<br/>scan parsed tree]
  B3 -->|no| SKIP[skip file]
  B4 --> OUT

  SKIP --> B2
```

**Strategy A** (graph-assisted) uses Cypher over edges already produced
by the main ingestion pipeline:

- HTTP: `HANDLES_ROUTE` / `FETCHES` edges from `(File)-[]->(Route)`
- topic: none (pipeline doesn't yet produce topic nodes — Strategy B only)
- gRPC: none (Strategy B + proto map only)

**Strategy B** (source-scan) uses tree-sitter for language source and the
official GraphQL parser for `.graphql` / `.gql` operation documents.
Each `*-patterns/<lang>.ts` plugin owns its grammar + S-expression
queries; the top-level orchestrator imports neither.

GraphQL detection is opt-in with `detect.graphql: true`. The initial slice
recognizes imported NestJS `Query`, `Mutation`, and `Subscription` decorators on
top-level imported `Resolver` classes, plus named operation documents. Generated
object documents, static `gql` templates, and `TypedDocumentString` values are
verified against the operation and its resolved root fragments. Providers and
consumers must resolve to one exact, real graph symbol; anonymous operations,
dynamic decorator names, ambiguous generated symbols, malformed documents,
symlink escapes, and bounded-parser overflows are skipped rather than linked
approximately. `matching.exclude_links_paths` also suppresses configured GraphQL
root fields from exact cross-linking while retaining their registry entries.

## Plugin architecture

```mermaid
flowchart LR
  O[Orchestrator<br/>topic|http|grpc-extractor.ts] --> REG[REGISTRY<br/>*-patterns/index.ts]
  REG --> P1[java.ts<br/>tree-sitter-java]
  REG --> P2[go.ts<br/>tree-sitter-go]
  REG --> P3[python.ts<br/>tree-sitter-python]
  REG --> P4[node.ts<br/>JS + TS + TSX]
  REG --> P5[php.ts<br/>tree-sitter-php<br/>HTTP only]
  REG --> P6[proto.ts<br/>tree-sitter-proto<br/>gRPC only, optional]

  P1 --> SCAN[tree-sitter-scanner.ts<br/>compilePatterns + runCompiledPatterns]
  P2 --> SCAN
  P3 --> SCAN
  P4 --> SCAN
  P5 --> SCAN
  P6 --> SCAN

  SCAN --> DET[Detection objects<br/>TopicMeta / HttpDetection / GrpcDetection]
  DET --> O
  O --> CT[ExtractedContract array]
```

The orchestrator never imports a grammar. Adding a new language /
framework = drop one file in `*-patterns/`, register it in
`index.ts`. No orchestrator edits required.

## Manifest extraction

```mermaid
flowchart TD
  Y[group.yaml links] --> ME[ManifestExtractor]
  ME --> LOOP{for each link}
  LOOP --> RES[resolveSymbol<br/>label-scoped Cypher]
  RES --> OK{found?}
  OK -->|yes| REF[real symbol uid + ref]
  OK -->|no| SYN[synthetic uid<br/>manifest::repo::cid]

  REF --> EMIT[emit provider + consumer<br/>Contract objects<br/>+ CrossLink]
  SYN --> EMIT

  EMIT --> BRIDGE[(bridge.lbug<br/>#795)]
```

Label-scoped queries in `resolveSymbol` keep accidental cross-matches out.
They use the `MATCH (n) WHERE labels(n) IN [...]` allowlist form, NOT the
`MATCH (n:A|B)` disjunction — LadybugDB's parser rejects a disjunction that
names a reserved keyword (e.g. `Macro`, `Union`), which is what broke the
`custom` branch in #2325:

- `topic` → `labels(n) IN ['Function','Method','Class','Interface']`
- `grpc`/`thrift` method → `labels(n) IN ['Function','Method']`, service → `labels(n) IN ['Class','Interface']`
- `lib` → `labels(n) IN ['Module']`

## Cross-impact query (PR #606)

```mermaid
flowchart TD
  U[User changes symbol S<br/>in repo R] --> LI[Local impact engine<br/>per-repo uid expansion]
  LI --> IDS[Affected uid set]

  IDS --> BR[Bridge query<br/>MATCH Contract WHERE uid IN ids]
  BR --> CL[CrossLink traversal]
  CL --> OTHER[Matching contract in<br/>other repo]

  OTHER --> FE[Fan-out impact<br/>to consuming repo]
  FE --> OUT[CrossRepoImpact<br/>per affected repo]
```

The bridge stores every extracted contract keyed by `symbolUid`.
Manifest-sourced contracts use the synthetic uid form so both sides
of the `(local impact) ↔ (bridge query)` join derive the same uid
without coordinating through any shared state.

## Cross-repo trace (`cross-trace.ts`)

A second consumer of the bridge. Where cross-impact fans a blast radius
_outward_ from one symbol, cross-trace stitches a directed **path** between
two symbols that live in different repos:

```mermaid
flowchart TD
  FT[from / to resolved<br/>across all members] --> SR{same repo?}
  SR -- yes --> LT[single-repo trace<br/>no crossing]
  SR -- no --> SEGA[trace: from → consumer symbol<br/>in home repo]
  SEGA --> XB[Bridge pair query<br/>consumer.symbolUid → provider.symbolUid<br/>one ContractLink boundary]
  XB --> SEGB[trace: provider symbol → to<br/>in target repo]
  SEGB --> STITCH[stitched hops + CONTRACT_LINK edge<br/>+ optional REACHING_DEF data-flow]
```

It reuses the same `symbolUid` join as cross-impact, but issues its own
_pair_ query (`listCrossingsBetween`) because a path needs BOTH endpoints of
a crossing — the uid-filtered neighbor join (`resolveBridgeNeighbors`, shared
with impact) returns only the far side. The crossing is clamped to one
boundary (`MAX_SUPPORTED_CROSS_DEPTH`). With `pdg: true` the boundary-adjacent
segments are enriched with intra-procedural REACHING_DEF data-flow (never
across the boundary). Full cross-program data flow across the boundary is a
deferred follow-up.
