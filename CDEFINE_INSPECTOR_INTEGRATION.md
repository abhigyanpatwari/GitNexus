# cdefine-inspector integration contract

GitNexus provides the configuration-independent candidate graph; the compiler
remains authoritative for C preprocessor branches. `cdefine-inspector` consumes
the public `context` result and filters candidates by compiler-proven call-site
activity. This is an integration between two repositories, not a new GitNexus
indexing mode.

## Contract

For every `outgoing.calls` item returned by `context`, GitNexus preserves and
returns these optional fields when the edge originates at a source call site:

- `callSiteFilePath` — repository-relative caller file;
- `callSiteLine` — 1-based source line;
- `callSiteColumn` — 1-based source column.

Consumers must reject a candidate without `callSiteFilePath` or a positive
`callSiteLine`; declaration locations are not a safe substitute. The fields
are persisted on the existing `CodeRelation` row, so no shadow repository,
alternate graph, or configuration-specific re-index is involved.

## Reproduce against cdefine-inspector

1. Build this checkout: `cd gitnexus; npm run build`.
2. In the cdefine-inspector checkout, index its original source once with this
   build:

   ```powershell
   node <GitNexus>\gitnexus\dist\cli\index.js analyze --force .
   ```

3. Run its fixed example with the same executable:

   ```powershell
   python -m cdefine_inspector.cli active-calls --config examples/conditional-flow-16k.json --source-root . --function mapping_write --gitnexus-command node <GitNexus>\gitnexus\dist\cli\index.js
   python -m cdefine_inspector.cli compare-flow --left examples/conditional-flow-16k.json --right examples/conditional-flow-4k.json --source-root . --function mapping_write --gitnexus-command node <GitNexus>\gitnexus\dist\cli\index.js
   ```

The first command must classify `mapping_16k_write` as active and
`mapping_4k_write` as inactive. The second must report a removal of the 16K
call and an addition of the 4K call. Switching configuration must not run
`analyze` again.

## Regression checks

- `npm test -- test/unit/pdg-callee-id-capture.test.ts` checks the C free-call
  materializer retains source location.
- `npm test -- test/integration/local-backend-calltool.test.ts` checks the
  real `context` backend returns persisted location metadata.
- The cdefine-inspector repository owns compiler branch truth and the two
  configuration flow assertions; see its `docs/gitnexus-method3.md`.

When changing relation schema, CSV output, call materializers, or the context
response, update both sides of this contract and run both repositories' checks.
