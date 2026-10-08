# R Language Provider

Status: implemented (experimental)

The provider is covered by unit and integration tests, listed under [Tests](#tests). It is classified as experimental in the language support table. This status describes what is implemented today; it does not promise R's dynamic dispatch.

## Scope

GitNexus indexes `.r` and `.R` files with the `@eagleoutice/tree-sitter-r` grammar and resolves them through the scope-resolution pipeline (see ARCHITECTURE.md, Scope-Resolution Pipeline). R-specific logic lives in `gitnexus/src/core/ingestion/languages/r/`, with the per-language extractor and import-resolver files beside those of the other languages. Shared ingestion code does not name R; the provider plugs in through `LanguageProvider` and `ScopeResolver` hooks.

R has no class syntax: classes are function calls (`R6Class(...)`, `setClass(...)`, `setRefClass(...)`) and package exports live in a NAMESPACE file rather than in the source. That is why the provider uses two optional hooks, `postParse` (attach each member to its owner and refine export status once every file is parsed) and `resolveMemberOwnerNode` (name the owner of a member from a call rather than an enclosing node).

## Supported constructs

Definitions:

- Functions defined by assignment (`<-`, `=`, `<<-`). S3 methods appear as ordinary functions with dotted names such as `print.foo`.
- S4 classes (`setClass`), generics (`setGeneric`), methods (`setMethod`) and slots (`representation`, `slots`).
- R6 classes with their methods, fields and active bindings.
- RefClass (`setRefClass`) classes with their methods and fields.
- The argument that names an S4 or RefClass class, a generic or a method is the argument spelled with the first formal (`Class=`, `name=`, `f=`) wherever it sits, else the first unnamed argument (so a later `Class=` takes the formal from an earlier unnamed argument, as in R). Other strings (`contains=`, `valueClass=`, a `setMethod` signature) create no node.

Types:

- `x <- Type$new()` (R6, RefClass) and `x <- new("Class")` (S4) type `x`. Resolution of `x$method()` is asserted by tests for R6 only; the S4 `new()` binding is unit-tested only.
- roxygen2 `@param` types in a restricted form: the description is the type alone (`#' @param name Type`) or starts with it in braces (`#' @param name {Type} prose`), the type is an R6, S4 or RefClass class defined in the same file, and the name is a formal of the function the block documents. The type is bound inside that function only. Prose that begins with a capitalised word binds nothing. Other roxygen2 tags (`@return`, `@field`, `@inheritParams`, `@rdname`, `@noRd`, `@export`) are not read.

Imports:

- `library()` and `require()` resolve to local packages, and `source()` to local files. The argument is `package=` / `file=` wherever it sits, else the first unnamed argument after any named one; named-first arguments such as `lib.loc=` and `local=` are not imports.
- NAMESPACE `importFrom()` names bind to definitions in local packages.

Calls:

- Free calls, `obj$method()` calls (receiver typed as above), R6 `self$method()` calls, and calls inside native pipe (`|>`) chains.
- Named nested functions (closures) are indexed, and calls inside attribute to the nested function, which can shadow a top-level name. Top-level script calls outside any function are attributed to the File node.
- `pkg::fn()` and `pkg:::fn()`, decided by the qualifier (see [Resolution model](#resolution-model)).

Heritage:

- R6 `inherit=` and S4 `contains=` (a single class or `c(...)`). `contains = "VIRTUAL"` links to one placeholder class named `VIRTUAL`.

Exports:

- Read from each local package's NAMESPACE: `export()`, `exportClasses()`, `exportMethods()`, `S3method()` and `exportPattern()`. `S3method(generic, class, method)` exports `method`, the function R registers, else `generic.class`. A `DESCRIPTION` file with a `Package:` line marks a package root.

## Resolution model

The scope query (`languages/r/query.ts`) captures three call shapes only: `f(x)`, `pkg::f(x)` and `obj$f(x)`.

- A bare call binds lexically first. `library()` and `require()` of a local package make every top-level name of that package visible, unfiltered by NAMESPACE. `source()` binds no name; a call into a sourced file, or into another file of the same package, binds through a workspace-wide unique-name fallback at confidence 0.5 (`global-name-fallback`). An ambiguous name yields no edge.
- A bare call never binds to a dotted definition, so `foo(x)` cannot reach `print.foo`. Dotted (S3-style) names are never import-resolved; a call that spells the full dotted name binds by qualified-name lookup. Dotted names are not bound through `importFrom()`.
- `pkg::name()` is decided by its qualifier:
  - `pkg` is a package of the repository and defines `name` exactly once: the call binds to that definition at confidence 0.85 (`import-resolved`).
  - `pkg` is certainly not a repository package (discovery completed and found no such package, including a repository with no `DESCRIPTION`): no edge.
  - `pkg` defines `name` more than once: no edge.
  - Discovery may have missed a package (its limits were reached): the call keeps the name-based behaviour.
- `::` and `:::` are not distinguished, so `pkg::name` binds to a definition whether or not the package exports it.
- Package discovery is bounded to depth 3 and 200 directories (when the bound may have hidden a package this is flagged internally and nothing is logged), reads directories in code-unit order, ranks duplicate package names by shallowest then by whole path, and never searches directories named exactly `renv`, `packrat`, `revdep` or `<name>.Rcheck`. The shared file scanner has no such ignore entries, so `.R` files inside those trees are still parsed even though discovery skips them.
- Export status: the language-level export check treats every symbol as public. The NAMESPACE pass then marks the remaining `R/` symbols of a NAMESPACE-bearing package non-exported. Symbols outside `R/` (`tests/`, `vignettes/`, `inst/`) are not package members and stay public; files in `R/` subdirectories are treated as `R/` files although R itself does not load them. A package without a NAMESPACE stays fully public, and a nested package without one does not inherit its enclosing package's. roxygen2 `@export` tags are not consulted.
- `exportPattern()` text comes from the analysed repository, so patterns are compiled to a linear-time automaton (`linear-regex.ts`) with a work budget. Constructs with no linear-time algorithm (back-references, look-around) and oversized patterns are dropped with one logged warning per pattern per package. Character classes use ASCII semantics.

## Limits and known gaps

Not edges or nodes:

- A function passed as a value (`lapply(x, f)`, `Map`, `lapply(x, pkg::f)`), dynamic calls (`do.call("f", ...)`, `match.fun()`, `get()`) and dispatch through a registry (`handlers[["a"]]()`) create no CALLS edge, because only the three call shapes above are captured; the cross-language callable-value analysis classifies R as not applicable.
- R6 `super$method()` and `private$method()` calls, S4 slot access (`obj@slot`), and `UseMethod()` / `NextMethod()` create no edge.
- Anonymous functions (`function(x)`, `\(x)`) passed as arguments are not indexed as definitions; calls inside are attributed to the enclosing function, or to the File at top level.
- Infix operators (`a %op% b`) are not linked to their definitions.
- Constants and other top-level non-function assignments, and environments (`new.env()`, `local()`, `assign()` / `get()`), are not nodes; the only value-like nodes are R6, RefClass and S4 fields and slots. `setValidity()`, `setClassUnion()`, `setReplaceMethod()` and `Class$methods(...)` create no definition or edge.
- No framework or entry-point detection (Shiny, plumber, targets, testthat). Plumber `#*` annotations are not read and no route nodes are created, and no route or fetch edges link R to other languages.

Not supported:

- The magrittr pipe `%>%` has no specific support and none is claimed; the native pipe `|>` is supported. tidyverse non-standard evaluation (bare column names, `.data$x`) is not modelled.
- `.Rmd` and `.qmd` files are not indexed (the provider handles `.r` and `.R` only; `.Rprofile` and `.Renviron` are not indexed either), and `box::use()`, `import::from()`, `loadNamespace()`, `attachNamespace()` and `sys.source()` imports are not read.
- S3 dispatch is not resolved: S3 methods are indexed as functions only. S4 and RefClass dispatch is not resolved either; there are definitions and heritage, not dispatch edges.
- NAMESPACE `import()`, `importClassesFrom()` and `importMethodsFrom()` are not read. Imports of external (CRAN) packages produce no edges.
- S4 `contains=` links only to classes defined in the repository or the `VIRTUAL` marker; basic-type bases such as `"numeric"` add no edge.
- Package discovery is bounded (depth 3, 200 directories), so a package beyond the bound is treated like an unknown one. A package found only under `renv`, `packrat`, `revdep` or `<name>.Rcheck` is not a repository package.
- A `pkg::name` whose package does not itself define `name` (for example a re-export) can still bind to a same-file or `importFrom` candidate, a `::` to a name the package does not export still binds to its definition, and `pkg::name` used as a value is not qualifier-resolved. Call sites dropped for certainly-external packages or duplicate definitions leave no recorded outcome.
- When discovery may have missed a package, a `pkg::name` call keeps the name-based behaviour even if the candidate sits in a different package.
- Files in `R/` subdirectories are treated as package-owned, although R itself does not load them.
- NAMESPACE is read from disk during analysis, but neither it nor `DESCRIPTION` is a parsed source file. After an edit to either alone, an incremental analyse (no `--force`) keeps stale manifest-derived data: the persisted `isExported` of symbols in unchanged `R/` files, a `CALLS` edge bound through an `importFrom()` whose target changed, and a `pkg::fn` edge after a `Package:` rename. A full analyse is correct and `analyze --force` recomputes it. This is a limitation of the shared incremental write path (only changed files are re-processed), not of R resolution; other language manifests that feed resolution can be affected in the same way. It is to be addressed in a follow-up.
- Roxygen `@param` types live in the per-file type environment; no graph edge consumes them.
- Argument matching follows R for named and reordered arguments but does not model partial argument names: `setClass(Cla = "D")`, `new(Cla = "E")`, `setRefClass(Cla = "A")` and `setMethod("show", sig = "Foo")` are not recognised, so no definition or owner is attached.
- Members are read only from the named forms. The positional second argument of `setClass("A", representation(x = "numeric"))`, `R6Class("X", list(...))` and `setRefClass("A", list(...))` creates no field or slot nodes; use `slots=` / `representation=`, `public =` / `private =` / `active =` and `fields =`.
- For `S3method(generic, class, method)` the positional third argument names the exported method. A named third argument such as `S3method(print, foo, method = impl)` is not read: R registers `impl`, but the export is recorded for `print.foo`.

### Bounds on NAMESPACE exportPattern matching

- Matching work and NFA states are counted in deterministic work units, never wall-clock time, so the outcome is the same on every machine. A NAMESPACE file is still read in full.
- Caps, in `linear-regex.ts`: `MAX_TOTAL_WORK` (40,000,000 state visits per matcher), `MAX_SHARED_WORK` (100,000,000 matching visits per load), `MAX_PACKAGE_WORK` (30,000,000 per package), `MAX_SHARED_STATES` (500,000 NFA states per load) and `MAX_PACKAGE_STATES` (100,000 per package); a single pattern is also capped by `MAX_PATTERN_LENGTH` (16,384 characters) and `MAX_STATES` (16,384).
- A pattern that does not fit is dropped, exports nothing and is warned about: at most 50 patterns are named per package (`MAX_LISTED_DROPPED_PATTERNS`), followed by a summary line counting the rest.
- The first pattern refused for lack of states closes that package's allowance, so later patterns in the package are refused without being parsed.
- One hostile package cannot exhaust the load budget alone (it is limited to its own share), but several can (three, for matching work); packages processed after that degrade, with warnings. Which package degrades follows graph node order.
- Explicit `export()` names are unaffected by these bounds.

## Type annotations

R has no inline type annotations, so the "Type Annotations" column of the language support table is not ticked for R. The roxygen2 `@param` extraction above is a comment-based fallback, in the same class as the JSDoc, PHPDoc and YARD fallbacks listed in type-resolution-system.md (Ruby's YARD support is likewise not ticked).

## Extending the provider

- Definition captures are in `R_QUERIES` (`tree-sitter-queries.ts`); scope, import, type-binding, heritage and reference captures are in `languages/r/query.ts`. Keep each declaration pattern and its matching `@scope.function` pattern in lockstep, as the comments in `query.ts` explain.
- The captures for `setClass`, `setRefClass`, `setGeneric`, `setMethod` and for `library` / `require` / `source` are deliberately loose. The argument that names the definition or the import is chosen afterwards in `languages/r/naming-argument.ts`, because a query-level prefix that skips leading comments and named arguments is quadratic in the argument count.
- Resolution wiring is in `languages/r/scope-resolver.ts`, registered in `SCOPE_RESOLVERS`. Package discovery and NAMESPACE parsing are in `package-config.ts` and `namespace-imports.ts`; qualified calls in `qualified-call.ts`; owner and export post-processing in `post-parse.ts` and `owner-hooks.ts`.
- Changing what the scope query captures changes what cached parsed files contain, so raise `SCHEMA_BUMP`.
- Shared code under `gitnexus/src/core/ingestion/` must not name languages; add behaviour through the provider hooks.

## Tests

Unit tests are under `gitnexus/test/unit/` (`r-*.test.ts`, `type-env-r.test.ts` and `scope-resolution/r/`) and integration tests under `gitnexus/test/integration/resolvers/` (`r*.test.ts`), with `r-*` fixture projects in `gitnexus/test/fixtures/lang-resolution/`. They cover:

- definitions, owners and the naming-argument rules (`r-definition-anchors`, `r-owner-hooks`, `r-post-parse-owners`, `r-scope-naming-argument`, `r-s4-anchors`, `r-s4-formals`, `r-scope-args`);
- NAMESPACE parsing, exports and `exportPattern()` safety and scale (`r-namespace-parser`, `r-namespace-exports`, `r-export-pattern*`, `r-export-status-*`);
- package discovery and root-package imports (`r-package-discovery-*`, `r-import-root-package`, `r-namespace-imports`);
- qualified calls, dotted S3 names and native pipes (`r-qualified-*`, `r-dotted-s3-collision`, `r-native-pipes` fixture in `r.test.ts`);
- roxygen2 `@param` types (`type-env-r`, `r-roxygen-param`).
