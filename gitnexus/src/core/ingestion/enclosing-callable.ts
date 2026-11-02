import type { NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';

/** Node labels whose span can contain a call site. */
export const CALLABLE_LABELS: ReadonlySet<NodeLabel> = new Set<NodeLabel>([
  'Function',
  'Method',
  'Constructor',
]);

interface CallableSpan {
  id: string;
  start: number;
  end: number;
}

/** A call site: where it is, and, when the parser recorded it, which callable holds it. */
export interface CallSite {
  readonly filePath: string;
  readonly lineNumber: number;
  /** null means the AST confirmed module scope; undefined means no AST attribution. */
  readonly enclosingId?: string | null;
}

/**
 * Which callable contains a given line of a file.
 *
 * The parse phase records where the program reaches outward (a `fetch()`, an
 * ORM query) as `filePath` + `lineNumber`, while the graph knows callables by
 * their line spans. Attributing a site to the innermost callable whose span
 * contains it turns the one into the other with no new extraction and no schema
 * change. The R3-6 sink set and the FETCHES consumer attribution (#3644) both
 * use this rule, through this one index, so they cannot drift apart.
 *
 * The parser records the enclosing callable of each site it captures from the
 * AST (`enclosingId`), and that identity is used first: a line alone cannot
 * tell a helper defined on the same line as the request apart from the
 * function that makes it. The span lookup remains for sites found by text
 * scan and for an identity the graph does not hold. An explicit null records
 * module scope and must not fall back to an overlapping callable's line span.
 *
 * Span rule: innermost wins, a nested closure that performs the call is the
 * callable, not the outer function that merely spans it. Among equal spans the
 * first node seen keeps the site. Lines are 0-based on both sides, as the graph
 * stores them and as tree-sitter reports them.
 */
export class EnclosingCallableIndex {
  private readonly byFile = new Map<string, CallableSpan[]>();

  /**
   * One pass over the graph's nodes. `files` limits the index to the files
   * that have sites to attribute; without it every file is indexed.
   */
  constructor(
    private readonly graph: KnowledgeGraph,
    files?: ReadonlySet<string>,
  ) {
    for (const node of graph.iterNodes()) {
      if (!CALLABLE_LABELS.has(node.label)) continue;
      const props = node.properties as {
        filePath?: string;
        startLine?: number;
        endLine?: number;
      };
      if (typeof props.filePath !== 'string') continue;
      if (files !== undefined && !files.has(props.filePath)) continue;
      if (typeof props.startLine !== 'number' || typeof props.endLine !== 'number') continue;
      const span = { id: node.id, start: props.startLine, end: props.endLine };
      const list = this.byFile.get(props.filePath);
      if (list === undefined) this.byFile.set(props.filePath, [span]);
      else list.push(span);
    }
  }

  /** The callable that holds `site`: its recorded enclosing callable, else the innermost span. */
  of(site: CallSite): string | undefined {
    if (site.enclosingId === null) return undefined;
    if (site.enclosingId !== undefined) {
      const node = this.graph.getNode(site.enclosingId);
      if (node !== undefined && CALLABLE_LABELS.has(node.label)) return node.id;
    }
    return this.at(site.filePath, site.lineNumber);
  }

  /** Id of the innermost callable of `filePath` whose span contains `line`, if any. */
  at(filePath: string, line: number): string | undefined {
    const candidates = this.byFile.get(filePath);
    if (candidates === undefined) return undefined;
    let best: CallableSpan | undefined;
    for (const c of candidates) {
      if (line < c.start || line > c.end) continue;
      if (best === undefined || c.end - c.start < best.end - best.start) best = c;
    }
    return best?.id;
  }
}
