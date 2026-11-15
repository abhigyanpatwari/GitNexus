import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { planGraphRename } from '../../src/mcp/local/rename/graph-rename.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(
  files: Record<string, string>,
  name: string,
  kind: string,
  filePath = Object.keys(files)[0]!,
  line?: number,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-cobol-'));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(([file, content]) => fs.writeFile(path.join(root, file), content)),
  );
  const result = await runPipelineFromRepo(root, () => undefined, {
    workerPoolSize: 1,
    skipGraphPhases: true,
  });
  const nodes = [...result.graph.iterNodes()];
  const target = nodes.find(
    (node) =>
      node.label === kind &&
      node.properties.name === name &&
      node.properties.filePath === filePath &&
      (line === undefined || node.properties.startLine === line - 1),
  );
  expect(target).toBeDefined();
  const symbol = {
    uid: target!.id,
    name: target!.properties.name,
    filePath,
    startLine: target!.properties.startLine! + 1,
    endLine: target!.properties.endLine! + 1,
    kind: target!.label,
  };
  return { root, nodes, symbol };
}

describe('COBOL semantic rename from the production parsing pipeline', () => {
  it('previews and applies a free-format paragraph rename through PERFORM and GO TO', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    PERFORM work-para\n    GO TO WORK-PARA.\nWORK-PARA.\n    DISPLAY "WORK-PARA".\n    STOP RUN.\n';
    const { root, nodes, symbol } = await fixture({ 'demo.cbl': content }, 'WORK-PARA', 'Function');
    const preview = await planGraphRename(root, symbol, { new_name: 'FINISH-PARA' }, nodes);
    expect(preview.edits).toHaveLength(3);
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'FINISH-PARA', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content
        .replace('work-para', 'FINISH-PARA')
        .replace('GO TO WORK-PARA', 'GO TO FINISH-PARA')
        .replace('\nWORK-PARA.', '\nFINISH-PARA.'),
    );
  }, 60000);

  it('previews and applies FILE STATUS together with its declaration and procedure use', async () => {
    const content = [
      '>>SOURCE FORMAT FREE',
      'IDENTIFICATION DIVISION.',
      'PROGRAM-ID. DEMO.',
      'ENVIRONMENT DIVISION.',
      'INPUT-OUTPUT SECTION.',
      'FILE-CONTROL.',
      'SELECT DATAFILE ASSIGN TO "data.txt" FILE STATUS IS WS-STATUS.',
      'DATA DIVISION.',
      'WORKING-STORAGE SECTION.',
      '01 WS-STATUS PIC XX.',
      'PROCEDURE DIVISION.',
      '    DISPLAY WS-STATUS.',
      '',
    ].join('\n');
    const { root, nodes, symbol } = await fixture({ 'demo.cbl': content }, 'WS-STATUS', 'Property');
    const expected = content.replaceAll('WS-STATUS', 'IO-STATUS');
    const preview = await planGraphRename(root, symbol, { new_name: 'IO-STATUS' }, nodes);
    expect(preview.edits).toHaveLength(3);
    expect(
      preview.edits.map((edit) => content.slice(edit.start, edit.start + edit.length)),
    ).toEqual(['WS-STATUS', 'WS-STATUS', 'WS-STATUS']);
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(content);
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'IO-STATUS', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(expected);
  }, 60000);

  it.each(['FILE STATUS', 'SORT STATUS IS', 'RELATIVE KEY IS', 'RECORD KEY IS'])(
    'resolves qualified %s operands without editing another group',
    async (clause) => {
      const content = [
        '>>SOURCE FORMAT FREE',
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. DEMO.',
        'ENVIRONMENT DIVISION.',
        'INPUT-OUTPUT SECTION.',
        'FILE-CONTROL.',
        `SELECT DATAFILE ASSIGN TO "data.txt" ${clause} ITEM-CODE OF FIRST-GROUP.`,
        'DATA DIVISION.',
        'WORKING-STORAGE SECTION.',
        '01 FIRST-GROUP.',
        '  05 ITEM-CODE PIC 99.',
        '01 SECOND-GROUP.',
        '  05 ITEM-CODE PIC 99.',
        'PROCEDURE DIVISION.',
        '    DISPLAY ITEM-CODE OF FIRST-GROUP ITEM-CODE OF SECOND-GROUP.',
        '',
      ].join('\n');
      const { root, nodes, symbol } = await fixture(
        { 'demo.cbl': content },
        'ITEM-CODE',
        'Property',
        'demo.cbl',
        11,
      );
      const result = await renameSymbol(
        root,
        symbol,
        { new_name: 'PRODUCT-CODE', dry_run: false },
        nodes,
      );
      expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
      expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
        content
          .replaceAll('ITEM-CODE OF FIRST-GROUP', 'PRODUCT-CODE OF FIRST-GROUP')
          .replace('05 ITEM-CODE', '05 PRODUCT-CODE'),
      );
    },
    60000,
  );

  it('retains qualified OCCURS DEPENDING ON data-clause references', async () => {
    const content = [
      '>>SOURCE FORMAT FREE',
      'IDENTIFICATION DIVISION.',
      'PROGRAM-ID. DEMO.',
      'DATA DIVISION.',
      'WORKING-STORAGE SECTION.',
      '01 COUNTS.',
      '  05 ITEM-COUNT PIC 9.',
      '01 ITEMS.',
      '  05 ITEM-VALUE PIC X OCCURS 1 TO 9 TIMES DEPENDING ON ITEM-COUNT OF COUNTS.',
      'PROCEDURE DIVISION.',
      '    DISPLAY ITEM-COUNT OF COUNTS.',
      '',
    ].join('\n');
    const { root, nodes, symbol } = await fixture(
      { 'demo.cbl': content },
      'ITEM-COUNT',
      'Property',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'RECORD-COUNT', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content.replaceAll('ITEM-COUNT', 'RECORD-COUNT'),
    );
  }, 60000);

  it('keeps PICTURE strings unrelated when their spelling matches a data name', async () => {
    const content = [
      '>>SOURCE FORMAT FREE',
      'IDENTIFICATION DIVISION.',
      'PROGRAM-ID. DEMO.',
      'DATA DIVISION.',
      'WORKING-STORAGE SECTION.',
      '01 XX PIC IS XX(2).',
      'PROCEDURE DIVISION.',
      '    DISPLAY XX.',
      '',
    ].join('\n');
    const { root, nodes, symbol } = await fixture({ 'demo.cbl': content }, 'XX', 'Property');
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'VALUE-CODE', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content.replace('01 XX', '01 VALUE-CODE').replace('DISPLAY XX', 'DISPLAY VALUE-CODE'),
    );
  }, 60000);

  it('refuses an unclassified data clause operand instead of silently omitting it', async () => {
    const content = [
      '>>SOURCE FORMAT FREE',
      'IDENTIFICATION DIVISION.',
      'PROGRAM-ID. DEMO.',
      'DATA DIVISION.',
      'FILE SECTION.',
      'FD DATAFILE LINAGE IS LINE-COUNT.',
      '01 OUTPUT-RECORD PIC X(80).',
      'WORKING-STORAGE SECTION.',
      '01 LINE-COUNT PIC 99.',
      'PROCEDURE DIVISION.',
      '    DISPLAY LINE-COUNT.',
      '',
    ].join('\n');
    const { root, nodes, symbol } = await fixture(
      { 'demo.cbl': content },
      'LINE-COUNT',
      'Property',
    );
    await expect(
      planGraphRename(root, symbol, { new_name: 'ROW-COUNT' }, nodes),
    ).rejects.toMatchObject({
      code: 'unsupported_occurrence',
    });
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'ROW-COUNT', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'unsupported_occurrence',
    });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(content);
  }, 60000);

  it('preserves fixed-format sequence columns, CRLF, comments and string literals', async () => {
    const content = [
      '000100 IDENTIFICATION DIVISION.',
      '000200 PROGRAM-ID. DEMO.',
      '000300 PROCEDURE DIVISION.',
      '000400 MAIN-PARA.',
      '000500     PERFORM WORK-PARA.',
      '000600* WORK-PARA stays in this comment 😀',
      '000700 WORK-PARA.',
      '000800     DISPLAY "WORK-PARA".',
      '000900     STOP RUN.',
      '',
    ].join('\r\n');
    const { root, nodes, symbol } = await fixture({ 'demo.cbl': content }, 'WORK-PARA', 'Function');
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'FINISH-PARA', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content
        .replace('PERFORM WORK-PARA', 'PERFORM FINISH-PARA')
        .replace('000700 WORK-PARA', '000700 FINISH-PARA'),
    );
  }, 60000);

  it('renames a section and its qualified paragraph uses and PERFORM target', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    PERFORM WORK-SECTION\n    PERFORM WORK-PARA OF WORK-SECTION THRU LAST-PARA.\nWORK-SECTION SECTION.\nWORK-PARA.\n    CONTINUE.\nLAST-PARA.\n    STOP RUN.\n';
    const { root, nodes, symbol } = await fixture(
      { 'demo.cbl': content },
      'WORK-SECTION',
      'Namespace',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'FINISH-SECTION', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content.replaceAll('WORK-SECTION', 'FINISH-SECTION'),
    );
  }, 60000);

  it('keeps qualified same-name data fields and unrelated programs distinct', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 FIRST-GROUP.\n  05 ITEM-CODE PIC 9.\n01 SECOND-GROUP.\n  05 ITEM-CODE PIC 9.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    MOVE ITEM-CODE OF FIRST-GROUP TO ITEM-CODE IN SECOND-GROUP\n    DISPLAY item-code of first-group "ITEM-CODE".\n    STOP RUN.\n';
    const other =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. OTHER.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 ITEM-CODE PIC 9.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    DISPLAY ITEM-CODE.\n';
    const { root, nodes, symbol } = await fixture(
      { 'demo.cbl': content, 'other.cbl': other },
      'ITEM-CODE',
      'Property',
      'demo.cbl',
      7,
    );
    expect(
      nodes.filter(
        (node) =>
          node.label === 'Property' &&
          node.properties.filePath === 'demo.cbl' &&
          node.properties.name === 'ITEM-CODE',
      ),
    ).toHaveLength(2);
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'PRODUCT-CODE', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content
        .replace('05 ITEM-CODE', '05 PRODUCT-CODE')
        .replace('MOVE ITEM-CODE', 'MOVE PRODUCT-CODE')
        .replace('DISPLAY item-code', 'DISPLAY PRODUCT-CODE'),
    );
    expect(await fs.readFile(path.join(root, 'other.cbl'), 'utf8')).toBe(other);
  }, 60000);

  it('renames a data group through qualifiers without renaming its subordinate storage', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 FIRST-GROUP.\n  05 ITEM-CODE PIC 9.\n01 SECOND-GROUP.\n  05 ITEM-CODE PIC 9.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    INITIALIZE FIRST-GROUP\n    MOVE ITEM-CODE OF FIRST-GROUP TO ITEM-CODE OF SECOND-GROUP.\n';
    const { root, nodes, symbol } = await fixture(
      { 'demo.cbl': content },
      'FIRST-GROUP',
      'Property',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'INPUT-GROUP', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content.replaceAll('FIRST-GROUP', 'INPUT-GROUP'),
    );
  }, 60000);

  it('renames PROGRAM-ID, END PROGRAM and static CALL literals across files', async () => {
    const program =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. WORKER.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    GOBACK.\nEND PROGRAM worker.\n';
    const caller =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DRIVER.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    CALL "worker"\n    DISPLAY "WORKER".\n';
    const { root, nodes, symbol } = await fixture(
      { 'worker.cbl': program, 'driver.cbl': caller },
      'WORKER',
      'Module',
      'worker.cbl',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'SERVICE', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'worker.cbl'), 'utf8')).toBe(
      program
        .replace('PROGRAM-ID. WORKER', 'PROGRAM-ID. SERVICE')
        .replace('END PROGRAM worker', 'END PROGRAM SERVICE'),
    );
    expect(await fs.readFile(path.join(root, 'driver.cbl'), 'utf8')).toBe(
      caller.replace('CALL "worker"', 'CALL "SERVICE"'),
    );
  }, 60000);

  it('refuses ambiguous unqualified data without changing source', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 FIRST-GROUP.\n  05 ITEM-CODE PIC 9.\n01 SECOND-GROUP.\n  05 ITEM-CODE PIC 9.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    DISPLAY ITEM-CODE.\n';
    const { root, nodes, symbol } = await fixture(
      { 'demo.cbl': content },
      'ITEM-CODE',
      'Property',
      'demo.cbl',
      7,
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'PRODUCT-CODE', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'ambiguous_reference',
    });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(content);
  }, 60000);

  it('rejects a case-insensitive declaration collision', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 ITEM-CODE PIC 9.\n01 PRODUCT-CODE PIC 9.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    DISPLAY ITEM-CODE.\n';
    const { root, nodes, symbol } = await fixture({ 'demo.cbl': content }, 'ITEM-CODE', 'Property');
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'product-code', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'name_collision',
    });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(content);
  }, 60000);

  it('rejects program renaming across an unresolved dynamic CALL', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 PROGRAM-NAME PIC X(8).\nPROCEDURE DIVISION.\nMAIN-PARA.\n    CALL PROGRAM-NAME.\n';
    const { root, nodes, symbol } = await fixture({ 'demo.cbl': content }, 'DEMO', 'Module');
    const result = await renameSymbol(root, symbol, { new_name: 'SERVICE', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'unsupported_occurrence',
    });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(content);
  }, 60000);

  it('allows qualified data declarations in different groups to share the new name', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 FIRST-GROUP.\n  05 ITEM-CODE PIC 9.\n01 SECOND-GROUP.\n  05 PRODUCT-CODE PIC 9.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    MOVE ITEM-CODE OF FIRST-GROUP TO PRODUCT-CODE OF SECOND-GROUP.\n';
    const { root, nodes, symbol } = await fixture({ 'demo.cbl': content }, 'ITEM-CODE', 'Property');
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'PRODUCT-CODE', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content.replaceAll('ITEM-CODE', 'PRODUCT-CODE'),
    );
  }, 60000);

  it('rejects a program-name collision in another source file', async () => {
    const worker =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. WORKER.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    GOBACK.\n';
    const driver = worker.replace('WORKER', 'DRIVER');
    const { root, nodes, symbol } = await fixture(
      { 'worker.cbl': worker, 'driver.cbl': driver },
      'WORKER',
      'Module',
      'worker.cbl',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'driver', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'name_collision',
    });
    expect(await fs.readFile(path.join(root, 'worker.cbl'), 'utf8')).toBe(worker);
  }, 60000);

  it('preserves a sibling program with the same paragraph name', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. FIRST-PROG.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    PERFORM WORK-PARA.\nWORK-PARA.\n    GOBACK.\nEND PROGRAM FIRST-PROG.\nIDENTIFICATION DIVISION.\nPROGRAM-ID. SECOND-PROG.\nPROCEDURE DIVISION.\nMAIN-PARA.\n    PERFORM WORK-PARA.\nWORK-PARA.\n    GOBACK.\nEND PROGRAM SECOND-PROG.\n';
    const { root, nodes, symbol } = await fixture(
      { 'demo.cbl': content },
      'WORK-PARA',
      'Function',
      'demo.cbl',
      7,
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'FINISH-PARA', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content
        .replace('PERFORM WORK-PARA', 'PERFORM FINISH-PARA')
        .replace('\nWORK-PARA.', '\nFINISH-PARA.'),
    );
  }, 60000);

  it('renames a dynamic CALL data operand independently of program identities', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 PROGRAM-NAME PIC X(8).\nPROCEDURE DIVISION.\nMAIN-PARA.\n    CALL PROGRAM-NAME.\n';
    const { root, nodes, symbol } = await fixture(
      { 'demo.cbl': content },
      'PROGRAM-NAME',
      'Property',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'TARGET-PROGRAM', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content.replaceAll('PROGRAM-NAME', 'TARGET-PROGRAM'),
    );
  }, 60000);

  it('does not reinterpret PICTURE symbols or intrinsic function names as data references', async () => {
    const content =
      '>>SOURCE FORMAT FREE\nIDENTIFICATION DIVISION.\nPROGRAM-ID. DEMO.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 X PIC X(8).\n01 TRIM PIC X(8).\nPROCEDURE DIVISION.\nMAIN-PARA.\n    DISPLAY X FUNCTION TRIM(TRIM).\n';
    const { root, nodes, symbol } = await fixture({ 'demo.cbl': content }, 'TRIM', 'Property');
    const result = await renameSymbol(root, symbol, { new_name: 'TRIMMED', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'demo.cbl'), 'utf8')).toBe(
      content.replace('01 TRIM ', '01 TRIMMED ').replace('TRIM(TRIM)', 'TRIM(TRIMMED)'),
    );
  }, 60000);
});
