// Capture helpers may share a file path across concurrent repository analyses.
// A tree identifies the source snapshot and releases the context with the AST.
const contexts = new WeakMap<object, string>();

export function setTreeParseContext(tree: object, context: string | undefined): void {
  if (context === undefined) contexts.delete(tree);
  else contexts.set(tree, context);
}

export function treeParseContext(tree: object): string | undefined {
  return contexts.get(tree);
}
