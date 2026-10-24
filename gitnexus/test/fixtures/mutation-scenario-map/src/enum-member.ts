// Scenario-map controls fixture (Phase 1 U17), pair `enum-member`. The label constants feed both
// the argument a test passes and the callable-label Set, so a mutant of a constant changes both
// sides at once and no mutant tells the two members apart.

/** Graph node labels, as a const object (an enum-like table of string members). */
export const NodeLabel: Readonly<{ Function: 'Function'; Method: 'Method'; Class: 'Class' }> = {
  Function: 'Function',
  Method: 'Method',
  Class: 'Class',
};

export type NodeLabelName = (typeof NodeLabel)[keyof typeof NodeLabel];

const CALLABLE_LABELS: ReadonlySet<string> = new Set([NodeLabel.Function, NodeLabel.Method]);

/** The node labels a graph builder has collected. */
export class MiniGraph {
  readonly #labels: NodeLabelName[] = [];

  addNode(label: NodeLabelName): void {
    this.#labels.push(label);
  }

  /** True when any collected node is a callable (a function or a method). */
  hasCallableNode(): boolean {
    return this.#labels.some((label) => CALLABLE_LABELS.has(label));
  }
}
