# Compare call resolution across tools

Use `compare.mjs` to check whether two tools agree on the declarations selected by calls in the same source fixture. Copy this single file into a checkout with Node.js to use the standalone command. One producer might use a compiler API and the other a language server, an indexer, or a static analyzer.

Generate one JSON report per tool for the same fixture and run the following command. It exits with status 0 on a match and prints missing and unexpected results on a mismatch.

```sh
node compare.mjs compiler.json analyzer.json
```

JavaScript integrations can import `compareReports(expected, actual)` from the same file. It throws on a mismatch or malformed input.

## Report format

For example, save this fixture as `main.py`.

```python
class Greeter:
    def greet(self):
        return 42

    def entry(self):
        return self.greet()
```

An execution trace of `Greeter().entry()` can record the following call to `greet`. An analyzer can produce the same record by inspecting the source.

```json
{
  "producer": "Example analyzer",
  "sites": [
    {
      "file": "main.py",
      "start": "6:15",
      "end": "6:27",
      "status": "resolved",
      "target": "main.py#2:4"
    }
  ],
  "edges": [{ "from": "main.py#5:4", "to": "main.py#2:4" }]
}
```

- **Source range.** Report the entire call expression using fixture-relative paths with forward slashes. Lines start at 1. Columns count UTF-16 code units from 0. The end is exclusive. Convert byte offsets or tab-expanded columns in the producer.
- **Outcome.** A resolved record requires a target. Use a record such as `{"file":"main.py","start":"5:11","end":"5:18","status":"ambiguous"}` for an explicit ambiguity. Producers can agree on additional status strings. For multiple observed targets, emit one record per target at the same range.
- **Declaration identity.** Both producers must use the same string for a declaration. The Java adapter uses the fixture-relative declaration file and start position. A fully qualified symbol and signature also work. Optional `description` text gives a human-readable target in diagnostics.
- **Graph edges.** Include `edges` in both reports to compare the published caller-to-callee pairs. Use `[]` for an observed empty graph. Omit the field from both reports to compare sites alone.

Site records and edges are sets. Order and repeated identical observations have no effect. The reference needs at least one site or edge. Each producer should enumerate its own results over the same fixture and selection rule so missing and unexpected calls remain visible.

The GitNexus adapter uses recorded resolution outcomes and call edges with exact source spans. A caller-to-callee pair without a span contributes to the edge comparison. The comparator reports a missing site if the reference supplies a range that the analyzer cannot establish.

## Add a producer

1. Choose what the tools can independently observe, such as compile-time overload selection or runtime dispatch on a fixed input. Use the same source snapshot and scope on each side.
2. Translate the native source ranges, declarations, and outcomes into reports. A command-line producer can write JSON using its language's standard library.
3. Run the comparison and verify that changing one selected target produces a mismatch at the correct source range.

## Java fixtures

To add a call-resolution case, put a self-contained Java project under `gitnexus/test/fixtures/compiler-conformance/java-<case>/`. Write the Java source exactly as it should be analyzed. The runner discovers the directory and sends the same source to JDK 21 and the production GitNexus ingestion pipeline. Each project gets an isolated javac task in one JVM. A single project can exercise several distinct calls on the same line.

Set `JAVA_HOME` to the absolute path of your JDK 21 installation and run the command from a built `gitnexus/` checkout.

```sh
npm run test:conformance:java
```

For example, a fixture can declare `pick(Object)` and `pick(String)` and call `pick("x")`. Javac supplies the selected declaration and source range. CI detects a missing call, an extra call, a different target, or a disagreement about ambiguity or applicability. It compares direct call edges as well. Set `implementations` to the expected number of class-to-interface method pairs to compare every published `METHOD_IMPLEMENTS` edge with javac's `Elements.overrides` result.

The runner also compares source type identities, ordinary method names and counts per file, and direct inheritance between source types. For method references such as `User::getName`, javac records the source range and selected declaration. GitNexus publishes the caller and target as an aggregate edge, so CI compares those declarations. Projects with `constructors: true` also check constructor edges, including `Type::new`, `super(...)` and `this(...)`. Put explicit constructor overloads on different declaration lines in those projects so each edge has an unambiguous target.

[The fixture manifest](java/fixtures.json) reuses projects outside the discovery directory and pins the number of compiler sites for migrated tests. A fixture can select method families or compare only type declarations when collapsed overloads give GitNexus a different method inventory. The manifest explains which projects require compiler recovery or product checks because they contain incomplete Java, invalid source layouts, or duplicate types across module boundaries. The runner automatically includes new `lang-resolution/java-*` source projects. The [generated matrix](java/conversion-matrix.mjs) independently pins all 100 argument ranges across 20 overload pairs.

All Java source fixtures run through this command, including inline snippets and virtual projects. Add a Java resolution case as a fixture project so javac supplies its expected target. The [resolution checks](java/check-resolution.mjs) also handle partially invalid projects, cold and warm parses, and import storage. The [provider checks](java/test/provider) cover parser captures and other GitNexus-specific results. The [Spring checks](java/spring-check.mjs) and [product checks](java/product) cover framework behavior, rename, graph persistence, and mixed-language analysis. The conformance command scans Vitest source for Java fixture paths and virtual source maps. It follows literals, aliases and direct local assignments. Vitest also detects Java parsing in process and Java files submitted to the shared worker helper, including those with dynamically computed paths.

For a project with unresolved dependencies, the manifest can specify the exact javac diagnostic codes and counts in `diagnostics`. The comparison still checks every source declaration and source inheritance edge that javac can attribute. An added or missing diagnostic fails the run.

The Java compiler comparison is strict by default. A difference in a source range, target, rejection, or published edge fails the job and prints the fixture and the two observations. When a fixture selects method families, javac reports overload rejections for those families. Other compilation errors, such as an ambiguous type declaration, still need an exact diagnostic entry.

Each javac task uses the fixture sources, the JDK 21 platform, and an empty application classpath. GitNexus resolves wildcard imports against indexed source packages and known platform types. Adding a dependency JAR to javac's classpath can introduce another type of the same name and change its answer.

The comparison also covers calls in the selected method families that resolve to library code. For example, javac and GitNexus report `java.lang.Iterable#forEach(java.util.function.Consumer)` at the call site when a JDK list supplies the receiver. Source implementations of `forEach` contribute their declaration and a call graph edge.

Windows and macOS run `node tools/compiler-conformance/java/check-products.mjs --platform` from the GitNexus package. This checks rename, worker-cache persistence, the parser ABI, and projects with non-ASCII paths on each platform. The native runner fails if a selected file has no passing tests or contains a skipped case, a todo, or an empty suite.

To compare another analyzer against javac, run the following from this directory. With no method names, the standalone command includes source and library methods. Pass `'*' '<init>'` to include constructors. In the fixture manifest, omitting `families` compares method names declared by the fixture, including calls of those names on library types. Set `"families": ["*"]` to include every library method.

```sh
node java/javac-report.mjs /path/to/fixture find resolve count > compiler.json
node compare.mjs compiler.json analyzer.json
```

The standalone comparator reads `sites` and `edges`. The Java report also exposes `constructors`, `heritage`, and `implementations` for consumers that compare those relationships. The Java conformance job compares them with the published graph.

Each `methodAccess` entry identifies a source method by file, line, and column. Its `isPublic` field includes methods that Java makes implicitly public. Projects that compare method declarations check this flag against the graph's `isExported` property.

## TypeScript fixtures

After `npm run build`, run `node tools/compiler-conformance/typescript/check.mjs` from `gitnexus/`. It runs the native controls, then compares every registered project. Pass a project directory to run the controls and compare just that project. CI invokes the same command through `npm run test:conformance:typescript`. Add new source projects under `test/fixtures/compiler-conformance/typescript-<case>/`. The runner also compares existing projects listed in `typescript/projects.json`.

The oracle uses the TypeScript compiler installed by the package lock. It reads the fixture's tsconfig when present. Projects without a config use strict checking and bundler module resolution. The compiler and GitNexus read the same source. For npm workspaces, the compiler gets a temporary copy with the local packages linked.

For generic classes, the runner compares each type parameter's name, constraint, and default in declaration order. It joins the parameters from GitNexus scope resolution to the published class by source location.

Each call comparison checks the source range and the selected declaration, including overloads. The runner separately compares published calls by caller, stored range and target. A class method's published identity encodes its owner, staticness and complete property name as a JSON tuple. Runtime interface-dispatch edges have their own product assertions in `test/integration/resolvers/typescript.test.ts`. The runner also compares graph edges for imports, named types, inheritance, overrides, and interface implementations. The declaration inventory compares named functions, classes, interfaces, and their methods in the projects listed for that check. Negative controls deliberately swap same-named targets and verify that the comparison fails.

Fixtures that exercise compiler recovery declare their expected diagnostics in `typescript/diagnostics.json`. For example, TypeScript 7 reports two configuration errors in the legacy baseUrl fixture. Unlisted or missing diagnostics fail the job. For a type-only import used as a constructor, the runner checks that GitNexus leaves the call unbound. Annotated receivers still have compiler-selected methods.

Three projects listed under `diagnosticsOnly` also pin compiler diagnostics. Their runtime graphs have separate Vitest suites in `test/integration/resolvers/`. `typescript-callable-alternatives` follows possible runtime callees, `typescript-hof-callbacks` attributes callbacks passed to higher-order functions, and `typescript-hoc-wrapped` publishes wrapper-bound functions. The default command labels these projects separately. Passing one of their directories explicitly runs the full graph comparison and reports the differences.

For a call through an identifier with an inline function-type annotation, the compiler report records the parameter declaration and its annotated signature. Calls on an unchecked receiver can have no compiler-selected declaration. The comparison records those locations separately.

To use the TypeScript producer with another analyzer, run the following from `gitnexus/` using a project that passes type checking. Both reports use the format described above.

```sh
node tools/compiler-conformance/typescript/compiler-report.mjs path/to/project CALLS > compiler.json
node tools/compiler-conformance/compare.mjs compiler.json analyzer.json
```
