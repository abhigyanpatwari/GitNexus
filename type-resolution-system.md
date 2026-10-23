# Type Resolution System

Type handling is active at two stages: providers extract type facts while parsing,
and the scope-resolution pipeline uses those facts to resolve references. The
`SemanticModel` supplies the declaration registries both stages use.

This document describes the source merged at
[`bbbc1b49e`](https://github.com/abhigyanpatwari/GitNexus/commit/bbbc1b49e3427c467b8ac83a112f7793109e279b),
reviewed on 2026-10-23. The [roadmap](type-resolution-roadmap.md) separates delivered
work, open gaps and historical implementation phases.

## Purpose in the Pipeline

For `svc.getUser().save()`, the analyzer needs to identify the visible `svc`, its
`getUser` declaration, the declared return type, and the `save` member owned by
that type. A same-named method elsewhere is insufficient evidence.

```text
LanguageProvider + parse workers
    ├── declarations ───────────────► SemanticModel registries
    ├── scopes / imports / types ───► ParsedFile
    └── TypeEnv ───────────────────► extraction hints / exported-type metadata

ParsedFile + SemanticModel + per-language ScopeResolver hooks
    │
    ▼
runScopeResolution
    finalize imports/scopes → propagate types → resolve references → emit edges
    │
    ▼
KnowledgeGraph → persisted index → impact / context / MCP / HTTP
```

The old call-resolution DAG and `MIGRATED_LANGUAGES` switch were removed in
RING4-1 #942. Ordinary source-language call and member resolution uses the
registered scope resolvers. COBOL has an explicit exception: its resolver uses
`scopeResolutionEdgeMode: 'callable-flow-only'`; structural CALLS/IMPORTS remain
with the COBOL processor.

## Architecture

| Component                | Active responsibility                                                      | Implementation                                                                                     |
| ------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `LanguageProvider`       | Parsing rules, capture emission, type extraction and language syntax       | [language-provider.ts](gitnexus/src/core/ingestion/language-provider.ts), `languages/<language>/`  |
| `TypeEnvironment`        | Temporary per-file type hints used during extraction                       | [type-env.ts](gitnexus/src/core/ingestion/type-env.ts), `type-extractors/`                         |
| `ParsedFile`             | Per-file declarations, scopes, imports, type bindings and reference sites  | [parsed-file.ts](gitnexus-shared/src/scope-resolution/parsed-file.ts)                              |
| `SemanticModel`          | Authoritative symbol, type, method and field registries                    | [semantic-model.ts](gitnexus/src/core/ingestion/model/semantic-model.ts)                           |
| Scope-resolution indexes | Finalized scope/import bindings, definition indexes and method dispatch    | [finalize-orchestrator.ts](gitnexus/src/core/ingestion/finalize-orchestrator.ts)                   |
| `ScopeResolver`          | Language rules used during reference resolution and edge emission          | [scope-resolver.ts](gitnexus/src/core/ingestion/scope-resolution/contract/scope-resolver.ts)       |
| Shared resolution passes | Receiver typing, return propagation, overload selection and graph emission | [run.ts](gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts), `scope-resolution/passes/` |

`LanguageProvider` and `ScopeResolver` have different lifecycles: one runs while
extracting a file; the other participates in workspace resolution. Keep shared
algorithms language agnostic and provide language behavior through hooks.

### Main files

- [parse-worker.ts](gitnexus/src/core/ingestion/workers/parse-worker.ts) builds
  `TypeEnv`, extracts symbols and serializes per-file facts.
- [scope-extractor.ts](gitnexus/src/core/ingestion/scope-extractor.ts) builds scope
  and type-binding facts from provider captures.
- [phase.ts](gitnexus/src/core/ingestion/scope-resolution/pipeline/phase.ts)
  iterates [SCOPE_RESOLVERS](gitnexus/src/core/ingestion/scope-resolution/pipeline/registry.ts).
- [run.ts](gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts) finalizes,
  resolves and emits using the model and provider hooks.
- [lookup-core.ts](gitnexus-shared/src/scope-resolution/registries/lookup-core.ts)
  implements shared registry lookup, including receiver-owner lookup.

The `crossFile` phase is now an accumulator-disposal boundary. It does not run
`runCrossFileBindingPropagation` or re-parse files for legacy call resolution.
Cross-file resolution happens through finalized imports and scope-resolution
passes such as `propagateImportedReturnTypes`.

## Supported Languages

Use [SCOPE_RESOLVERS](gitnexus/src/core/ingestion/scope-resolution/pipeline/registry.ts)
as the registration inventory. Registration means the resolver runs; it does not
prove that every type, receiver shape or dispatch feature is supported.

The receiver benchmark has its own language and shape inventory. Read its
[baseline](gitnexus/bench/receiver-resolution/baseline.json) for measured cases,
including deliberate untyped controls, unsupported shapes and N/A entries.
Optional grammar availability must be recorded separately from resolver results.

## Design Constraints

- Prefer an unresolved reference over an edge to an unrelated declaration.
- Honor lexical shadowing, imports, declaration ownership and package visibility.
- Keep language syntax in providers and shared resolution algorithms generic.
- Bound propagation and chain walks; do not describe them as compiler-grade inference.
- Record unresolved receiver outcomes so impact results can expose lower bounds.
- Distinguish a supported fixture from general language-feature completeness.

## TypeEnvironment Model

`buildTypeEnv()` creates a temporary environment for one parsed file. Its provider's
`typeConfig` supplies declaration, parameter, initializer, loop and pattern hooks.
The helper also has bounded assignment propagation and optional model/import
lookup inputs.

The production parse worker does **not** supply those optional global model or
import-binding inputs. It supplies file/name hooks and an empty `parentMap`.
Consequently, the helper's optional APIs and unit tests are not evidence that the
worker performs workspace-wide inference.

### Scope model

The local environment separates file-scope and function-scope entries. Lookup can
also consult position-specific pattern overrides and resolve special receivers
through AST context. This local environment is distinct from the finalized
`Scope.typeBindings` used by workspace resolution.

Correct capture ownership still matters. For example, the receiver baseline
records a Ruby YARD parameter-binding leak between sibling functions; separate
local maps in `TypeEnv` do not prove that a provider's scope captures are isolated.

### Scope keys

Function-local TypeEnv keys include function identity and source position;
file-level entries use the empty-string scope. Treat these as helper data, not as
interchangeable with `ScopeId`s in the scope-resolution indexes.

Only file-scope TypeEnv bindings cross the worker boundary into
[BindingAccumulator](gitnexus/src/core/ingestion/binding-accumulator.ts). They
support exported-type metadata enrichment. Function-local TypeEnv maps are not
serialized as a second workspace resolver.

## Lookup Semantics

TypeEnv lookup supplies extraction-time hints. Authoritative reference resolution
uses the lexical scope chain, finalized imports, `Scope.typeBindings`, member
ownership and method dispatch. The semantic model provides declarations; the
scope indexes provide visibility and binding context.

The model registries are populated during parsing. `reconcileOwnership` repairs
provider ownership before the orchestrator narrows the model to its read-only
interface. Scope type bindings may still be refined by ordered propagation and
call-result passes; read-only registry access does not freeze all binding maps.

`finalizeScopeModel` returns an index bundle used directly by the orchestrator.
The model also exposes optional `scopes` / `attachScopeIndexes` APIs, but no
production attachment call is present in the reviewed source. Do not depend on
`model.scopes` being populated merely because the API exists.

## Resolution Tiers

Tier 0/1/2 names describe the TypeEnv helper and historical delivery phases. They
are not separate current pipeline phases or a second call-resolution engine.

### Tier 0: Explicit Type Annotations

Provider hooks read declaration and parameter annotations. Scope capture hooks
also emit type-binding facts for workspace resolution. Preserve qualified names
and declaration context when a simple name would lose import or ownership proof.

### Tier 0b: For-Loop Element Type Resolution

The extraction helper can derive loop-variable hints from container annotations
and provider-specific iterable rules. Workspace subscript/accessor resolution is
separate: `ScopeResolver.elementTypeOf` supplies element types while folding a
receiver chain. Loop support does not establish support for `repos[0].save()`.

### Tier 0c: Pattern Binding

Providers may extract pattern variables or position-specific narrowing facts.
Support is construct-specific. Optional bindings, branch narrowing and general
union or pattern analysis must not share a blanket supported/unsupported label.

### Tier 1: Initializer / Constructor Inference

Providers identify initializer shapes and constructor candidates. A call-looking
expression is not sufficient proof that its callee is a class. Workspace lookup
must retain import, type-kind and ownership evidence.

### Tier 2: Assignment Chain Propagation

TypeEnv retains a bounded pending-assignment fixpoint. The current scope pipeline
also follows type references, propagates imported return types and applies precise
call-result bindings from resolved callees. Document the path being changed;
helper-level inference does not imply whole-program propagation.

## Container Type Descriptors

Type-extractor helpers describe known container parameters and selected accessors.
The workspace resolver's `elementTypeOf` hook is a separate contract. Both the
container type evidence and a supported access route are needed to type an element.

### Examples of descriptor-driven behavior

An array's element type and a map's key/value types are different facts. A loop
binding, `.values()` call and subscript expression may use different hooks. Test
each supported spelling and retain unresolved controls for missing evidence.

## Comment-Based Types

JSDoc, PHPDoc and YARD can supply type facts through provider hooks. Their presence
alone does not establish receiver resolution: capture ownership, normalization,
container metadata and return declarations must survive into scope resolution.
See the [typed receiver-shape baseline](gitnexus/bench/receiver-resolution/BASELINE.md)
for supported cases and remaining gaps.

## SymbolTable Interaction

`model.symbols` is the file/name-oriented symbol table; `model.types`,
`model.methods` and `model.fields` provide type- and owner-oriented lookups.
`WorkspaceResolutionIndex` holds derived scope and return-fact lookups needed by
the resolver. Keep declaration registries authoritative rather than introducing
a parallel symbol store.

## Deferred Binding Verification in Call Processing

Deferred verification now belongs to the scope-resolution path. The orchestrator
uses finalized references and declared return facts to refine call-result
bindings, and receiver passes consult owned members and dispatch indexes.
References to `call-processor.ts` as the production resolver describe the removed
DAG, not a route contributors should extend.

## Language Feature Matrix

Use source-pinned fixtures instead of the former broad Yes/No matrix:

| Evidence                  | What it establishes                              | What it does not establish                        |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| Provider extraction test  | A construct emits the expected facts             | Correct cross-file ownership or dispatch          |
| Resolver integration test | Exact targets/drops for the supplied fixture     | General language parity                           |
| Receiver shape baseline   | Exact target or recorded gap for each fixed case | Language-wide completeness or arbitrary inference |
| Fixed resolution corpus   | Edge/drop comparison on that corpus              | Coverage of spellings absent from the corpus      |
| Optional-grammar skip     | The parser is unavailable in that environment    | A passing resolver case                           |

## Current Strengths

The merged receiver series adds package-qualified factories, ownership and
visibility corrections, C# nullable fields, selected Rust smart-pointer fields,
Swift/Dart hoisted returns and additional receiver-chain spellings. The
[roadmap](type-resolution-roadmap.md#delivered-receiver-series) links each merged PR.

For the merged source, the receiver baseline records 138 call drops, 168 total
drops, 30 reads and no writes. These are measurements, not proof that remaining
gaps are external or that every emitted edge has the correct owner.

## Current Limitations

The baseline and targeted review tests retain these limits:

- Ruby YARD parameter facts can leak between sibling functions with the same
  parameter name; the typed shape fixtures use distinct names as a workaround.
- Indexed receivers remain visible gaps in JavaScript, Ruby, PHP and Swift;
  correct container metadata and `elementTypeOf` support are needed.
- C++ explicit type arguments are read by the chain walker, but a template return
  such as `T` is not generally substituted with the supplied concrete type.
- Dart callable-return flow and argument-aware Swift inherited-overload selection
  remain incomplete. Supported exact override cases do not establish label- or
  generic-aware dispatch.
- General type checking, union analysis and arbitrary inference remain outside
  the conservative receiver-resolution contract.

See the [current backlog](type-resolution-roadmap.md#current-backlog) and
[language gap inventories](docs/languages/README.md) for scope and validation boundaries.

## Contributor Notes

1. Change parsing/capture facts in the owning `languages/<language>/` provider.
   Change language-independent algorithms in shared scope-resolution passes.
2. Keep `ParsedFile` as the per-file resolution artifact; reuse extracted facts
   and cached trees rather than adding another parse representation.
3. Run graph impact before symbol edits and change detection before commits,
   following AGENTS.md. An empty or historical graph is not an all-clear.
4. Test full target identities, same-name decoys, missing annotations, shadowing
   and sibling scopes. Absence-only assertions need a supported positive control.
5. Treat exported but unwired APIs separately from active paths. In this source,
   `resolveTypeRef` is exported and unit-tested but has no production caller;
   registry lookup performs receiver-owner resolution directly. Review API users
   and behavior before consolidating or removing either implementation.
