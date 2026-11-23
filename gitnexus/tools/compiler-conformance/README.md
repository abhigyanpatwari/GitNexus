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
- **Declaration identity.** Both producers must use the same string for a declaration. The Java pilot uses the fixture-relative declaration file and start position. A fully qualified symbol and signature also work. Optional `description` text gives a human-readable target in diagnostics.
- **Graph edges.** Include `edges` in both reports to compare the published caller-to-callee pairs. Use `[]` for an observed empty graph. Omit the field from both reports to compare sites alone.

Site records and edges are sets. Order and repeated identical observations have no effect. The reference needs at least one site. Each producer should enumerate its own results over the same fixture and selection rule so missing and unexpected calls remain visible.

The GitNexus adapter uses recorded resolution outcomes and call edges with exact source spans. A caller-to-callee pair without a span contributes to the edge comparison. The comparator reports a missing site if the reference supplies a range that the analyzer cannot establish.

## Add a producer

1. Choose what the tools can independently observe, such as compile-time overload selection or runtime dispatch on a fixed input. Use the same source snapshot and scope on each side.
2. Translate the native source ranges, declarations, and outcomes into reports. A command-line producer can write JSON using its language's standard library.
3. Run the comparison and verify that changing one selected target produces a mismatch at the correct source range.

To test your own Java analyzer, generate the reference directly with Node.js and JDK 21. Supply a self-contained source fixture and the method names to inspect. The adapter checks source method invocations inside methods and constructors.

```sh
node java/javac-report.mjs /path/to/fixture find resolve count > compiler.json
node compare.mjs compiler.json analyzer.json
```

The [Java CI job](java/check.mjs) batches three checked-in fixtures and one [generated overload matrix](java/conversion-matrix.mjs) in a single JVM. The matrix covers all 20 ordered pairs of distinct parameter types from `long`, `Integer`, `Long`, `Number`, and `Object`. Each pair receives an int literal, a long literal, an `Integer` parameter, a `Long` parameter, and `null`. The generator records all 100 source ranges before either tool runs. Of these calls, 98 resolve and two are ambiguous.

The job compares javac's declarations and ambiguities with the [GitNexus call report](gitnexus-report.mjs). Run it from `gitnexus/` with JDK 21 and a built checkout.

```sh
npm run test:conformance:java
```
