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

For example, a fixture can declare `pick(Object)` and `pick(String)` and call `pick("x")`. Javac supplies the selected declaration and source range. CI detects a missing call, an extra call, a different target, or a disagreement about ambiguity or applicability. It compares direct call edges as well. GitNexus runtime interface implementations have their own graph assertions.

The runner also compares source type identities, ordinary method names and counts per file, and direct inheritance between source types. For method references such as `User::getName`, javac records the source range and selected declaration. GitNexus publishes the caller and target as an aggregate edge, so CI compares those declarations. Projects with `constructors: true` also check constructor edges, including `Type::new`, `super(...)` and `this(...)`. Put explicit constructor overloads on different declaration lines in those projects so each edge has an unambiguous target.

[The fixture manifest](java/fixtures.json) reuses projects outside the discovery directory and pins the number of compiler sites for migrated tests. A fixture can select method families or compare only type declarations when collapsed overloads give GitNexus a different method inventory. The manifest records why eleven shared projects run in Vitest. They exercise incomplete Java, invalid source layouts, or duplicate types across module boundaries. The runner automatically includes new `lang-resolution/java-*` source projects. The [generated matrix](java/conversion-matrix.mjs) independently pins all 100 argument ranges across 20 overload pairs.

Fixtures with existing disagreements record them in `known-differences.txt` alongside the source. Two shared projects point to difference files from the manifest to preserve their benchmark input trees. CI prints the exact differences and fails if one appears, changes, or disappears unexpectedly. To fail on every disagreement, including the recorded ones, run `npm run test:conformance:java -- --strict`.

To compare another analyzer against javac, run the following from this directory. Omit the method names to report all source methods. Pass `'*' '<init>'` to include constructors in the Java report.

```sh
node java/javac-report.mjs /path/to/fixture find resolve count > compiler.json
node compare.mjs compiler.json analyzer.json
```
