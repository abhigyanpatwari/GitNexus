/**
 * #2699 / #2714 — the nested-callable id rule has ONE definition.
 *
 * Three phases in `parse-worker.ts` build the id of a callable nested inside
 * another callable, independently: the definition phase
 * (`callableOwnQualifiedName`), the caller-attribution phase
 * (`findEnclosingFunctionId`), and the worker-path node-id derivation in
 * `processFileGroup`. They must agree byte-for-byte, and when they do not the
 * failure is SILENT — the caller id names a node that does not exist, so the
 * edge is dropped rather than reported. "Zero dangling edges" is what that
 * looks like from the outside, which is why it went unnoticed.
 *
 * Caller attribution really did omit the position suffix until #2714. The fix
 * routed all three through `nestedCallableQualifiedName`; this file pins both
 * halves of that — the rule's contract, and the fact that no call site has
 * re-inlined it.
 *
 * The rule reads only `startPosition` off the node, so a positional stub is a
 * complete input here; parsing real source would add a tree-sitter dependency
 * without testing anything more of this function.
 *
 * The rules live in `callable-id.ts` rather than `parse-worker.ts` precisely so
 * this file can exist: parse-worker posts a `ready` message to `parentPort` at
 * import, so value-importing it from a unit test throws before any test runs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  boundCallableStartRow,
  nestedCallableQualifiedName,
} from '../../src/core/ingestion/workers/callable-id.js';
import type { NodeLabel, SymbolDefinition } from 'gitnexus-shared';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

const nodeAt = (row: number, column: number): SyntaxNode =>
  ({ startPosition: { row, column } }) as unknown as SyntaxNode;

function stubNode(opts: {
  type: string;
  id: number;
  row?: number;
  column?: number;
  endRow?: number;
  endColumn?: number;
}): SyntaxNode {
  return {
    type: opts.type,
    id: opts.id,
    startPosition: { row: opts.row ?? 0, column: opts.column ?? 0 },
    endPosition: {
      row: opts.endRow ?? opts.row ?? 0,
      column: opts.endColumn ?? opts.column ?? 0,
    },
  } as unknown as SyntaxNode;
}

const semanticDef = (
  filePath: string,
  type: NodeLabel,
  name: string,
  line: number,
  column: number,
): SymbolDefinition => ({
  nodeId: `def:${filePath}#${line}:${column}:${type}:${name}`,
  filePath,
  type,
  qualifiedName: name,
});

describe('boundCallableStartRow - #2735 semantic position join', () => {
  it('keeps the wrapper row when no semantic definition is available', () => {
    const wrapper = stubNode({
      type: 'binding_wrapper',
      id: 1,
      row: 2,
      column: 0,
      endRow: 4,
      endColumn: 1,
    });

    expect(boundCallableStartRow(wrapper, 'handler', 'Function', undefined)).toBe(2);
  });

  it('uses the matching semantic callable position inside the wrapper', () => {
    const wrapper = stubNode({
      type: 'binding_wrapper',
      id: 1,
      row: 1,
      column: 0,
      endRow: 5,
      endColumn: 10,
    });
    const name = stubNode({ type: 'binding_name', id: 2, row: 1, column: 4 });
    const defs = [semanticDef('src/file.ext', 'Function', 'handler', 4, 8)];

    expect(boundCallableStartRow(wrapper, 'handler', 'Function', defs, name)).toBe(3);
  });

  it('selects by canonical name and label rather than grammar shape', () => {
    const wrapper = stubNode({
      type: 'binding_wrapper',
      id: 1,
      row: 1,
      column: 0,
      endRow: 8,
      endColumn: 10,
    });
    const defs = [
      semanticDef('src/file.ext', 'Function', 'sibling', 3, 4),
      semanticDef('src/file.ext', 'Method', 'handler', 4, 4),
      semanticDef('src/file.ext', 'Function', 'handler', 6, 4),
    ];

    expect(boundCallableStartRow(wrapper, 'handler', 'Function', defs)).toBe(5);
  });

  it('ignores a same-named semantic definition outside the wrapper', () => {
    const wrapper = stubNode({
      type: 'binding_wrapper',
      id: 1,
      row: 4,
      column: 0,
      endRow: 6,
      endColumn: 10,
    });
    const defs = [semanticDef('src/file.ext', 'Function', 'handler', 2, 0)];

    expect(boundCallableStartRow(wrapper, 'handler', 'Function', defs)).toBe(4);
  });
});
describe('nestedCallableQualifiedName — the shared nested-callable id rule', () => {
  it('qualifies by the enclosing callable AND the declaration position', () => {
    expect(nestedCallableQualifiedName('run', nodeAt(3, 2), 'save')).toBe('run.save@3:2');
  });

  it('takes the position from the node, never from the name', () => {
    // Guards against a "fix" that formats the suffix from anything but the
    // declaration site — the position is what makes the id unique.
    expect(nestedCallableQualifiedName('outer', nodeAt(12, 9), 'fn')).toBe('outer.fn@12:9');
  });

  it('separates same-named siblings in different blocks', () => {
    // The case names alone cannot express (#2699): two `pick` bindings in the
    // if/else arms of one function are genuinely different bindings, and both
    // are `outer.pick` by name.
    const first = nestedCallableQualifiedName('outer', nodeAt(2, 4), 'pick');
    const second = nestedCallableQualifiedName('outer', nodeAt(5, 4), 'pick');

    expect(first).not.toBe(second);
  });

  it('carries a multi-level chain verbatim in the prefix', () => {
    expect(nestedCallableQualifiedName('A.outer.mid', nodeAt(7, 0), 'inner')).toBe(
      'A.outer.mid.inner@7:0',
    );
  });
});

describe('no call site re-inlines the rule', () => {
  it('parse-worker.ts contains no inlined `<prefix>.${localIdentity(...)}` template', () => {
    // The structural half. The unit assertions above would still pass if a
    // fourth phase appeared and spelled the rule out by hand — which is
    // exactly how the divergence #2714 fixed came to exist.
    //
    // Scope, stated honestly: this matches ONE template spelling — the
    // `${prefix}.${localIdentity(...)}` form the divergence actually took. A
    // hand-rolled id built by string concatenation, or with the interpolation
    // spelled differently, still slips past. It is a tripwire for the known
    // shape, not a proof that no site reconstructs the id.
    const source = readFileSync(
      fileURLToPath(new URL('../../src/core/ingestion/workers/parse-worker.ts', import.meta.url)),
      'utf8',
    );
    const inlined = source.match(/\}\.\$\{localIdentity\(/g) ?? [];

    expect(inlined).toEqual([]);
  });
});
