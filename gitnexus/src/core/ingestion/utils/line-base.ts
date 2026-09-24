/**
 * Convert a 1-based source line number to the 0-based convention used by
 * GraphNode `startLine`/`endLine`.
 *
 * The graph layer stores line numbers 0-based (tree-sitter `startPosition.row`),
 * and this is load-bearing: the taint/PDG/CFG join and the MCP consumers all add
 * `+ 1` to recover 1-based (see `summary-harvest-driver.ts` — "Function/Method
 * node startLine is 0-based"). Most emitters get 0-based for free from
 * tree-sitter. The exceptions are the regex-based COBOL/JCL processors (their
 * parsers use `lineNum = i + 1`) and the scope-capture path (`Capture` ranges
 * are 1-based per RFC §2.1). Those must convert to 0-based when they build a
 * graph node, or the exact-content slice in `csv-generator.ts` drops the
 * symbol's declaration line (#2379) and reported line numbers are off (#2377).
 *
 * Apply this ONLY at the graph-node `startLine:`/`endLine:` assignment. The
 * parser-internal 1-based values (`.line`, `prog.startLine`) stay 1-based —
 * they feed `L${line}` node/edge IDs and line-range containment checks that
 * must not shift. The clamp guards degenerate inputs (line 0 / empty files).
 */
export const toZeroBasedLine = (oneBasedLine: number): number => Math.max(0, oneBasedLine - 1);

/**
 * Convert a 0-based GraphNode `startLine`/`endLine` into the 1-based line space
 * the CFG/PDG layer uses (`BasicBlock` ids and `functionStartLine` are built
 * from `startPosition.row + 1`).
 *
 * This is the INTERNAL inverse of {@link toZeroBasedLine}, for joining graph
 * rows against that layer. It is NOT the display converter: line numbers on
 * their way out to a human or an LLM go through `mcp/local/line-display.ts`,
 * which is documented as a response-boundary concern and passes `undefined`
 * through. Here the arithmetic is the point, so the input must already be a
 * number — a caller holding a possibly-absent value checks it first, exactly as
 * the `typeof sym.startLine === 'number'` guards in `pdg-impact.ts` do.
 */
export const toOneBasedLine = (zeroBasedLine: number): number => zeroBasedLine + 1;
