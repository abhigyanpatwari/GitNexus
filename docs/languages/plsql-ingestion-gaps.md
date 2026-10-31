# Oracle PL/SQL Ingestion Gaps

Initial inventory for the `experimental` PL/SQL provider. The provider is a
standalone ANTLR4 path (COBOL precedent): `plsql-processor.ts` owns every
structural edge, and the registered resolver runs in
`scopeResolutionEdgeMode: callable-flow-only`, contributing declarations and
the source bindings rename relies on. Nothing below is a whole-language
completeness claim.

## What is modelled

| Construct                                                    | Graph                                                                    | Evidence                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Package spec + body (`.pks`/`.pkb`/`.pck`, or `.sql`)        | One `Module`, anchored at the spec, `CONTAINS` from every defining file  | `plsql.test.ts`                                                            |
| Package procedure/function, nested subprogram, standalone, trigger | `Function`; `isExported` = declared in the spec (package members)  | `plsql.test.ts`                                                            |
| Calls: local, nested, `pkg.proc`, `schema.pkg.proc`          | `CALLS` (`plsql-call`); overloads narrowed by arity and named arguments  | `plsql.test.ts` (overload line check)                                      |
| `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`MERGE`/`LOCK`, trigger target | `Record` per table, `ACCESSES` with `reason: plsql-<op>`           | `plsql.test.ts`, `plsql-extract.test.ts`                                   |
| SQL*Plus `@@script`, `@script`, `START script`               | `IMPORTS` File → File (exact paths only)                                 | `plsql.test.ts`, `external-import-conformance.test.ts`                     |
| Rename of a package or subprogram                            | Spec, body, `END` label and qualified call sites together                | `rename-integration/plsql/`                                                |

Deliberately no edge: built-ins (`TRUNC`, `DBMS_OUTPUT.PUT_LINE`) and any call
that does not resolve to a definition in the repository; calls over a database
link; CTE names; `DUAL`; scripts that are not at an exact repository path.

## Parser robustness

Grammar: grammars-v4 `sql/plsql` (Apache-2.0) generated with antlr-ng for
antlr4ng; see `gitnexus/src/core/ingestion/plsql/generated/README.md`.

- A line-preserving pre-pass blanks SQL*Plus client commands (only between
  statements), neutralises `&` substitution variables at equal length and
  resolves conditional compilation by keeping the first branch of every
  `$IF` (nesting-aware). Token positions remain original source positions.
- Files are split into `/`-terminated segments; each is parsed SLL-first,
  falls back to LL with error recovery, and has a wall-clock deadline.
- A segment with syntax errors keeps whatever the recovered tree yields and
  gains regex-level definitions for any subprogram the tree lost
  (`fromFallback`, lower edge confidence, rename refused).
- The parse deadline scales with segment size (10 s floor, 15 ms/line;
  `GITNEXUS_PLSQL_SEGMENT_DEADLINE_MS` overrides the floor, 0 disables), so
  large valid package bodies are not cut off on a cold DFA cache.
- Sites (calls, accesses) are owned by the innermost enclosing definition by
  position, so overloads keep their own edges.
- Same-named packages in different folders stay separate: a body pairs with
  the nearest spec, and call ties are broken by path proximity. Rename
  families stay within one package instance.

Spike measurement (801 files / 245k lines from utPLSQL, OraOpenSource Logger,
Alexandria PL/SQL utils, OOS-Utils and Oracle db-sample-schemas): 97.6% of
package/procedure/function/trigger files parse without syntax errors; about
175 ms per 1,000 lines once the ANTLR DFA cache is warm, about 650 ms cold.

## Planning candidates

| ID        | Evidence                | Gap or boundary                                                                                     | Next planning step and acceptance                                                                                       |
| --------- | ----------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| PLSQL-01  | Corpus measurement      | Call and table-access recall is proven on fixtures, not measured on large real package bodies.      | Hand-label a sample of real packages; report recall/precision per edge kind before promoting from `experimental`.       |
| PLSQL-02  | Grammar gaps            | `TREAT(x AS t).m()`, newer keywords used as identifiers (`ANNOTATIONS`, `XDB`), some object-type member syntax. | Upstream grammar fixes to grammars-v4; regenerate; re-run the corpus.                                       |
| PLSQL-03  | Ambiguity               | An argument-less function call in an expression is indistinguishable from a variable or column.     | Resolve against local declarations first; keep rename refusing until then.                                               |
| PLSQL-04  | Dynamic SQL             | `EXECUTE IMMEDIATE` sites are recorded but produce no edges; only literal text is kept.             | Constant-fold `l_sql := '…'` assignments and parse literal statements as low-confidence edges.                          |
| PLSQL-05  | Not modelled            | Object types (`CREATE TYPE … AS OBJECT`, `UNDER`, member methods), synonyms, views' column lineage. | Decide labels (`Class`/`Method`, `EXTENDS`) and schema impact with maintainers; separate PR.                           |
| PLSQL-06  | Identity                | Tables are keyed by unqualified name; same-named tables in two schemas merge.                        | Key by `SCHEMA.TABLE` when written and reconcile unqualified references through synonyms / current schema.             |
| PLSQL-07  | Performance             | The phase runs on the main thread before parse: the corpus above (618 claimed files, 121k lines) takes ~60 s cold in one process; facts are shared with scope extraction within a run but not persisted across runs. | Move segment parsing to workers (one warm ANTLR DFA each); persist extracted facts in the parse cache keyed by content hash so incremental runs skip unchanged files.                         |
| PLSQL-09  | Overload fan-out        | Overloads that differ only by parameter type (e.g. utPLSQL `ut.expect`) cannot be narrowed by arity, so each call gets one 0.5-confidence edge per candidate (3,170 ambiguous sites on the corpus after path-proximity narrowing). | Infer argument types from literals and declared variables/parameters; narrow by declared parameter types. |
| PLSQL-13  | SQL*Plus-only scripts   | A `.sql` file holding only SQL*Plus commands (e.g. `EXEC pkg.proc;`), with no Oracle unit or include, is not claimed because `EXEC` is also T-SQL; rename cannot see such a caller. Rename does refuse when a claimed file's SQL*Plus command names the target. | Claim such scripts when they sit in a tree that holds Oracle sources, or parse `EXEC` bodies as call sites. |
| PLSQL-11  | Cross-language rename   | Java/Kotlin/XML code that calls procedures by string (`{call pkg.proc(?)}`, MyBatis `CALLABLE`) is not consulted by rename. | Implement the rename interop hooks, or refuse when a non-PL/SQL source mentions the qualified name.                      |
| PLSQL-12  | Incremental identity    | Table `Record` and merged package `Module` nodes are anchored to one file although derived from several. | Add an edit-one-file incremental-analyze test; give synthetic objects a stable anchor if writeback drops them.            |
| PLSQL-10  | Impact on tables        | `impact` adds `ACCESSES` by default only for `Class`/`Interface` targets, so a table needs `relationTypes: ['ACCESSES', …]` to list its readers and writers. | Agree with maintainers whether `Record` targets should get the same default.                                              |
| PLSQL-08  | CFG/PDG                 | `collectSourceCfgs` returns no CFGs.                                                                | Build statement-level CFGs from the parse tree for `analyze --pdg`.                                                      |

## Code and regression entry points

- [Provider](../../gitnexus/src/core/ingestion/languages/plsql.ts) and [hooks](../../gitnexus/src/core/ingestion/languages/plsql/).
- [Parser, pre-pass and extraction](../../gitnexus/src/core/ingestion/plsql/).
- [Processor](../../gitnexus/src/core/ingestion/plsql-processor.ts) and [phase](../../gitnexus/src/core/ingestion/pipeline-phases/plsql.ts).
- [plsql.test.ts](../../gitnexus/test/integration/resolvers/plsql.test.ts),
  [plsql-extract.test.ts](../../gitnexus/test/unit/plsql-extract.test.ts),
  [plsql-preprocess.test.ts](../../gitnexus/test/unit/plsql-preprocess.test.ts),
  [rename fixtures](../../gitnexus/test/fixtures/rename-integration/plsql/).
