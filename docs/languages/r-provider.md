# R Language Provider

Status: implemented (experimental)

The provider is covered by unit and integration tests, listed under [Tests](#tests). It is classified as experimental in the language support table. This status describes what is implemented today; it does not promise R's dynamic dispatch.

## Scope

GitNexus indexes `.r` and `.R` files with the `@eagleoutice/tree-sitter-r` grammar and resolves them through the scope-resolution pipeline (see ARCHITECTURE.md, Scope-Resolution Pipeline). R-specific logic lives in `gitnexus/src/core/ingestion/languages/r/`, with the per-language extractor and import-resolver files beside those of the other languages. Apart from the registrations every language has (the language enum, the file-extension and classification tables, the export-checker table, the grammar loader and parse-worker grammar map, and the query, provider and scope-resolver registries), shared ingestion code does not name R; the provider plugs in through `LanguageProvider` and `ScopeResolver` hooks.

R has no class syntax: classes are function calls (`R6Class(...)`, `setClass(...)`, `setRefClass(...)`) and package exports live in a NAMESPACE file rather than in the source. That is why the provider uses three optional hooks: `postParse` (attach each member to its owner and refine export status once every file is parsed), `resolveMemberOwnerNode` (find the owner of a member from a call rather than an enclosing node) and `resolveDetachedOwnerName` (qualify a member's id with its class, so two classes in one file that share a member name stay distinct nodes: `Method:R/a.R:Stack.push#0`, `Property:R/a.R:Stack.items`).

## Supported constructs

Definitions:

- Functions defined by assignment (`<-`, `=`, `<<-`). S3 methods appear as ordinary functions with dotted names such as `print.foo`.
- S4 classes (`setClass`), generics (`setGeneric`), methods (`setMethod`) and slots (`representation`, `slots`).
- R6 classes with their methods, fields and active bindings.
- RefClass (`setRefClass`) classes with their methods and fields.
- Slots and fields given as `list(...)`, `representation(...)` or `c(...)`. A named entry (`c(a = "numeric")`) records its type; an unnamed string in `slots = c("a", "b")` or `fields = c("a", "b")` names an untyped member, as in R. An unnamed string in `representation(...)` or `list(...)` is not a member.
- The argument that names an S4 or RefClass class, a generic or a method is the argument spelled with the first formal (`Class=`, `name=`, `f=`) wherever it sits, else the first unnamed argument (so a later `Class=` takes the formal from an earlier unnamed argument, as in R). Other strings (`contains=`, `valueClass=`, a `setMethod` signature) create no node.

Types:

- `x <- Type$new()` (R6, RefClass) and `x <- new("Class")` (S4) type `x`. Resolution of `x$method()` is asserted by tests for R6 only; the S4 `new()` binding is unit-tested only.
- roxygen2 `@param` types in a restricted form: the description is the type alone (`#' @param name Type`) or starts with it in braces (`#' @param name {Type} prose`), the type is an R6, S4 or RefClass class defined in the same file, and the name is a formal of the function the block documents. The type is bound inside that function only. Prose that begins with a capitalised word binds nothing. Other roxygen2 tags (`@return`, `@field`, `@inheritParams`, `@rdname`, `@noRd`, `@export`) are not read.

Imports:

- `library()` and `require()` resolve to local packages, and `source()` to local files. The argument is `package=` / `file=` wherever it sits, else the first unnamed argument after any named one; named-first arguments such as `lib.loc=` and `local=` are not imports.
- NAMESPACE `importFrom()` names bind to definitions in local packages. A name that can never bind (not exported, not defined at top level, or dotted) creates no import, so its calls keep the `global-name-fallback` guess.

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

- A bare call binds lexically first. `library()` and `require()` of a local package make every top-level name of that package visible, unfiltered by NAMESPACE. This is wider than R's `library()` of an installed package, which attaches only its exports; it follows `devtools::load_all()`, which attaches every top-level name, exported or not. `source()` binds no name; a call into a sourced file, or into another file of the same package, binds through a workspace-wide unique-name fallback at confidence 0.5 (`global-name-fallback`). An ambiguous name yields no edge.
- A bare call never binds to a dotted definition, so `foo(x)` cannot reach `print.foo`. Dotted (S3-style) names are never import-resolved; a call that spells the full dotted name binds by qualified-name lookup. Dotted names are not bound through `importFrom()`.
- `pkg::name()` is decided by its qualifier:
  - `pkg` is a package of the repository and defines `name` exactly once: the call binds to that definition at confidence 0.85 (`import-resolved`).
  - `pkg` is certainly not a repository package (discovery completed and found no such package, including a repository with no `DESCRIPTION`): no edge.
  - `pkg` defines `name` more than once: no edge.
  - Discovery may have missed a package (its limits were reached): the call keeps the name-based behaviour.
- `::` and `:::` are not distinguished, so `pkg::name` binds to a definition whether or not the package exports it.
- Package discovery is bounded to depth 3 and 200 directories (when the bound may have hidden a package this is flagged internally and nothing is logged), reads directories in code-unit order, ranks duplicate package names by shallowest then by whole path, and never searches directories named exactly `renv`, `packrat`, `revdep` or `<name>.Rcheck`. The shared file scanner has no such ignore entries, so `.R` files inside those trees are still parsed even though discovery skips them.
- Export status: the language-level export check treats every symbol as public. The NAMESPACE pass then marks the remaining `R/` symbols of a NAMESPACE-bearing package non-exported. Symbols outside `R/` (`tests/`, `vignettes/`, `inst/`) are not package members and stay public; files in `R/` subdirectories are treated as `R/` files although R itself does not load them. A package without a NAMESPACE stays fully public, and a nested package without one does not inherit its enclosing package's. roxygen2 `@export` tags are not consulted. The refinement changes the graph nodes' `isExported` only; the definitions scope resolution works from carry no export verdict, so `library()`, `pkg::name` and the global-name fallback do not consult NAMESPACE (only `importFrom()` does).
- `exportPattern()` text comes from the analysed repository, so patterns are compiled to a linear-time automaton (`linear-regex.ts`) with a work budget. Constructs with no linear-time algorithm (back-references, look-around) and oversized patterns are dropped with one logged warning per pattern per package. Character classes use ASCII semantics. A directive argument the NAMESPACE reader cannot read at all is dropped without a warning: an R 4.0 raw string (`exportPattern(r"(^[^.])")`, `export(r"(foo)")`) and any string that spans lines. It exports nothing, so the names it was meant to cover read as non-exported.

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
- NAMESPACE `exportClassPattern()` is not read. An S4 class exported only through such a pattern reads as not exported (`isExported` false), and an `importFrom()` of it does not bind; classes listed in `export()` or `exportClasses()` are read.
- S4 `contains=` links only to classes defined in the repository or the `VIRTUAL` marker; basic-type bases such as `"numeric"` add no edge.
- Package discovery is bounded (depth 3, 200 directories), so a package beyond the bound is treated like an unknown one. A package found only under `renv`, `packrat`, `revdep` or `<name>.Rcheck` is not a repository package.
- A `pkg::name` whose package does not itself define `name` (for example a re-export) can still bind to a same-file or `importFrom` candidate, a `::` to a name the package does not export still binds to its definition, and `pkg::name` used as a value is not qualifier-resolved. Call sites dropped for certainly-external packages or duplicate definitions leave no recorded outcome.
- When discovery may have missed a package, a `pkg::name` call keeps the name-based behaviour even if the candidate sits in a different package.
- Files in `R/` subdirectories are treated as package-owned, although R itself does not load them.
- NAMESPACE is read from disk during analysis, but neither it nor `DESCRIPTION` is a parsed source file. After an edit to either alone, an incremental analyse (no `--force`) keeps stale manifest-derived data: the persisted `isExported` of symbols in unchanged `R/` files, a `CALLS` edge bound through an `importFrom()` whose target changed, and a `pkg::fn` edge after a `Package:` rename. A full analyse is correct and `analyze --force` recomputes it. This is a limitation of the shared incremental write path (only changed files are re-processed), not of R resolution; other language manifests that feed resolution can be affected in the same way. It is to be addressed in a follow-up.
- A name written in backticks (`` `%+%` ``, `` `my fn` ``) keeps its backticks on the node, and a definition and its call resolve only when both spell the name alike: `` `helper`(x) `` against `helper <- function(...)` (or the reverse) gets no `CALLS` edge. NAMESPACE `export()`, `exportPattern()`, `importFrom()`, `pkg::name()` and `rename` match the symbol whichever way it is written. `importFrom(pkg, `%||%`)` binds a call spelled like the definition (`` `%||%`(x, y) ``), and a call spelled the other way gets the name-based guess instead.
- Roxygen `@param` types live in the per-file type environment; no graph edge consumes them.
- Argument matching follows R for named and reordered arguments but does not model partial argument names: `setClass(Cla = "D")`, `new(Cla = "E")`, `setRefClass(Cla = "A")` and `setMethod("show", sig = "Foo")` are not recognised, so no definition or owner is attached.
- Members are read only from the named forms. The positional second argument of `setClass("A", representation(x = "numeric"))`, `R6Class("X", list(...))` and `setRefClass("A", list(...))` creates no field or slot nodes; use `slots=` / `representation=`, `public =` / `private =` / `active =` and `fields =`.
- S4 and RefClass constructors, and the import calls, are recognised only as a bare callee: `setClass(...)`, `setRefClass(...)`, `setGeneric(...)`, `setMethod(...)`, `library(...)`, `require(...)` and `source(...)`. A namespace-qualified call such as `methods::setClass("A", slots = list(x = "numeric"))` creates no class, slot, generic or method, and `base::library("pkg")` creates no import. `R6::R6Class(...)` is recognised.
- For `S3method(generic, class, method)` the positional third argument names the exported method. A named third argument such as `S3method(print, foo, method = impl)` is not read: R registers `impl`, but the export is recorded for `print.foo`.
- A leading `]` in a bracket expression of a NAMESPACE `exportPattern()` (for example `[]a]` or `[^]a]`) is read with JavaScript RegExp semantics, not POSIX/TRE, unless the pattern also contains a POSIX class such as `[:digit:]`; R would treat that `]` as a literal member.

### Bounds on NAMESPACE exportPattern matching

- Matching work and NFA states are counted in deterministic work units, never wall-clock time, so the outcome is the same on every machine. A NAMESPACE file is still read in full.
- Caps, in `linear-regex.ts`: `MAX_TOTAL_WORK` (40,000,000 state visits per matcher), `MAX_SHARED_WORK` (100,000,000 matching visits per load), `MAX_PACKAGE_WORK` (30,000,000 per package), `MAX_SHARED_STATES` (500,000 NFA states per load) and `MAX_PACKAGE_STATES` (100,000 per package); a single pattern is also capped by `MAX_PATTERN_LENGTH` (16,384 characters) and `MAX_STATES` (16,384).
- Groups nested deeper than 256 (`MAX_NESTING`) are refused with the reason "groups are nested too deeply". The limit sits well inside the call stack (a quarter of the default stack still compiles 256 levels), so the verdict is the same cold or warm and on every machine.
- A verdict answered from a matcher's memo (a name asked about again) costs one visit of the work budget, so many matchers asked about the same names over and over are bounded by the budget too.
- A pattern that does not fit is dropped, exports nothing and is warned about: at most 50 patterns are named per package (`MAX_LISTED_DROPPED_PATTERNS`), followed by a summary line counting the rest.
- The first pattern refused for lack of states closes that package's allowance, so later patterns in the package are refused without being parsed.
- One hostile package cannot exhaust the load budget alone (it is limited to its own share), but several can (three, for matching work); packages processed after that degrade, with warnings. Which package degrades follows graph node order.
- Explicit `export()` names are unaffected by these bounds.

## Control flow

R provides a control-flow-only CFG visitor (`cfg/visitors/r.ts`), used under `analyze --pdg`. It gives R `BasicBlock` nodes, `CFG` edges and control-dependence (`CDG`) edges.

Modelled, in statement position inside a function body: `if` / `else if` / `else`, `for`, `while`, `repeat`, `break`, `next`, `return(...)` and bare `{ }` blocks. Every loop, including `repeat` and `while (TRUE)`, has a structural exit edge so that EXIT stays reachable for control dependence. Each `function_definition` (`function(x)` and `\(x)`, assigned or anonymous) gets its own CFG; a nested function is opaque in its parent. An `if` arm that is missing (no `else`) or empty (`{}`) produces no block: it is the header's `seq` edge to the join, and control dependence labels it as the complement of the other arm's explicit `cond-true` / `cond-false` edge (`if (c) {} else work()` makes `work()` control-dependent on `c` with label `F`).

Not modelled:

- No def/use harvest and no binding table, so reaching definitions report `no-facts` and R emits no `REACHING_DEF` edges; no taint call sites are recorded. This is a coverage gap, not a result of "no flows found". The PDG tools do not say so for R: `pdg_query` with `mode: "flows"` returns `{"results": [], "total": 0}` with no note, `explain` returns `findings: []` with its generic absence note, and the `impact` note for `mode: "pdg"` still reads "over CDG + REACHING_DEF". Read an empty answer for an R function as "not analysed". The shared tools have no per-language capability signal to report this from, so it is documented here rather than patched into them.
- Control flow nested inside an expression stays one straight-line block: `y <- if (c) a else b`, `switch()`, `&&` / `||`, `ifelse()`, and `return()` / `break` inside `tryCatch({ ... })`, `local({ ... })` or similar wrappers.
- `stop()`, `on.exit()`, `tryCatch` handlers and other non-local exits are ordinary calls: no throw edges and no finaliser routing. A `break` / `next` with no enclosing loop falls back to EXIT.
- Function join: a CFG is anchored at the `function_definition` token, while the `Function` node starts at the whole assignment. They share a start line for `f <- function`, `f = function` and `f <- \(x)`, but not for `f <-` followed by `function` on the next line; there the CFG is still emitted and its blocks lie inside the `Function` node's span, but the exact start-line join used by taint summaries does not resolve (inert for R today, since reaching definitions have no facts). Anonymous functions have a CFG but no `Function` node.

## Rename

`languages/r/rename.ts` gives the `rename` tool a deliberately narrow, fail-closed R provider (fixtures under `test/fixtures/rename-integration/r/`). R binds names dynamically, so only what the scope graph proves is renamed.

- **Succeeds:** a plain function (`name <- function(...)`) and the calls the graph resolves to it, in one file or across files; a package function that `NAMESPACE` leaves private is included. A same-named parameter that is called and has no default is claimed as a binding and its call is left alone; a call under a parameter whose default is a constant (`function(x, helper = 2) helper(x)`) reaches the function, as R skips a non-function binding, and is renamed with it.
- **Refused (`unsupported_occurrence`, planning status `unsupported`):**
  - any target that is not a plain `Function` (S4 classes, R6 classes, members);
  - a function whose old or new name is the whole value of a string literal anywhere in the indexed R sources (`UseMethod("area")`, `do.call("f", ...)`, `match.fun`, `get`, `setGeneric`, ...), because string lookup is not resolved. The literal is decoded first, so escapes (`"f\x6fo"`, `"\u{66}oo"`, octal) and raw strings (`r"(foo)"`) count. A string that only contains the name (`"foo(1)"`), a name built at run time (`paste0("fo", "o")`), and strings in files that are not indexed R sources (R Markdown, `NAMESPACE`) are not detected;
  - a new name `generic.class` where any dot-separated prefix is a function defined in the indexed R sources or a known base generic, which would register an S3 method (`to.json.foo` for a defined `to.json`, `print.foo`). The known generics are the S3 group generics (`Ops`, `Math`, `Summary`, `Complex`, `matrixOps`) with every function each group dispatches (`sum.items`, `abs.diff`), the `is.*` and `as.*` generics (`is.numeric.foo`, `as.complex.foo`), and the common generics of base, stats, graphics and utils (`print`, `format`, `summary`, `plot`, `unlist`, ...). Generics of other packages (`tidy`, `filter`, ...) are not listed;
  - an infix function or operator, as the old or the new name (`` `%+%` ``, `` `%||%` ``, `` `+` ``, `` `[[` ``): `a %+% b` is an operator token, not an identifier, so a rename would edit only the definition;
  - a replacement function and its getter (`unsupported_occurrence`): a call of the name anywhere in an assignment target (`helper(z) <- 5`, `helper(z)$a <- 1`, `names(helper(z)) <- v`, the `->` forms), because R then calls `` `helper<-` ``; an old or new name ending in `<-`; and a string-defined setter (`"helper<-" <- function(...)`) of either name;
  - a new name that is already a global (`name_collision`): a top-level variable or function of that name in any indexed file (`assist <- 3`, a `for` variable, `3 -> assist`), a `<<-` or `->>` to it anywhere, or a function of that name in another file. Same-file function collisions were already refused by the shared engine; local variables, parameters and members of that name are allowed;
  - a new name that the sources already read as a value or call (`name_collision`): `sapply(x, paste)`, `Reduce(max, x)`, `x <- letters`, a default `f = assist`, a formula term, `assist[1]`, `assist(1)`. After the rename the function is the global of that name and would capture the read. A parameter of an enclosing function of that name covers a read, and covers a call only when it has no default. Not reads: bound names, argument names (`f(assist = 1)`), members (`x$assist`, `x@assist`) and qualified names (`pkg::assist`);
  - a call of the name under a same-named parameter that may hold a function (`ambiguous_reference`): a function or computed default, or an assignment to the parameter in the body, because the call may reach the parameter or the function being renamed;
  - a function that is also assigned with `<<-` or `->>` anywhere in the indexed R sources (`ambiguous_reference`, as the top-level form already was): the global re-assignment is a second definition that a rename would leave behind;
  - a package function under `R/` that the index did not prove private, because `NAMESPACE` is not an indexed source and its entry would go stale. The rename tool reads the indexed `isExported` flag, which is false only for a function that a `NAMESPACE` file beside the package leaves out of `export()`, `exportPattern()` and `S3method()` (the third argument of `S3method(generic, class, method)` counts). A private package function is renamed; an exported one is refused; so is a function in a package with no `NAMESPACE` file, or in an `R/` folder that belongs to no package, where the index keeps the default public flag.
- **Refused by the shared engine (fail-closed, not provider code):** S3 methods and any dotted function name (`area.circle` reads as an owner-qualified member, so `stale_graph`); S4 class names (`unsupported_occurrence`, no exact source-name span).
- **Invalid names (`invalid_name`):** anything that is not a nonreserved R identifier. Backtick-quoting a new name is never offered: a name that needs it is refused rather than quoted at every use.
- **Not proven:** unqualified calls to a function defined in another file (including the package `R/` layout) fail with `ambiguous_reference`, because R's global-name fallback is not a provable binding. Renaming across files works only where the call is qualified or otherwise resolved.

## Type annotations

R has no inline type annotations, so the "Type Annotations" column of the language support table is not ticked for R. The roxygen2 `@param` extraction above is a comment-based fallback, in the same class as the JSDoc, PHPDoc and YARD fallbacks listed in type-resolution-system.md (Ruby's YARD support is likewise not ticked).

## Extending the provider

- Definition captures are in `R_QUERIES` (`tree-sitter-queries.ts`); scope, import, type-binding, heritage and reference captures are in `languages/r/query.ts`. Keep each declaration pattern and its matching `@scope.function` pattern in lockstep, as the comments in `query.ts` explain.
- The captures for `setClass`, `setRefClass`, `setGeneric`, `setMethod` and for `library` / `require` / `source` are deliberately loose. The argument that names the definition or the import is chosen afterwards in `languages/r/naming-argument.ts`, because a query-level prefix that skips leading comments and named arguments is quadratic in the argument count.
- Resolution wiring is in `languages/r/scope-resolver.ts`, registered in `SCOPE_RESOLVERS`. Package discovery and NAMESPACE parsing are in `package-config.ts` and `namespace-imports.ts`; qualified calls in `qualified-call.ts`; owner and export post-processing in `post-parse.ts` and `owner-hooks.ts`.
- Changing what the scope query captures changes what cached parsed files contain. There is no counter to raise: the parse-cache identity is derived from the bytes of the owned source roots and the grammar packages, so the change invalidates stale caches by itself. Rebuild `dist` and verify a cold parse followed by warm reuse, as CONTRIBUTING's "Parser changes and cache compatibility" section describes.
- Shared code under `gitnexus/src/core/ingestion/` must not name languages; add behaviour through the provider hooks.

## Tests

Unit tests are under `gitnexus/test/unit/` (`r-*.test.ts`, `type-env-r.test.ts` and `scope-resolution/r/`) and integration tests under `gitnexus/test/integration/resolvers/` (`r*.test.ts`), with `r-*` fixture projects in `gitnexus/test/fixtures/lang-resolution/`. They cover:

- definitions, owners and the naming-argument rules (`r-definition-anchors`, `r-owner-hooks`, `r-post-parse-owners`, `r-scope-naming-argument`, `r-s4-anchors`, `r-s4-formals`, `r-scope-args`);
- NAMESPACE parsing, exports and `exportPattern()` safety and scale (`r-namespace-parser`, `r-namespace-exports`, `r-export-pattern*`, `r-export-status-*`);
- package discovery and root-package imports (`r-package-discovery-*`, `r-import-root-package`, `r-namespace-imports`);
- qualified calls, dotted S3 names and native pipes (`r-qualified-*`, `r-dotted-s3-collision`, `r-native-pipes` fixture in `r.test.ts`);
- roxygen2 `@param` types (`type-env-r`, `r-roxygen-param`);
- control flow (`test/unit/cfg/r-visitor.test.ts`, `test/integration/cfg/r-cfg-join.test.ts`).
