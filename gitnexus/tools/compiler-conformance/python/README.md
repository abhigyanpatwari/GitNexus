# Python compiler conformance

Compares GitNexus Python call resolution against CPython runtime call tracing (`sys.setprofile` + PEP 657 `co_positions()`) and AST source spans using `../compare.mjs`.

## Requirements

- Built `gitnexus/` checkout (`npm run build`)
- Python 3.11+ (`python3`, stdlib only; override binary with `PYTHON_BIN`)

## Run

From `gitnexus/`:

```sh
npm run test:conformance:python
node --test tools/compiler-conformance/python/python-report.test.mjs
```

## Notes

- `fixtures.json` pins runnable fixtures under `test/fixtures/lang-resolution/` with explicit `entry` snippets and `names` filters.
- Static-only fixtures that intentionally raise runtime errors (e.g. stub classes) or free-call fixtures whose edges currently collapse without `resolutionOutcomes` sites (`collapsedIdentity`) are excluded from this initial manifest until free-call site spans are emitted.
