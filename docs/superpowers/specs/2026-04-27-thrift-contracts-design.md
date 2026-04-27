# Thrift Contract Extraction Design

**Date:** 2026-04-27
**Scope:** Add open-source-safe Apache Thrift contract extraction to group sync
**Approach:** Generic Thrift IDL plus generic Java generated-code patterns

---

## Goal

GitNexus group sync can currently build cross-repo contracts for HTTP, gRPC, and topics, but not Apache Thrift. Add first-class `thrift` contracts so a consumer repo that calls a Thrift service can cross-link to a provider repo that defines or implements that same service.

The first implementation must be useful for Java services while staying generic enough for future Go, Python, and Node plugins.

## Privacy Boundary

The open-source implementation must not encode company-internal framework details.

Do not add source code, tests, or docs that mention:

- Internal annotations or bean/config classes
- Internal appkey, service discovery, registry, or domain conventions
- Internal package names, real business service names, or real method names
- Real snippets from private repositories

Private repositories may be used only as local validation inputs. Test fixtures and docs must use fictional names such as `billing.v1.OrderService/PlaceOrder`.

## Contract Model

Add `thrift` to `ContractType`.

Canonical contract IDs:

```text
thrift::<namespace-or-package>.<Service>/<Method>
thrift::<namespace-or-package>.<Service>/*
thrift::<Service>/<Method>
thrift::<Service>/*
```

Rules:

- Prefer `namespace java ...` from `.thrift` when available.
- If no Java namespace exists, fall back to another declared namespace.
- If no namespace exists, omit the namespace segment.
- Preserve method name casing.
- Normalize the namespace/service segment case for matching, following the gRPC matching model.
- Service wildcard contracts match method-level provider contracts on the same service.

`group.yaml` manifest links should support:

```yaml
links:
  - from: gateway
    to: orders
    type: thrift
    contract: billing.v1.OrderService/PlaceOrder
    role: consumer
```

## Extractor Architecture

Add a `ThriftExtractor` that follows the existing group extractor pattern:

- `gitnexus/src/core/group/extractors/thrift-extractor.ts`
- `gitnexus/src/core/group/extractors/thrift-patterns/index.ts`
- `gitnexus/src/core/group/extractors/thrift-patterns/java.ts`
- `gitnexus/test/unit/group/thrift-extractor.test.ts`

Wire it into `syncGroup()` behind `detect.thrift`, next to `detect.grpc`.

The extractor has two phases.

### Phase 1: IDL Scan

Scan `**/*.thrift`, excluding generated/build/vendor directories.

Parse only the service surface needed for contracts:

- `namespace <language> <value>`
- `service <ServiceName> { ... }`
- method declarations inside a service body

The parser can start as a conservative text parser with comment/string sanitization and brace-depth scanning, mirroring the gRPC `.proto` fallback style. No full Thrift grammar is required for v1.

For each method found in IDL, emit a provider contract pointing at the `.thrift` file with high confidence. This gives group sync a canonical provider even when the implementation class is absent from the checkout.

### Phase 2: Java Source Scan

The Java plugin should recognize generic Apache Thrift generated-code patterns, not framework-specific wiring.

Provider signals:

- A class implements `OrderService.Iface`.
- A class implements `OrderService`.
- Methods in that class match methods known from the IDL service.

Consumer signals:

- Field or local variable type is `OrderService.Iface`, `OrderService.Client`, or `OrderService`.
- Method invocation on that variable matches a known IDL method: `orderService.placeOrder(...)`.
- If no IDL is available, emit a weak method-level consumer contract using the declared Java type and invoked method name.

This covers both common generated-code usage:

```java
private OrderService.Iface orderService;
orderService.placeOrder(request);
```

and generated-service-type usage:

```java
private OrderService orderService;
orderService.placeOrder(request);
```

The plugin should build a lightweight symbol table per Java file:

- Imports from short name to fully qualified name
- Field names to declared type
- Local variable names to declared type where practical
- Method invocations whose receiver is a tracked variable

Only type and method names are used for contract inference. Annotations are ignored.

## POM Handling

Do not make Maven `pom.xml` parsing a v1 primary path.

POM files can help identify generated thrift client jars, but Maven coordinates do not reliably map to service names, and private coordinate conventions would risk leaking internal framework knowledge.

V1 behavior:

- Generate weak consumer contracts from Java type and method names when IDL is absent.
- Do not hardcode groupId/artifactId naming rules.

Future enhancement:

- Add a generic Maven weak signal that detects dependencies with public/common thrift indicators, without private coordinate rules.

## Matching

Extend contract normalization for `thrift`:

- Lowercase the namespace/service segment before `/`.
- Preserve the method segment after `/`.
- Preserve malformed IDs as-is when parsing is ambiguous.

Extend wildcard matching currently used for gRPC so `thrift::<Service>/*` can match method-level thrift providers on the same service. The same same-repo/same-service skip rule should apply.

## Manifest Resolution

Extend `ManifestExtractor` for `type: thrift`:

- Method contract: resolve by exact method name against `Function|Method`.
- Service contract: resolve by exact service name against `Class|Interface`.
- If unresolved, fall back to the existing deterministic synthetic UID mechanism.

No `.thrift` file fallback should attach to an arbitrary IDL file. A wrong real symbol is worse than a deterministic synthetic link.

## Error Handling

Extraction is conservative:

- Malformed `.thrift` service blocks are skipped with a warning.
- Missing namespace falls back to namespace-less contract IDs.
- Ambiguous same-name services use a path-similarity heuristic like gRPC. If still tied, skip canonical emission and warn.
- Java receiver types that cannot resolve to an IDL service produce weak contracts with lower confidence.
- Parser failures in one file do not fail group sync.

## Tests

Add focused unit tests with fictional fixtures:

- `.thrift` service and method provider extraction.
- Java provider from `implements OrderService.Iface`.
- Java provider from `implements OrderService`.
- Java consumer from `OrderService.Iface` field plus `placeOrder(...)`.
- Java consumer from `OrderService.Client` field plus `placeOrder(...)`.
- Java consumer from `OrderService` field plus `placeOrder(...)`.
- Weak consumer contract when no `.thrift` file exists.
- Thrift exact matching.
- Thrift service wildcard matching.
- `ManifestExtractor` supports `type: thrift`.
- `syncGroup()` runs `ThriftExtractor` when `detect.thrift` is true.
- Config parser default includes `detect.thrift: true`.

Validation commands for implementation:

```bash
cd gitnexus && npx vitest run test/unit/group/thrift-extractor.test.ts test/unit/group/matching.test.ts test/unit/group/manifest-extractor.test.ts test/unit/group/sync.test.ts
cd gitnexus && npx tsc --noEmit
cd gitnexus && npm test
```

## Documentation

Add `docs/guides/microservices-thrift.md` or extend the existing microservices guide with a Thrift section.

The guide should explain:

- Contract ID format
- IDL extraction
- Generic Java generated-code patterns
- Manifest escape hatch
- Known limitations
- Privacy note: framework-specific adapters belong outside the open-source core

All examples must use fictional service names.

## Out of Scope

- Company-specific annotations, beans, appkeys, or service discovery.
- Multi-language Thrift source scanners beyond the Java v1 plugin.
- Full Maven dependency graph resolution.
- A complete Thrift grammar/parser.
- Changes to the per-repo ingestion call-resolution pipeline.
