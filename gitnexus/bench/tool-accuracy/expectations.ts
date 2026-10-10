/**
 * The single place that pins fixture line numbers. run.ts buckets observations by these anchors
 * and the fixed answers below are built from them, so a fixture edit is one reviewed change here.
 * `anchorDrift` fails loudly (run.ts and a unit test) when a fixture line no longer holds the
 * pinned text, instead of letting observations drift into the wrong bucket.
 */
export const FIXTURE_ANCHORS = {
  writerCloseDeclaration: { file: 'rename/writer.ts', line: 2, text: 'close(): void {}' },
  writerCloseCall: { file: 'rename/writer.ts', line: 8, text: 'writer.close();' },
  callerCloseCall: { file: 'rename/caller.ts', line: 3, text: 'writer.close();' },
  writerComment: {
    file: 'rename/writer.ts',
    line: 10,
    text: '// close is a comment, not a reference.',
  },
  writerString: { file: 'rename/writer.ts', line: 11, text: "export const title = 'close';" },
  runGit: {
    file: 'src/security.ts',
    line: 4,
    text: 'export function runGit(args: string): string {',
  },
  blameSummary: {
    file: 'src/security.ts',
    line: 7,
    text: 'export function blameSummary(ref: string): string {',
  },
  handleUnsafe: {
    file: 'src/security.ts',
    line: 14,
    text: 'export function handleUnsafe(req: any): string {',
  },
  directUnsafe: {
    file: 'src/security.ts',
    line: 22,
    text: 'export function directUnsafe(req: any): void {',
  },
  directUnsafeSource: {
    file: 'src/security.ts',
    line: 23,
    text: 'const command = req.query.command as string;',
  },
  directUnsafeSink: { file: 'src/security.ts', line: 24, text: 'execSync(command);' },
} as const satisfies Record<string, { file: string; line: number; text: string }>;

const A = FIXTURE_ANCHORS;

/** Anchors whose fixture line (1-based) no longer holds the pinned text; empty when in sync. */
export function anchorDrift(readLines: (file: string) => string[]): string[] {
  return Object.entries(FIXTURE_ANCHORS).flatMap(([name, anchor]) => {
    const actual = readLines(anchor.file)[anchor.line - 1]?.trim();
    return actual === anchor.text
      ? []
      : [
          `${name}: ${anchor.file}:${anchor.line} is ${JSON.stringify(actual)}, expected ${JSON.stringify(anchor.text)}`,
        ];
  });
}

/** Fixed answers reviewed from the fixture source, never learned from tool output. */
export const EXPECTATIONS = [
  {
    id: 'rename.references',
    issue: 3486,
    title: 'All resolved Writer.close references',
    expected: [
      `rename/caller.ts:${A.callerCloseCall.line}:writer.closeWriter();`,
      `rename/writer.ts:${A.writerCloseDeclaration.line}:closeWriter(): void {}`,
      `rename/writer.ts:${A.writerCloseCall.line}:writer.closeWriter();`,
    ],
  },
  {
    id: 'rename.comments-strings',
    issue: 3486,
    title: 'Comments and strings receive no edits',
    expected: [],
  },
  {
    id: 'rename.homonyms',
    issue: 3486,
    title: 'Unrelated methods and functions receive no edits',
    expected: [],
  },
  {
    id: 'routes.production-handler',
    issue: 3487,
    title: 'Test stub cannot replace the server handler',
    expected: ['GET /api/info src/server/api.ts'],
  },
  {
    id: 'routes.all-method',
    issue: 3487,
    title: 'Express app.all is method agnostic',
    expected: ['* /api/mcp src/server/api.ts'],
  },
  { id: 'routes.map-lookup', issue: 3487, title: 'Map.get is not an HTTP route', expected: [] },
  {
    id: 'routes.helper-registration',
    issue: 3487,
    title: 'Literal route forwarded through a local helper',
    expected: ['GET /api/progress src/server/api.ts'],
  },
  {
    id: 'api.template-wrapper',
    issue: 3488,
    title: 'Base URL template passed to a fetch wrapper is a consumer',
    expected: ['src/web/client.ts'],
  },
  {
    id: 'api.literal-control',
    issue: 3488,
    title: 'Direct literal fetch consumer control',
    expected: ['src/web/control.ts'],
  },
  {
    id: 'explain.named-flow',
    issue: 3489,
    title: 'Named request handler reaches the command sink',
    expected: ['handleUnsafe -> runGit command-injection'],
  },
  {
    id: 'explain.inline-flow',
    issue: 3489,
    title: 'Inline request callback reaches the command sink',
    expected: ['src/server/inline.ts -> runGit command-injection'],
  },
  {
    id: 'explain.guard',
    issue: 3490,
    title: 'Strict SHA allow-list prevents command injection',
    expected: [],
  },
  {
    id: 'explain.constant-control',
    issue: 3490,
    title: 'Constant command has no request taint',
    expected: [],
  },
  {
    id: 'explain.cross-lines',
    issue: 3491,
    title: 'Cross-function source, sink and every hop are 1-based',
    expected: [
      `source handleUnsafe@${A.handleUnsafe.line}`,
      `sink runGit@${A.runGit.line}`,
      `hop 0 handleUnsafe@${A.handleUnsafe.line}`,
      `hop 1 blameSummary@${A.blameSummary.line}`,
      `hop 2 runGit@${A.runGit.line}`,
    ],
  },
  {
    id: 'explain.intra-lines',
    issue: 3491,
    title: 'Statement-level source, sink and hops are 1-based',
    expected: [
      `function@${A.directUnsafe.line}`,
      `source command@${A.directUnsafeSource.line}`,
      `sink@${A.directUnsafeSink.line}`,
      `hop 0 command@${A.directUnsafeSource.line}`,
      `hop 1 command@${A.directUnsafeSink.line}`,
    ],
  },
  {
    id: 'python.module-direct',
    issue: 3497,
    title: 'Direct imported-module receiver control',
    expected: ['pkg/facade.py:target'],
  },
  {
    id: 'python.module-chain',
    issue: 3497,
    title: 'Module-return helper chained receiver',
    expected: ['pkg/facade.py:target'],
  },
  {
    id: 'python.module-local',
    issue: 3497,
    title: 'Module-return helper assigned to a local',
    expected: ['pkg/facade.py:target'],
  },
  {
    id: 'python.factory-direct',
    issue: 3498,
    title: 'Annotated factory direct assignment control',
    expected: ['mod.py:C.m'],
  },
  {
    id: 'python.factory-conditional',
    issue: 3498,
    title: 'Annotated factory through conditional expression',
    expected: ['mod.py:C.m'],
  },
  {
    id: 'python.factory-qualified',
    issue: 3498,
    title: 'Annotated factory through module alias',
    expected: ['mod.py:C.m'],
  },
  {
    id: 'python.factory-boolean',
    issue: 3498,
    title: 'Annotated factory through boolean expression',
    expected: ['mod.py:C.m'],
  },
  {
    id: 'python.nested-local-import',
    issue: 3499,
    title: 'Function-local import beats unrelated nested declaration',
    expected: ['pkg/facade.py:target'],
  },
  {
    id: 'python.nested-module-import',
    issue: 3499,
    title: 'Module import beats unrelated nested declaration',
    expected: ['pkg/facade.py:target'],
  },
  {
    id: 'python.nested-unbound',
    issue: 3499,
    title: 'Sibling cannot call an out-of-scope nested declaration',
    expected: [],
  },
  {
    id: 'python.local-import-control',
    issue: 3499,
    title: 'Function-local import without homonym control',
    expected: ['pkg/facade.py:target'],
  },
  {
    id: 'python.local-import-leak',
    issue: 3499,
    title: 'Function-local import cannot bind a sibling function',
    expected: [],
  },
  {
    id: 'summary.exact-control',
    issue: 3497,
    title: 'Complete empty drop summary permits exact',
    expected: ['exact'],
  },
  {
    id: 'summary.retained-lower-bound',
    issue: 3497,
    title: 'Retained dropped name requires lower-bound',
    expected: ['lower-bound'],
  },
  {
    id: 'summary.cap',
    issue: 3497,
    title: '501 names over 1001 sites retain 500 and explicitly omit the last name',
    expected: ['kept=500 total=1001 omitted=1 target=false'],
  },
  {
    id: 'summary.omitted-lower-bound',
    issue: 3497,
    title: 'Absent name in a truncated summary cannot claim exact',
    expected: ['lower-bound'],
  },
] satisfies Array<{ id: string; issue: number; title: string; expected: string[] }>;
