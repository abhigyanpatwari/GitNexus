/**
 * Fixture for rename-lsp-golden integration test.
 * The function `mapGoldenNodeId` is the rename target.
 * Its position on this line is deterministic — do NOT reorder lines above.
 */
export function mapGoldenNodeId(uri: string, line: number): string {
  return `node:${uri}:${line}`;
}

export function helperFn(x: number): number {
  return x * 2;
}
