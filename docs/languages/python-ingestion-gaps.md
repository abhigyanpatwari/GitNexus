# Python Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                       |
| ----------------------- | -------------- | --------------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.get_user().save()`                       |
| `plainDeepChain`        | RESOLVES       | `svc.get_user().address.save()`               |
| `optionalChain`         | N/A            | Python has no optional-chaining operator.     |
| `nonNullAssert`         | N/A            | Python has no non-null assertion operator.    |
| `awaitParen`            | RESOLVES       | `(await svc.get_user_async()).save()`         |
| `explicitTypeArgs`      | N/A            | Python has no call-site type-argument syntax. |
| `indexElement`          | RESOLVES       | `repos[0].save()`                             |
| `fieldReceiverCall`     | RESOLVES       | `self.repo.save()`                            |
| `decoratedReceiverBase` | N/A            | Python `self` carries no type decoration.     |
| `decoratedFieldType`    | RESOLVES       | `self.repo.save()`                            |

All applicable measured cells resolve, including awaited, indexed and decorated-field receivers. The row does not establish support for every dynamic Python expression or every cross-module binding.

## Value reads and callable arguments

Bare names produce `ACCESSES` edges in binary, comparison and boolean expressions,
returns, assignment right-hand sides, parameter defaults, and direct positional or
keyword call arguments. Defaults belong to the enclosing definition scope. Type
annotations are excluded, and method reads use lexical bindings rather than
implicitly reading a same-named class field.

A function passed directly as a bare-name call argument produces a `USES` edge,
including imported aliases and nested functions. Passing a function does not add
a `CALLS` edge. Existing FastAPI `Depends` default invocations retain their call
edges without extra value-reference edges.

Bare reads are not captured in conditions, iterables, subscripts, augmented
assignments, f-strings, collection literals, conditional expressions, starred
arguments or attribute receivers. Callable value references do not cover attribute
arguments (`mod.helper`, `self.method`), collection entries, local aliases,
parameter defaults or classes passed as callables.

Two lookup limits still omit edges: a global write in another function can block
readers in the same file, and an imported module variable assigned more than once
does not resolve. Same-file reads of that reassigned variable still resolve.
[Value-reference regressions](../../gitnexus/test/integration/resolvers/python-value-references.test.ts)
cover these limits, scope ownership, shadowing and callable arguments.

## Planning candidates

| ID        | Evidence       | Gap or boundary                                                                                    | Next planning step and acceptance                                                                                                                                                                       |
| --------- | -------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PYTHON-01 | Coverage audit | No failing cell is recorded; constructor-field receivers and module semantics have separate tests. | Map those suites to the language inventory, then add any missing exact-owner and import-shadowing cases. Require a current reproduction before labeling dynamic or cross-module behavior a product gap. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/python/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/python/scope-resolver.ts).
- [python-constructor-field-receiver.test.ts](../../gitnexus/test/integration/resolvers/python-constructor-field-receiver.test.ts).
- [python-namespace-semantics.test.ts](../../gitnexus/test/integration/resolvers/python-namespace-semantics.test.ts).
- [python-module-accessors.test.ts](../../gitnexus/test/integration/resolvers/python-module-accessors.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
