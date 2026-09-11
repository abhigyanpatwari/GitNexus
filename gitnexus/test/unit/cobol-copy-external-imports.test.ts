/**
 * Live regex-processor pin for COBOL COPY EXTERNAL (#2967).
 *
 * Census `resolveImportTarget` greening is not enough: `cobol-processor`
 * emits `cobol-copy` IMPORTS from `expandCopies` + `resolveCopy`. A vendor
 * decoy that the compiler would never search must not get that edge when a
 * well-known copybook directory is present; fail-open without one.
 */
import { describe, expect, it } from 'vitest';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processCobol } from '../../src/core/ingestion/cobol-processor.js';
import { generateId } from '../../src/lib/utils.js';

const PROG = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. PROG.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY EXTERNAL.
           COPY CUSTREC.
`;

const CUSTREC = `       01 WS-CUSTOMER-DATA.
           05 WS-CUST-CODE         PIC X(10).
`;

const EXTERNAL = `       01 WS-VENDOR-DECOY          PIC X(8).
`;

function seedFiles(
  graph: ReturnType<typeof createKnowledgeGraph>,
  files: ReadonlyArray<{ path: string; content: string }>,
): void {
  for (const f of files) {
    graph.addNode({
      id: generateId('File', f.path),
      label: 'File',
      properties: { name: f.path, filePath: f.path },
    });
  }
}

function cobolCopyTargets(graph: ReturnType<typeof createKnowledgeGraph>): string[] {
  return graph.relationships
    .filter((r) => r.type === 'IMPORTS' && r.reason === 'cobol-copy')
    .map((r) => r.targetId)
    .sort();
}

describe('COBOL processor COPY EXTERNAL does not fabricate vendor IMPORTS (#2967)', () => {
  it('emits no cobol-copy IMPORTS onto vendor/EXTERNAL.cpy when copybooks/ is present', () => {
    const files = [
      { path: 'copybooks/CUSTREC.cpy', content: CUSTREC },
      { path: 'vendor/EXTERNAL.cpy', content: EXTERNAL },
      { path: 'src/PROG.cbl', content: PROG },
    ];
    const graph = createKnowledgeGraph();
    seedFiles(graph, files);
    processCobol(graph, files, new Set(files.map((f) => f.path)));

    const targets = cobolCopyTargets(graph);
    expect(targets).toContain(generateId('File', 'copybooks/CUSTREC.cpy'));
    expect(targets).not.toContain(generateId('File', 'vendor/EXTERNAL.cpy'));
  });

  it('fail-open: without a copybook dir, COPY EXTERNAL still emits onto vendor/EXTERNAL.cpy', () => {
    const files = [
      { path: 'vendor/EXTERNAL.cpy', content: EXTERNAL },
      { path: 'src/PROG.cbl', content: PROG },
    ];
    const graph = createKnowledgeGraph();
    seedFiles(graph, files);
    processCobol(graph, files, new Set(files.map((f) => f.path)));

    const targets = cobolCopyTargets(graph);
    expect(targets).toContain(generateId('File', 'vendor/EXTERNAL.cpy'));
  });

  it('P1-A: uppercase .CPY extension does not break stem extraction', () => {
    const files = [
      { path: 'copybooks/CUSTREC.CPY', content: CUSTREC },
      { path: 'src/PROG.cbl', content: PROG },
    ];
    const graph = createKnowledgeGraph();
    seedFiles(graph, files);
    processCobol(graph, files, new Set(files.map((f) => f.path)));

    const targets = cobolCopyTargets(graph);
    expect(targets).toContain(generateId('File', 'copybooks/CUSTREC.CPY'));
  });

  it('P1-B: polyglot allPathSet with copy/cpy segments does not latch preferred-class', () => {
    const files = [
      { path: 'copybooks/CUSTREC.cpy', content: CUSTREC },
      { path: 'vendor/EXTERNAL.cpy', content: EXTERNAL },
      { path: 'src/PROG.cbl', content: PROG },
    ];
    const polyglotPaths = new Set([
      'docs/copy/README.md',
      'src/copy/clipboard.ts',
      ...files.map((f) => f.path),
    ]);
    const graph = createKnowledgeGraph();
    seedFiles(graph, files);
    processCobol(graph, files, polyglotPaths);

    const targets = cobolCopyTargets(graph);
    expect(targets).toContain(generateId('File', 'copybooks/CUSTREC.cpy'));
    expect(targets).not.toContain(generateId('File', 'vendor/EXTERNAL.cpy'));
  });
});
