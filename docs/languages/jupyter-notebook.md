# Jupyter notebook (.ipynb) indexing

Status: implemented (Python code cells)

GitNexus indexes Jupyter notebooks by extracting Python code cells and parsing them with the existing Python language provider. Notebooks are not executed.

## Goal

After `analyze`, functions, classes, and imports defined in Python code cells are queryable like ordinary `.py` files.

## Compatibility

- `.ipynb` is detected as Python (`gitnexus-shared` `EXTENSION_MAP` and `pythonProvider.extensions`).
- Extraction lives in `gitnexus/src/core/ingestion/ipynb-extractor.ts`. Shared ingestion modules do not name nbformat AST types.
- Notebooks are **not** Python import targets. A notebook may import `.py` modules; `import some_notebook` does not resolve to an `.ipynb`.
- Files over the walker size cap (default 512KB, `GITNEXUS_MAX_FILE_SIZE`) are skipped like any other oversized file. Output-heavy notebooks may need a higher cap. Outputs are not stripped in this slice.
- Group-layer FastAPI/Flask/Django scanners that require a `.py` suffix still ignore notebooks.

## Kernel and magics

- Skip the file when `kernelspec.language` or `language_info.name` is present and is not a Python-family name (`python`, `python2`, `python3`, `ipython`). Disagreeing fields skip the file.
- If those fields are absent, code cells are treated as Python unless a cell's own language metadata says otherwise.
- A cell whose first non-empty line is a cell magic (`%%`) is skipped.
- Line magics (`%`) and shell (`!`) lines are commented in place so JSON line mapping stays affine.

## Line numbers

Graph `startLine` / `endLine` are 0-based coordinates in the on-disk `.ipynb` JSON. FTS/MCP symbol snippets reconstruct cell Python; they do not slice raw JSON.

Concatenating cells in document order is notebook semantics. An earlier cell with a syntax error may cause later definitions to be missed; that is a documented limitation, not a per-cell fallback parse.

## Tests

- `gitnexus/test/unit/ipynb-extractor.test.ts`
- `gitnexus/test/unit/ingestion-utils.test.ts` (`.ipynb` detection)
- `gitnexus/test/integration/ipynb-python-pipeline.test.ts`

No Jupyter, nbconvert, or nbformat runtime dependency.
