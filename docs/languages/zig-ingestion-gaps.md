# Zig Ingestion Gaps

Audited on 2026-10-23 with freshly built production sources at `c35806d24` and
the accompanying benchmark changes. See the [measurement audit](receiver-resolution-audit.md)
for commands, target checks, exclusions and test limits. Historical reports below
remain separate from freshly measured receiver cases; broader ingestion is not
exhaustively assessed.

## Receiver shape snapshot

States below come from [baseline.json](../../gitnexus/bench/receiver-resolution/baseline.json).
The [harness](../../gitnexus/bench/receiver-resolution/measure.mjs) defines each
spelling and its N/A reason. RESOLVES requires the exact expected declaration ID
and no same-named call to a different owner. WRONG-TARGET records incorrect edges.

No row exists in the checked-in receiver shape arm. Add a measurement contract before comparing this language with measured rows.

Zig is registered but absent from the receiver shape arm. The merged series covers import aliases, forwarding constructors, anonymous containers and type applications through dedicated fixtures/tests. Absence from this benchmark is a measurement gap, not proof those features are missing.

## Planning candidates

| ID     | Evidence       | Gap or boundary                                                                | Next planning step and acceptance                                                                                                                                       |
| ------ | -------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZIG-01 | Coverage gap   | Delivered Zig receiver forms have no row in baseline.json.                     | Define applicable Zig shapes and explicit N/A reasons, reusing import-alias and factory cases. Check exact declaration identities plus unknown and ambiguous receivers. |
| ZIG-02 | Coverage audit | Local imports and build-module/static-gating behavior live in separate suites. | Keep these boundaries in the measurement plan and distinguish unsupported compile-time evaluation from a missing static binding.                                        |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/zig/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/zig/scope-resolver.ts).
- [zig.test.ts](../../gitnexus/test/integration/resolvers/zig.test.ts).
- [zig-local-imports.test.ts](../../gitnexus/test/integration/resolvers/zig-local-imports.test.ts).
- [zig-build-modules.test.ts](../../gitnexus/test/integration/resolvers/zig-build-modules.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
