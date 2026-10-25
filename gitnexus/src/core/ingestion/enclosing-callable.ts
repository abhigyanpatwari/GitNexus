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
 * Innermost wins: a nested closure that performs the call is the callable, not
 * the outer function that merely spans it. Among equal spans the first node
 * seen keeps the site. Lines are 0-based on both sides, as the graph stores
 * them and as tree-sitter reports them.
 */
export class EnclosingCallableIndex {
  private readonly byFile = new Map<string, CallableSpan[]>();

  /**
   * One pass over the graph's nodes. `files` limits the index to the files
   * that have sites to attribute; without it every file is indexed.
   */
  constructor(graph: KnowledgeGraph, files?: ReadonlySet<string>) {
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
