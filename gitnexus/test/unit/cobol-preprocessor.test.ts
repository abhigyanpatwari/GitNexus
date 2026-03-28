import { describe, it, expect } from 'vitest';
import {
  preprocessCobolSource,
  extractCobolSymbolsWithRegex,
} from '../../src/core/ingestion/cobol/cobol-preprocessor.js';
import type { CobolRegexResults } from '../../src/core/ingestion/cobol/cobol-preprocessor.js';
import { parseReplacingClause } from '../../src/core/ingestion/cobol/cobol-copy-expander.js';

// ---------------------------------------------------------------------------
// Helper: build COBOL source from an array of lines.
//
// The parser processes full raw lines including columns 1-6 (sequence area).
// Regexes anchored with ^\s+ (data items, FD, AUTHOR, etc.) require the line
// to start with whitespace, so test lines use spaces in cols 1-6 instead of
// numeric sequence numbers unless specifically testing sequence-number behavior.
//
// Column layout:
//   1-6:  sequence/patch area (spaces or digits)
//   7:    indicator (* comment, - continuation, / page break, space normal)
//   8-11: Area A (divisions, sections, paragraphs start here = 7 leading spaces)
//   12+:  Area B (statements = 11+ leading spaces)
// ---------------------------------------------------------------------------
function cobol(...lines: string[]): string {
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// preprocessCobolSource
// ---------------------------------------------------------------------------

describe('preprocessCobolSource', () => {
  it('replaces alphabetic patch markers in cols 1-6 with spaces', () => {
    const input = cobol('mzADD  IDENTIFICATION DIVISION.', 'estero PROGRAM-ID. TEST1.');
    const output = preprocessCobolSource(input);
    const lines = output.split('\n');
    expect(lines[0].substring(0, 6)).toBe('      ');
    expect(lines[0].substring(6)).toBe(' IDENTIFICATION DIVISION.');
    expect(lines[1].substring(0, 6)).toBe('      ');
  });

  it('strips numeric sequence numbers from cols 1-6', () => {
    const input = cobol('000100 IDENTIFICATION DIVISION.', '000200 PROGRAM-ID. TEST1.');
    const output = preprocessCobolSource(input);
    const lines = output.split('\n');
    expect(lines[0]).toBe('       IDENTIFICATION DIVISION.');
    expect(lines[1]).toBe('       PROGRAM-ID. TEST1.');
  });

  it('preserves lines shorter than 7 characters', () => {
    const input = cobol('SHORT', '      ', '000100 IDENTIFICATION DIVISION.');
    const output = preprocessCobolSource(input);
    const lines = output.split('\n');
    expect(lines[0]).toBe('SHORT');
    expect(lines[1]).toBe('      ');
  });

  it('preserves exact line count (no lines added/removed)', () => {
    const input = cobol(
      'mzADD  IDENTIFICATION DIVISION.',
      '000200 PROGRAM-ID. TEST1.',
      'patch# DATA DIVISION.',
      '',
      '000500 PROCEDURE DIVISION.',
    );
    const output = preprocessCobolSource(input);
    expect(output.split('\n').length).toBe(input.split('\n').length);
  });
});

// ---------------------------------------------------------------------------
// extractCobolSymbolsWithRegex
// ---------------------------------------------------------------------------

describe('extractCobolSymbolsWithRegex', () => {
  // -------------------------------------------------------------------------
  // PROGRAM-ID
  // -------------------------------------------------------------------------
  describe('PROGRAM-ID', () => {
    it('extracts PROGRAM-ID from IDENTIFICATION DIVISION', () => {
      const src = cobol('      IDENTIFICATION DIVISION.', '       PROGRAM-ID. TESTPROG.');
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('TESTPROG');
    });

    it('captures all PROGRAM-IDs in programs array with line ranges', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER-PROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           DISPLAY "OUTER".',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER-PROG.',
        '      PROCEDURE DIVISION.',
        '       INNER-PARA.',
        '           DISPLAY "INNER".',
        '       END PROGRAM INNER-PROG.',
        '       END PROGRAM OUTER-PROG.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('OUTER-PROG');
      expect(r.programs).toHaveLength(2);
      expect(r.programs[0].name).toBe('OUTER-PROG');
      expect(r.programs[0].nestingDepth).toBe(0);
      expect(r.programs[1].name).toBe('INNER-PROG');
      expect(r.programs[1].nestingDepth).toBe(1);
      // INNER-PROG's startLine < endLine, contained within OUTER-PROG
      expect(r.programs[0].startLine).toBe(2); // OUTER-PROG
      expect(r.programs[1].startLine).toBe(7); // INNER-PROG
      expect(r.programs[1].endLine).toBe(11); // END PROGRAM INNER-PROG
      expect(r.programs[0].endLine).toBe(12); // END PROGRAM OUTER-PROG
    });

    it('returns null programName for content without PROGRAM-ID', () => {
      const src = cobol('      IDENTIFICATION DIVISION.', '       AUTHOR. SOMEONE.');
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Paragraphs & Sections
  // -------------------------------------------------------------------------
  describe('Paragraphs & Sections', () => {
    it('extracts paragraphs in PROCEDURE DIVISION (7 leading spaces)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           DISPLAY "HELLO".',
        '       SUB-PARA.',
        '           DISPLAY "WORLD".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.paragraphs).toHaveLength(2);
      expect(r.paragraphs[0].name).toBe('MAIN-PARA');
      expect(r.paragraphs[1].name).toBe('SUB-PARA');
    });

    it('extracts sections in PROCEDURE DIVISION', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       INIT-SECTION SECTION.',
        '       INIT-PARA.',
        '           DISPLAY "INIT".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sections).toHaveLength(1);
      expect(r.sections[0].name).toBe('INIT-SECTION');
      expect(r.paragraphs).toHaveLength(1);
      expect(r.paragraphs[0].name).toBe('INIT-PARA');
    });

    it('excludes reserved names (DECLARATIVES, END, PROCEDURE, etc.)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       DECLARATIVES.',
        '       END.',
        '       REAL-PARA.',
        '           DISPLAY "OK".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.paragraphs.map((p) => p.name)).toEqual(['REAL-PARA']);
    });

    it('does NOT treat IDENTIFICATION/ENVIRONMENT/DATA/WORKING-STORAGE as paragraphs', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '      PROCEDURE DIVISION.',
        '       REAL-PARA.',
        '           DISPLAY "OK".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const names = r.paragraphs.map((p) => p.name);
      expect(names).not.toContain('IDENTIFICATION');
      expect(names).not.toContain('ENVIRONMENT');
      expect(names).not.toContain('DATA');
      expect(names).not.toContain('WORKING-STORAGE');
      expect(names).toContain('REAL-PARA');
    });
  });

  // -------------------------------------------------------------------------
  // CALL / PERFORM / COPY
  // -------------------------------------------------------------------------
  describe('CALL / PERFORM / COPY', () => {
    it('extracts CALL "PROGRAM" statements', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CALL "SUBPROG".',
        '           CALL "ANOTHER".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(2);
      expect(r.calls[0].target).toBe('SUBPROG');
      expect(r.calls[1].target).toBe('ANOTHER');
    });

    it('extracts PERFORM paragraph-name with caller context', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM SUB-PARA.',
        '       SUB-PARA.',
        '           DISPLAY "HELLO".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs).toHaveLength(1);
      expect(r.performs[0].target).toBe('SUB-PARA');
      expect(r.performs[0].caller).toBe('MAIN-PARA');
    });

    it('extracts PERFORM ... THRU ... statements', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM STEP-A THRU STEP-Z.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs).toHaveLength(1);
      expect(r.performs[0].target).toBe('STEP-A');
      expect(r.performs[0].thruTarget).toBe('STEP-Z');
    });

    it('does NOT store PERFORM WS-COUNT TIMES as a perform target', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM WS-COUNT TIMES.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs.map((p) => p.target)).not.toContain('WS-COUNT');
    });

    it('extracts dynamic CALL (unquoted) with isQuoted=false', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CALL WS-PROG-NAME.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('WS-PROG-NAME');
      expect(r.calls[0].isQuoted).toBe(false);
    });

    it('quoted CALL has isQuoted=true', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CALL "SUBPROG".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].isQuoted).toBe(true);
    });

    it('extracts COPY copybook (unquoted)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '           COPY WSCOPY.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.copies).toHaveLength(1);
      expect(r.copies[0].target).toBe('WSCOPY');
    });

    it('extracts COPY "copybook" (quoted)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '           COPY "MY-COPY".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.copies).toHaveLength(1);
      expect(r.copies[0].target).toBe('MY-COPY');
    });
  });

  // -------------------------------------------------------------------------
  // Data Division
  // -------------------------------------------------------------------------
  describe('Data Division', () => {
    it('extracts data items with level, name, PIC, USAGE', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-RECORD.',
        '           05  WS-NAME          PIC X(30).',
        '           05  WS-AMOUNT        PIC 9(7)V99 USAGE COMP-3.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.dataItems.length).toBe(3); // WS-NAME + WS-BALANCE + WS-AMOUNT (01-level group with only period has no clauses)

      const wsName = r.dataItems.find((d) => d.name === 'WS-NAME');
      expect(wsName).toBeDefined();
      expect(wsName!.level).toBe(5);
      expect(wsName!.pic).toMatch(/^X\(30\)/);

      const wsAmount = r.dataItems.find((d) => d.name === 'WS-AMOUNT');
      expect(wsAmount).toBeDefined();
      expect(wsAmount!.usage).toBe('COMP-3');
    });

    it('extracts 88-level condition names with values', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-STATUS          PIC X.',
        '           88  WS-ACTIVE      VALUE "A".',
        '           88  WS-INACTIVE    VALUE "I".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const active = r.dataItems.find((d) => d.name === 'WS-ACTIVE');
      expect(active).toBeDefined();
      expect(active!.level).toBe(88);
      expect(active!.values).toEqual(['A']);

      const inactive = r.dataItems.find((d) => d.name === 'WS-INACTIVE');
      expect(inactive).toBeDefined();
      expect(inactive!.values).toEqual(['I']);
    });

    it('extracts FD entries with record name linkage', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      FILE SECTION.',
        '       FD  EMPLOYEE-FILE.',
        '       01  EMPLOYEE-RECORD.',
        '           05  EMP-ID          PIC 9(5).',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.fdEntries).toHaveLength(1);
      expect(r.fdEntries[0].fdName).toBe('EMPLOYEE-FILE');
      expect(r.fdEntries[0].recordName).toBe('EMPLOYEE-RECORD');
    });

    it('skips FILLER items', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-REC.',
        '           05  FILLER            PIC X(10).',
        '           05  WS-DATA           PIC X(20).',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const fillerItems = r.dataItems.filter((d) => d.name === 'FILLER');
      expect(fillerItems).toHaveLength(0);
      expect(r.dataItems.find((d) => d.name === 'WS-DATA')).toBeDefined();
    });

    it('correctly assigns data section (working-storage, linkage, file)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      FILE SECTION.',
        '       FD  MY-FILE.',
        '       01  FILE-REC              PIC X(80).',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-VAR               PIC X(10).',
        '      LINKAGE SECTION.',
        '       01  LK-VAR               PIC X(10).',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');

      const fileRec = r.dataItems.find((d) => d.name === 'FILE-REC');
      expect(fileRec).toBeDefined();
      expect(fileRec!.section).toBe('file');

      const wsVar = r.dataItems.find((d) => d.name === 'WS-VAR');
      expect(wsVar).toBeDefined();
      expect(wsVar!.section).toBe('working-storage');

      const lkVar = r.dataItems.find((d) => d.name === 'LK-VAR');
      expect(lkVar).toBeDefined();
      expect(lkVar!.section).toBe('linkage');
    });
  });

  // -------------------------------------------------------------------------
  // Environment Division
  // -------------------------------------------------------------------------
  describe('Environment Division', () => {
    it('extracts SELECT ... ASSIGN TO with organization, access, record key', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      INPUT-OUTPUT SECTION.',
        '       FILE-CONTROL.',
        '           SELECT EMPLOYEE-FILE',
        '               ASSIGN TO "EMPFILE"',
        '               ORGANIZATION IS INDEXED',
        '               ACCESS MODE IS DYNAMIC',
        '               RECORD KEY IS EMP-ID.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.fileDeclarations).toHaveLength(1);
      const fd = r.fileDeclarations[0];
      expect(fd.selectName).toBe('EMPLOYEE-FILE');
      expect(fd.assignTo).toBe('EMPFILE');
      expect(fd.organization).toBe('INDEXED');
      expect(fd.access).toBe('DYNAMIC');
      expect(fd.recordKey).toBe('EMP-ID');
    });
  });

  // -------------------------------------------------------------------------
  // State Machine
  // -------------------------------------------------------------------------
  describe('State Machine', () => {
    it('correctly transitions between divisions', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01  WS-VAR              PIC X(10).',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           DISPLAY WS-VAR.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('TESTPROG');
      expect(r.dataItems.find((d) => d.name === 'WS-VAR')).toBeDefined();
      expect(r.paragraphs).toHaveLength(1);
      expect(r.paragraphs[0].name).toBe('MAIN-PARA');
    });

    it('handles continuation lines (indicator "-" in column 7)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CALL "VERY-LONG-PR',
        '      -    "OGRAM-NAME".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // Continuation merges lines; at minimum verify no crash and paragraph found
      expect(r.paragraphs).toHaveLength(1);
      expect(r.paragraphs[0].name).toBe('MAIN-PARA');
    });

    it('skips comment lines (indicator "*" or "/" in column 7)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '      *    THIS IS A COMMENT',
        '      /    THIS IS A PAGE BREAK COMMENT',
        '           CALL "REALPROG".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('REALPROG');
    });
  });

  // -------------------------------------------------------------------------
  // EXEC Blocks
  // -------------------------------------------------------------------------
  describe('EXEC Blocks', () => {
    it('extracts EXEC SQL blocks with tables and host variables', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL',
        '             SELECT EMP-NAME, EMP-SALARY',
        '             FROM EMPLOYEE',
        '             WHERE EMP-ID = :WS-EMP-ID',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks).toHaveLength(1);
      const sql = r.execSqlBlocks[0];
      expect(sql.operation).toBe('SELECT');
      expect(sql.tables).toContain('EMPLOYEE');
      expect(sql.hostVariables).toContain('WS-EMP-ID');
    });

    it('extracts EXEC CICS blocks with command and MAP/PROGRAM/TRANSID', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           EXEC CICS SEND MAP('EMPMAP')",
        "             PROGRAM('EMPPROG')",
        "             TRANSID('EMPT')",
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execCicsBlocks).toHaveLength(1);
      const cics = r.execCicsBlocks[0];
      expect(cics.command).toBe('SEND MAP');
      expect(cics.mapName).toBe('EMPMAP');
      expect(cics.programName).toBe('EMPPROG');
      expect(cics.transId).toBe('EMPT');
    });

    it('extracts EXEC CICS MAP with unquoted identifier', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC CICS SEND MAP(WS-MAP-NAME)',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execCicsBlocks).toHaveLength(1);
      expect(r.execCicsBlocks[0].mapName).toBe('WS-MAP-NAME');
    });

    it('handles single-line EXEC SQL ... END-EXEC', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL DELETE FROM ORDERS WHERE ORD-ID = :WS-ORD END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks).toHaveLength(1);
      expect(r.execSqlBlocks[0].operation).toBe('DELETE');
      expect(r.execSqlBlocks[0].tables).toContain('ORDERS');
    });

    it('handles multi-line EXEC SQL ... END-EXEC', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL',
        '             INSERT INTO AUDIT_LOG',
        '             VALUES (:WS-TIMESTAMP, :WS-USER)',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks).toHaveLength(1);
      const sql = r.execSqlBlocks[0];
      expect(sql.operation).toBe('INSERT');
      expect(sql.tables).toContain('AUDIT_LOG');
      expect(sql.hostVariables).toContain('WS-TIMESTAMP');
      expect(sql.hostVariables).toContain('WS-USER');
    });
  });

  // -------------------------------------------------------------------------
  // Linkage & Data Flow
  // -------------------------------------------------------------------------
  describe('Linkage & Data Flow', () => {
    it('extracts PROCEDURE DIVISION USING parameters', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      LINKAGE SECTION.',
        '       01  LK-PARAM1            PIC X(10).',
        '       01  LK-PARAM2            PIC 9(5).',
        '      PROCEDURE DIVISION USING LK-PARAM1 LK-PARAM2.',
        '       MAIN-PARA.',
        '           DISPLAY LK-PARAM1.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.procedureUsing).toEqual(['LK-PARAM1', 'LK-PARAM2']);
    });

    it('extracts ENTRY points with USING', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           ENTRY "ALTENTRY" USING WS-PARAM1 WS-PARAM2.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.entryPoints).toHaveLength(1);
      expect(r.entryPoints[0].name).toBe('ALTENTRY');
      expect(r.entryPoints[0].parameters).toEqual(['WS-PARAM1', 'WS-PARAM2']);
    });

    it("extracts ENTRY 'ALTENTRY' with single-quoted target", () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           ENTRY 'ALTENTRY' USING WS-PARAM1.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.entryPoints).toHaveLength(1);
      expect(r.entryPoints[0].name).toBe('ALTENTRY');
      expect(r.entryPoints[0].parameters).toEqual(['WS-PARAM1']);
    });

    it('ENTRY USING filters calling-convention keywords (BY VALUE REFERENCE)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           ENTRY 'ALTENTRY' USING BY VALUE WS-AMT BY REFERENCE LS-REC.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.entryPoints).toHaveLength(1);
      // BY, VALUE, REFERENCE should be filtered out — only actual parameter names remain
      expect(r.entryPoints[0].parameters).toEqual(['WS-AMT', 'LS-REC']);
    });

    it('paragraphs with SECTION in name are NOT excluded (e.g., CROSS-SECTION-PROC)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       CROSS-SECTION-ANALYSIS.',
        '           DISPLAY "HELLO".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.paragraphs.map((p) => p.name)).toContain('CROSS-SECTION-ANALYSIS');
    });

    it('PERFORM THROUGH (full spelling) captures thruTarget', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM FIRST-PARA THROUGH LAST-PARA.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.performs).toHaveLength(1);
      expect(r.performs[0].target).toBe('FIRST-PARA');
      expect(r.performs[0].thruTarget).toBe('LAST-PARA');
    });

    it('PROCEDURE DIVISION USING RETURNING excludes return value from USING list', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION USING WS-INPUT RETURNING WS-RESULT.',
        '       MAIN-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // RETURNING and everything after it should be excluded — only USING parameters remain
      expect(r.procedureUsing).toEqual(['WS-INPUT']);
    });

    it('RE_CALL_DYNAMIC does NOT false-match on WS-CALL compound identifier', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       05  WS-CALL OCCURS 10 PIC X(10).',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           DISPLAY WS-CALL.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // WS-CALL should NOT produce a dynamic CALL — it's a data item name
      expect(r.calls.filter((c) => !c.isQuoted)).toHaveLength(0);
    });

    it('multi-line SORT captures USING and GIVING from continuation lines', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SORT SORT-FILE',
        '               ON ASCENDING KEY WS-KEY',
        '               USING INPUT-FILE',
        '               GIVING OUTPUT-FILE.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sorts).toHaveLength(1);
      expect(r.sorts[0].sortFile).toBe('SORT-FILE');
      expect(r.sorts[0].usingFiles).toContain('INPUT-FILE');
      expect(r.sorts[0].givingFiles).toContain('OUTPUT-FILE');
    });

    it('PROCEDURE DIVISION USING on split line is captured via pendingProcUsing', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION',
        '           USING WS-PARAM1 WS-PARAM2.',
        '       MAIN-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.procedureUsing).toEqual(['WS-PARAM1', 'WS-PARAM2']);
    });

    it('nested programs carry per-program procedureUsing', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER.',
        '      PROCEDURE DIVISION USING WS-OUTER-PARAM.',
        '       MAIN-PARA.',
        '           DISPLAY WS-OUTER-PARAM.',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER.',
        '      PROCEDURE DIVISION USING WS-INNER-PARAM.',
        '       INNER-PARA.',
        '           DISPLAY WS-INNER-PARAM.',
        '       END PROGRAM INNER.',
        '       END PROGRAM OUTER.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programs).toHaveLength(2);
      const outer = r.programs.find((p) => p.name === 'OUTER');
      const inner = r.programs.find((p) => p.name === 'INNER');
      expect(outer?.procedureUsing).toEqual(['WS-OUTER-PARAM']);
      expect(inner?.procedureUsing).toEqual(['WS-INNER-PARAM']);
    });

    it('SECTION with segment number is detected', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-SECTION SECTION 30.',
        '       MAIN-PARA.',
        '           DISPLAY "HI".',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sections.map((s) => s.name)).toContain('MAIN-SECTION');
    });

    it('dynamic CANCEL via data item is captured with isQuoted=false', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CANCEL WS-PGM-NAME.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.cancels).toHaveLength(1);
      expect(r.cancels[0].target).toBe('WS-PGM-NAME');
      expect(r.cancels[0].isQuoted).toBe(false);
    });

    it('copybook preprocessing strips sequence numbers before expansion', () => {
      // This is tested indirectly — preprocessCobolSource is called in readCopy
      const input = cobol('000100 IDENTIFICATION DIVISION.', '000200 PROGRAM-ID. TEST1.');
      const output = preprocessCobolSource(input);
      // Verify cols 1-6 are blanked for numeric sequences
      expect(output.split('\n')[0]).toBe('       IDENTIFICATION DIVISION.');
    });

    it('numeric sequence numbers are stripped so paragraphs are detected', () => {
      const src = preprocessCobolSource(
        cobol(
          '000100 IDENTIFICATION DIVISION.',
          '000200 PROGRAM-ID. SEQTEST.',
          '000300 PROCEDURE DIVISION.',
          '000400 MAIN-PARA.',
          '000500     DISPLAY "HI".',
        ),
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('SEQTEST');
      expect(r.paragraphs.map((p) => p.name)).toEqual(['MAIN-PARA']);
    });

    it('extracts MOVE statements (skipping figurative constants)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           MOVE WS-SOURCE TO WS-TARGET.',
        '           MOVE SPACES TO WS-BLANK.',
        '           MOVE ZEROS TO WS-ZERO.',
        '           MOVE CORRESPONDING WS-REC1 TO WS-REC2.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const moveData = r.moves.map((m) => ({
        from: m.from,
        targets: m.targets,
        corr: m.corresponding,
      }));
      expect(moveData).toContainEqual({ from: 'WS-SOURCE', targets: ['WS-TARGET'], corr: false });
      expect(moveData).toContainEqual({ from: 'WS-REC1', targets: ['WS-REC2'], corr: true });
      expect(r.moves.find((m) => m.from === 'SPACES')).toBeUndefined();
      expect(r.moves.find((m) => m.from === 'ZEROS')).toBeUndefined();
    });

    it('captures multiple MOVE targets: MOVE X TO A B C', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           MOVE WS-SOURCE TO WS-A WS-B WS-C.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.moves).toHaveLength(1);
      expect(r.moves[0].targets).toEqual(['WS-A', 'WS-B', 'WS-C']);
    });

    it('MOVE CORRESPONDING is always single target', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           MOVE CORRESPONDING WS-REC1 TO WS-REC2.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.moves).toHaveLength(1);
      expect(r.moves[0].targets).toEqual(['WS-REC2']);
      expect(r.moves[0].corresponding).toBe(true);
    });

    it('MOVE handles OF-qualified names', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           MOVE WS-SRC TO WS-NAME OF WS-RECORD WS-CODE.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.moves).toHaveLength(1);
      // WS-NAME OF WS-RECORD -> WS-NAME is the target; WS-CODE is a second target
      expect(r.moves[0].targets).toEqual(['WS-NAME', 'WS-CODE']);
    });

    it('MOVE skips figurative constants in targets', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           MOVE WS-SRC TO SPACES.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // SPACES is in MOVE_SKIP, so no targets -> no move entry
      expect(r.moves).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------
  describe('Edge Cases', () => {
    it('empty program returns empty results', () => {
      const r = extractCobolSymbolsWithRegex('', 'empty.cbl');
      expect(r.programName).toBeNull();
      expect(r.paragraphs).toHaveLength(0);
      expect(r.sections).toHaveLength(0);
      expect(r.performs).toHaveLength(0);
      expect(r.calls).toHaveLength(0);
      expect(r.copies).toHaveLength(0);
      expect(r.dataItems).toHaveLength(0);
      expect(r.fileDeclarations).toHaveLength(0);
      expect(r.fdEntries).toHaveLength(0);
      expect(r.execSqlBlocks).toHaveLength(0);
      expect(r.execCicsBlocks).toHaveLength(0);
      expect(r.procedureUsing).toHaveLength(0);
      expect(r.entryPoints).toHaveLength(0);
      expect(r.moves).toHaveLength(0);
    });

    it('extracts AUTHOR and DATE-WRITTEN from program metadata', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '       AUTHOR. JOHN DOE.',
        '       DATE-WRITTEN. 2025-01-15.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programMetadata.author).toBe('JOHN DOE');
      expect(r.programMetadata.dateWritten).toBe('2025-01-15');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 1: Data Flow Features
  // -------------------------------------------------------------------------
  describe('Phase 1: Data Flow Features', () => {
    it('EXEC SQL INCLUDE extracts member name (unquoted)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '           EXEC SQL INCLUDE SQLCA END-EXEC.',
        '           EXEC SQL INCLUDE CUSTDCL END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const includes = r.execSqlBlocks.filter((b) => b.includeMember);
      expect(includes).toHaveLength(2);
      expect(includes[0].includeMember).toBe('SQLCA');
      expect(includes[1].includeMember).toBe('CUSTDCL');
    });

    it('EXEC SQL INCLUDE handles quoted and underscored member names', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        "           EXEC SQL INCLUDE 'DBRMLIB.MEMBER' END-EXEC.",
        '           EXEC SQL INCLUDE CUST_TBL_DCL END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const includes = r.execSqlBlocks.filter((b) => b.includeMember);
      expect(includes).toHaveLength(2);
      expect(includes[0].includeMember).toBe('DBRMLIB.MEMBER');
      expect(includes[1].includeMember).toBe('CUST_TBL_DCL');
    });

    it('CALL USING extracts parameters', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'AUDITLOG' USING WS-CUST-ID WS-AMOUNT.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-CUST-ID', 'WS-AMOUNT']);
    });

    it('CALL USING filters BY REFERENCE/CONTENT/VALUE keywords', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM' USING BY REFERENCE WS-A BY CONTENT WS-B BY VALUE WS-C.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls[0].parameters).toEqual(['WS-A', 'WS-B', 'WS-C']);
    });

    it('CALL USING filters ADDRESS OF and OMITTED', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM' USING ADDRESS OF WS-REC OMITTED WS-FLAG.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls[0].parameters).toEqual(['WS-REC', 'WS-FLAG']);
    });

    it('CALL RETURNING extracts return target', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'FUNC' USING WS-INPUT RETURNING WS-RESULT.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls[0].parameters).toEqual(['WS-INPUT']);
      expect(r.calls[0].returning).toBe('WS-RESULT');
    });

    it('OCCURS DEPENDING ON captures controlling field', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01 WS-COUNT PIC 9(4).',
        '       01 WS-TABLE OCCURS 1 TO 100 DEPENDING ON WS-COUNT.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const table = r.dataItems.find((d) => d.name === 'WS-TABLE');
      expect(table).toBeDefined();
      expect(table!.dependingOn).toBe('WS-COUNT');
      expect(table!.occurs).toBe(1);
    });

    it('VALUE clause extracts quoted string', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        "       01 WS-STATUS PIC X VALUE 'A'.",
        '       01 WS-COUNT PIC 9(4) VALUE 0.',
        '       01 WS-NAME PIC X(10) VALUE SPACES.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.dataItems.find((d) => d.name === 'WS-STATUS')?.values).toEqual(['A']);
      expect(r.dataItems.find((d) => d.name === 'WS-COUNT')?.values).toEqual(['0']);
      expect(r.dataItems.find((d) => d.name === 'WS-NAME')?.values).toEqual(['SPACES']);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2: IMS + Error Handling Features
  // -------------------------------------------------------------------------
  describe('Phase 2: IMS + Error Handling Features', () => {
    it('EXEC DLI GU extracts verb, segment, PCB, and INTO', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC DLI GU USING PCB(2)',
        '               SEGMENT(CUSTOMER)',
        '               INTO(CUST-IO-AREA)',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execDliBlocks).toHaveLength(1);
      expect(r.execDliBlocks[0].verb).toBe('GU');
      expect(r.execDliBlocks[0].pcbNumber).toBe(2);
      expect(r.execDliBlocks[0].segmentName).toBe('CUSTOMER');
      expect(r.execDliBlocks[0].intoField).toBe('CUST-IO-AREA');
    });

    it('EXEC DLI ISRT extracts FROM field', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC DLI ISRT USING PCB(1)',
        '               SEGMENT(ORDER)',
        '               FROM(ORDER-IO-AREA)',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execDliBlocks[0].verb).toBe('ISRT');
      expect(r.execDliBlocks[0].fromField).toBe('ORDER-IO-AREA');
    });

    it('EXEC DLI SCHD extracts PSB name', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC DLI SCHD PSB(CUSTPSB) END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execDliBlocks[0].verb).toBe('SCHD');
      expect(r.execDliBlocks[0].psbName).toBe('CUSTPSB');
    });

    it('DECLARATIVES USE AFTER EXCEPTION extracts file binding', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '      DECLARATIVES.',
        '      CUST-ERR SECTION.',
        '          USE AFTER STANDARD ERROR ON CUSTOMER-FILE.',
        '       CUST-ERR-PARA.',
        '           DISPLAY "FILE ERROR".',
        '      END DECLARATIVES.',
        '       MAIN-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.declaratives).toHaveLength(1);
      expect(r.declaratives[0].sectionName).toBe('CUST-ERR');
      expect(r.declaratives[0].target).toBe('CUSTOMER-FILE');
    });

    it('DECLARATIVES with multiple USE sections', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '      DECLARATIVES.',
        '      ERR-A SECTION.',
        '          USE AFTER STANDARD EXCEPTION ON FILE-A.',
        '       ERR-A-PARA.',
        '           DISPLAY "A".',
        '      ERR-B SECTION.',
        '          USE AFTER STANDARD EXCEPTION ON INPUT.',
        '       ERR-B-PARA.',
        '           DISPLAY "B".',
        '      END DECLARATIVES.',
        '       MAIN-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.declaratives).toHaveLength(2);
      expect(r.declaratives[0].target).toBe('FILE-A');
      expect(r.declaratives[1].target).toBe('INPUT');
    });

    it('SET condition TO TRUE extracts targets', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SET END-OF-FILE TO TRUE.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0].form).toBe('to-true');
      expect(r.sets[0].targets).toEqual(['END-OF-FILE']);
    });

    it('SET index UP BY extracts target and value', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SET IDX-1 UP BY 1.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0].form).toBe('up-by');
      expect(r.sets[0].targets).toEqual(['IDX-1']);
      expect(r.sets[0].value).toBe('1');
    });

    it('INSPECT TALLYING extracts field and counter', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           INSPECT WS-STRING TALLYING WS-COUNT FOR ALL 'A'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.inspects).toHaveLength(1);
      expect(r.inspects[0].inspectedField).toBe('WS-STRING');
      expect(r.inspects[0].counters).toEqual(['WS-COUNT']);
      expect(r.inspects[0].form).toBe('tallying');
    });

    it('INSPECT REPLACING detected', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           INSPECT WS-FIELD REPLACING ALL 'A' BY 'B'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.inspects).toHaveLength(1);
      expect(r.inspects[0].form).toBe('replacing');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3-4: Completeness + Niche Features
  // -------------------------------------------------------------------------
  describe('Phase 3-4: Completeness + Niche Features', () => {
    it('SELECT OPTIONAL sets isOptional flag', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      INPUT-OUTPUT SECTION.',
        '      FILE-CONTROL.',
        "          SELECT OPTIONAL CUST-FILE ASSIGN TO 'CUSTFILE'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.fileDeclarations).toHaveLength(1);
      expect(r.fileDeclarations[0].selectName).toBe('CUST-FILE');
      expect(r.fileDeclarations[0].isOptional).toBe(true);
    });

    it('ALTERNATE RECORD KEY extraction', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      INPUT-OUTPUT SECTION.',
        '      FILE-CONTROL.',
        "          SELECT CUST-FILE ASSIGN TO 'CUSTFILE'",
        '              RECORD KEY IS CUST-ID',
        '              ALTERNATE RECORD KEY IS CUST-NAME.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.fileDeclarations[0].recordKey).toBe('CUST-ID');
      expect(r.fileDeclarations[0].alternateKeys).toEqual(['CUST-NAME']);
    });

    it('PROGRAM-ID IS COMMON sets isCommon flag', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER-PGM.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           STOP RUN.',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER-PGM IS COMMON.',
        '      PROCEDURE DIVISION.',
        '       INNER-PARA.',
        '           STOP RUN.',
        '       END PROGRAM INNER-PGM.',
        '       END PROGRAM OUTER-PGM.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const inner = r.programs.find((p) => p.name === 'INNER-PGM');
      expect(inner).toBeDefined();
      expect(inner!.isCommon).toBe(true);
      const outer = r.programs.find((p) => p.name === 'OUTER-PGM');
      expect(outer!.isCommon).toBeFalsy();
    });

    it('IS EXTERNAL and IS GLOBAL as boolean properties', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01 WS-SHARED PIC X(10) IS EXTERNAL.',
        '       01 WS-GLOBAL PIC X(10) IS GLOBAL.',
        '       01 WS-NORMAL PIC X(10).',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.dataItems.find((d) => d.name === 'WS-SHARED')?.isExternal).toBe(true);
      expect(r.dataItems.find((d) => d.name === 'WS-GLOBAL')?.isGlobal).toBe(true);
      expect(r.dataItems.find((d) => d.name === 'WS-NORMAL')?.isExternal).toBeUndefined();
      expect(r.dataItems.find((d) => d.name === 'WS-NORMAL')?.isGlobal).toBeUndefined();
    });

    it('INITIALIZE extracts target', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           INITIALIZE WS-RECORD.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.initializes).toHaveLength(1);
      expect(r.initializes[0].target).toBe('WS-RECORD');
    });

    it('AUTHOR and DATE-WRITTEN mapped to programMetadata', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '       AUTHOR. JOHN DOE.',
        '       DATE-WRITTEN. 2026-03-26.',
        '       DATE-COMPILED. 2026-03-26.',
        '       INSTALLATION. MAINFRAME-01.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programMetadata.author).toBe('JOHN DOE');
      expect(r.programMetadata.dateWritten).toBe('2026-03-26');
      expect(r.programMetadata.dateCompiled).toBe('2026-03-26');
      expect(r.programMetadata.installation).toBe('MAINFRAME-01');
    });
  });

  // -------------------------------------------------------------------------
  // Reviews 9-15: Multi-line CALL USING accumulation
  // -------------------------------------------------------------------------
  describe('Multi-line CALL USING accumulation', () => {
    it('captures USING parameters on separate lines (IBM mainframe style)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'CUSTUPDT'",
        '               USING BY REFERENCE WS-CUST-ID',
        '                                  WS-CUST-NAME',
        '                                  WS-CUST-ADDR.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('CUSTUPDT');
      expect(r.calls[0].parameters).toEqual(['WS-CUST-ID', 'WS-CUST-NAME', 'WS-CUST-ADDR']);
    });

    it('does NOT absorb next statement as USING parameter (no END-CALL)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'CUSTUPDT'",
        '               USING WS-PARM.',
        '           INSPECT WS-STATUS TALLYING WS-CNT FOR ALL SPACES.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-PARM']);
      // INSPECT should be extracted separately, not absorbed
      expect(r.inspects).toHaveLength(1);
      expect(r.inspects[0].inspectedField).toBe('WS-STATUS');
    });

    it('does NOT absorb GO TO on next line', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'CUSTUPDT'",
        '               USING WS-PARM.',
        '           GO TO EXIT-PARAGRAPH.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('CUSTUPDT');
      expect(r.gotos).toHaveLength(1);
      expect(r.gotos[0].target).toBe('EXIT-PARAGRAPH');
    });

    it('does NOT create false paragraph from last USING parameter on own line', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING WS-A',
        '                     WS-B.',
        '           PERFORM NEXT-PARA.',
        '       NEXT-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // WS-B should NOT be a paragraph
      const paraNames = r.paragraphs.map((p) => p.name);
      expect(paraNames).toContain('MAIN-PARA');
      expect(paraNames).toContain('NEXT-PARA');
      expect(paraNames).not.toContain('WS-B');
      // WS-B should be captured as USING parameter
      expect(r.calls[0].parameters).toContain('WS-B');
    });

    it('handles CALL with END-CALL scope terminator', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM' USING WS-A",
        '               ON EXCEPTION',
        '                   DISPLAY "ERROR"',
        '           END-CALL',
        '           PERFORM NEXT-STEP.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-A']);
      expect(r.performs).toHaveLength(1);
      expect(r.performs[0].target).toBe('NEXT-STEP');
    });

    it('does NOT false-flush on hyphenated identifiers like MOVE-COUNT', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING MOVE-COUNT',
        '                     PERFORM-LIMIT',
        '                     READ-STATUS.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls[0].parameters).toEqual(['MOVE-COUNT', 'PERFORM-LIMIT', 'READ-STATUS']);
    });

    it('captures both quoted and dynamic CALL on same line (ON EXCEPTION)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PRIMARY' ON EXCEPTION CALL WS-FALLBACK.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(2);
      expect(r.calls[0].target).toBe('PRIMARY');
      expect(r.calls[0].isQuoted).toBe(true);
      expect(r.calls[1].target).toBe('WS-FALLBACK');
      expect(r.calls[1].isQuoted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Reviews 9-15: Nested program edge attribution
  // -------------------------------------------------------------------------
  describe('Nested program edge attribution', () => {
    it('CALL in inner nested program attributed to inner module (not outer)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER-PGM.',
        '      PROCEDURE DIVISION.',
        '       OUTER-MAIN.',
        '           STOP RUN.',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER-PGM.',
        '      PROCEDURE DIVISION.',
        '       INNER-MAIN.',
        "           CALL 'SUBPROG'.",
        '       END PROGRAM INNER-PGM.',
        '       END PROGRAM OUTER-PGM.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // The CALL should have line number within INNER-PGM's range
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('SUBPROG');
      const innerProg = r.programs.find((p) => p.name === 'INNER-PGM');
      expect(innerProg).toBeDefined();
      expect(r.calls[0].line).toBe(10); // Line 10 in the fixture: CALL 'SUBPROG'.
    });

    it('PERFORM before first paragraph in nested program has correct caller', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER-PGM.',
        '      PROCEDURE DIVISION.',
        '       OUTER-MAIN.',
        '           STOP RUN.',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER-PGM.',
        '      PROCEDURE DIVISION.',
        '           PERFORM INNER-INIT.',
        '       INNER-INIT.',
        '           STOP RUN.',
        '       END PROGRAM INNER-PGM.',
        '       END PROGRAM OUTER-PGM.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // PERFORM before first paragraph — caller should be null (module-level)
      const innerPerform = r.performs.find((p) => p.target === 'INNER-INIT');
      expect(innerPerform).toBeDefined();
      expect(innerPerform!.caller).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Reviews 9-15: CRLF / Windows line ending compatibility
  // -------------------------------------------------------------------------
  describe('CRLF / Windows line ending compatibility', () => {
    it('GO TO DEPENDING ON works with CRLF line endings', () => {
      // Simulate CRLF by using \r\n
      const src = [
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           GO TO PARA-A PARA-B PARA-C',
        '               DEPENDING ON WS-SWITCH.',
      ].join('\r\n');
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.gotos).toHaveLength(3);
      expect(r.gotos.map((g) => g.target).sort()).toEqual(['PARA-A', 'PARA-B', 'PARA-C']);
    });
  });

  // -------------------------------------------------------------------------
  // Reviews 9-15: Fixed-format Area A paragraph detection
  // -------------------------------------------------------------------------
  describe('Fixed-format Area A paragraph detection', () => {
    it('rejects deeply-indented identifiers as paragraphs (Area B)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '               WS-CUST-ADDR.', // Area B (>7 spaces) — NOT a paragraph
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const paraNames = r.paragraphs.map((p) => p.name);
      expect(paraNames).toContain('MAIN-PARA');
      expect(paraNames).not.toContain('WS-CUST-ADDR');
    });

    it('accepts Area A indented paragraphs (7 spaces)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       REAL-PARA.', // 7 spaces — Area A, valid paragraph
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.paragraphs.map((p) => p.name)).toContain('REAL-PARA');
    });
  });

  // -------------------------------------------------------------------------
  // Reviews 9-15: SORT/MERGE edge cases
  // -------------------------------------------------------------------------
  describe('SORT/MERGE edge cases', () => {
    it('captures SORT GIVING without spurious COLLATING SEQUENCE keywords', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SORT SORT-FILE ON ASCENDING KEY SORT-KEY',
        '               COLLATING SEQUENCE IS NATL',
        '               USING INPUT-FILE',
        '               GIVING OUTPUT-FILE.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sorts).toHaveLength(1);
      expect(r.sorts[0].usingFiles).toEqual(['INPUT-FILE']);
      // COLLATING, SEQUENCE, IS, NATL should NOT appear as giving files
      expect(r.sorts[0].givingFiles).toEqual(['OUTPUT-FILE']);
    });
  });

  // -------------------------------------------------------------------------
  // Reviews 9-15: PROCEDURE DIVISION USING edge cases
  // -------------------------------------------------------------------------
  describe('PROCEDURE DIVISION USING edge cases', () => {
    it('excludes RETURNING value from USING parameter list', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION USING WS-INPUT RETURNING WS-RESULT.',
        '       MAIN-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.procedureUsing).toEqual(['WS-INPUT']);
    });

    it('pendingProcUsing not set for period-terminated PROCEDURE DIVISION', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.procedureUsing).toEqual([]);
      // No spurious parameters from the first procedure line
    });
  });

  // -------------------------------------------------------------------------
  // Reviews 9-15: Comment stripping edge cases
  // -------------------------------------------------------------------------
  describe('Comment stripping edge cases', () => {
    it('pipe character inside quoted string is preserved (not treated as comment)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        "       01 WS-SEP PIC X VALUE '|'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // The data item should be extracted (not truncated by pipe)
      expect(r.dataItems.find((d) => d.name === 'WS-SEP')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Reviews 9-15: SELECT OPTIONAL and ALTERNATE KEY
  // -------------------------------------------------------------------------
  describe('SELECT OPTIONAL and ALTERNATE KEY', () => {
    it('SELECT OPTIONAL captures correct file name (not OPTIONAL keyword)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      ENVIRONMENT DIVISION.',
        '      INPUT-OUTPUT SECTION.',
        '      FILE-CONTROL.',
        "          SELECT OPTIONAL BACKUP-FILE ASSIGN TO 'BACKUP'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.fileDeclarations).toHaveLength(1);
      expect(r.fileDeclarations[0].selectName).toBe('BACKUP-FILE');
      expect(r.fileDeclarations[0].isOptional).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Regression: EXEC DLI edge cases
  // -------------------------------------------------------------------------
  describe('EXEC DLI edge cases', () => {
    it('EXEC DLI without SEGMENT clause (DLET/REPL)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC DLI DLET USING PCB(2) END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execDliBlocks).toHaveLength(1);
      expect(r.execDliBlocks[0].verb).toBe('DLET');
      expect(r.execDliBlocks[0].segmentName).toBeUndefined();
    });

    it('multi-line EXEC DLI accumulates correctly', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC DLI GN',
        '               USING PCB(1)',
        '               SEGMENT(ORDER)',
        '               INTO(ORDER-IO)',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execDliBlocks).toHaveLength(1);
      expect(r.execDliBlocks[0].verb).toBe('GN');
      expect(r.execDliBlocks[0].segmentName).toBe('ORDER');
      expect(r.execDliBlocks[0].intoField).toBe('ORDER-IO');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: SET statement edge cases
  // -------------------------------------------------------------------------
  describe('SET statement edge cases', () => {
    it('SET multiple conditions TO TRUE', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SET COND-A COND-B COND-C TO TRUE.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0].targets).toEqual(['COND-A', 'COND-B', 'COND-C']);
      expect(r.sets[0].form).toBe('to-true');
    });

    it('SET index DOWN BY identifier', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SET IDX-1 DOWN BY WS-DECREMENT.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0].form).toBe('down-by');
      expect(r.sets[0].value).toBe('WS-DECREMENT');
    });

    it('SET index TO numeric value', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SET IDX-1 TO 5.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0].form).toBe('to-value');
      expect(r.sets[0].value).toBe('5');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: INSPECT multi-line edge cases
  // -------------------------------------------------------------------------
  describe('INSPECT multi-line edge cases', () => {
    it('INSPECT CONVERTING on single line', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           INSPECT WS-FIELD CONVERTING 'abc' TO 'ABC'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.inspects).toHaveLength(1);
      expect(r.inspects[0].form).toBe('converting');
      expect(r.inspects[0].inspectedField).toBe('WS-FIELD');
    });

    it('INSPECT TALLYING with multiple counters', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           INSPECT WS-STRING TALLYING',
        "               WS-CNT-A FOR ALL 'A'",
        "               WS-CNT-B FOR ALL 'B'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.inspects).toHaveLength(1);
      expect(r.inspects[0].counters).toEqual(['WS-CNT-A', 'WS-CNT-B']);
    });

    it('INSPECT combined TALLYING and REPLACING', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           INSPECT WS-DATA',
        "               TALLYING WS-COUNT FOR ALL 'X'",
        "               REPLACING ALL 'X' BY 'Y'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.inspects).toHaveLength(1);
      expect(r.inspects[0].form).toBe('tallying-replacing');
    });

    it('real paragraph header during INSPECT flushes accumulator', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           INSPECT WS-FIELD REPLACING ALL 'A' BY 'B'",
        '       NEXT-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // INSPECT should be flushed, NEXT-PARA should be detected
      expect(r.inspects).toHaveLength(1);
      expect(r.paragraphs.map((p) => p.name)).toContain('NEXT-PARA');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: DECLARATIVES edge cases
  // -------------------------------------------------------------------------
  describe('DECLARATIVES edge cases', () => {
    it('USE AFTER without STANDARD keyword (IBM extension)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '      DECLARATIVES.',
        '      FILE-ERR SECTION.',
        '          USE AFTER EXCEPTION ON MASTER-FILE.',
        '       FILE-ERR-PARA.',
        '           DISPLAY "ERROR".',
        '      END DECLARATIVES.',
        '       MAIN-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.declaratives).toHaveLength(1);
      expect(r.declaratives[0].target).toBe('MASTER-FILE');
    });

    it('USE AFTER on I-O mode (catch-all handler)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '      DECLARATIVES.',
        '      IO-ERR SECTION.',
        '          USE AFTER STANDARD ERROR ON I-O.',
        '       IO-ERR-PARA.',
        '           DISPLAY "I-O ERROR".',
        '      END DECLARATIVES.',
        '       MAIN-PARA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.declaratives).toHaveLength(1);
      expect(r.declaratives[0].target).toBe('I-O');
    });

    it('paragraphs after END DECLARATIVES are normal paragraphs', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '      DECLARATIVES.',
        '      ERR SECTION.',
        '          USE AFTER STANDARD ERROR ON INPUT.',
        '       ERR-PARA.',
        '           DISPLAY "E".',
        '      END DECLARATIVES.',
        '       MAIN-PARA.',
        '           PERFORM PROCESS-DATA.',
        '       PROCESS-DATA.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const paraNames = r.paragraphs.map((p) => p.name);
      expect(paraNames).toContain('ERR-PARA');
      expect(paraNames).toContain('MAIN-PARA');
      expect(paraNames).toContain('PROCESS-DATA');
      expect(r.performs).toHaveLength(1);
      expect(r.performs[0].target).toBe('PROCESS-DATA');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: COPY REPLACING edge cases
  // -------------------------------------------------------------------------
  describe('COPY REPLACING edge cases', () => {
    it('pseudotext replacement with empty target (deletion)', () => {
      const replacings = parseReplacingClause('==OLD-TEXT== BY ====');
      expect(replacings).toHaveLength(1);
      expect(replacings[0].from).toBe('OLD-TEXT');
      expect(replacings[0].to).toBe('');
      expect(replacings[0].isPseudotext).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Regression: Value clause edge cases
  // -------------------------------------------------------------------------
  describe('Value clause edge cases', () => {
    it('VALUE with hex literal', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        "       01 WS-HEX PIC X(4) VALUE X'F1F2F3F4'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const hex = r.dataItems.find((d) => d.name === 'WS-HEX');
      expect(hex).toBeDefined();
      expect(hex!.values).toBeDefined();
      expect(hex!.values![0]).toContain('F1F2F3F4');
    });

    it('VALUE with negative numeric', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01 WS-NEG PIC S9(4) VALUE -1.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.dataItems.find((d) => d.name === 'WS-NEG')?.values).toEqual(['-1']);
    });

    it('VALUE with ALL literal', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        "       01 WS-STARS PIC X(80) VALUE ALL '*'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const stars = r.dataItems.find((d) => d.name === 'WS-STARS');
      expect(stars?.values).toBeDefined();
      expect(stars!.values![0]).toContain('*');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: OCCURS DEPENDING ON edge cases
  // -------------------------------------------------------------------------
  describe('OCCURS DEPENDING ON edge cases', () => {
    it('OCCURS with TO range', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01 WS-CNT PIC 9(4).',
        '       01 WS-TBL OCCURS 1 TO 50 DEPENDING ON WS-CNT.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const tbl = r.dataItems.find((d) => d.name === 'WS-TBL');
      expect(tbl?.occurs).toBe(1);
      expect(tbl?.dependingOn).toBe('WS-CNT');
    });

    it('OCCURS without DEPENDING ON (fixed-size)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01 WS-ARR OCCURS 10.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.dataItems.find((d) => d.name === 'WS-ARR')?.occurs).toBe(10);
      expect(r.dataItems.find((d) => d.name === 'WS-ARR')?.dependingOn).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Regression: Dynamic CALL edge cases
  // -------------------------------------------------------------------------
  describe('Dynamic CALL edge cases', () => {
    it('dynamic CALL at end of line (no trailing space or period)', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CALL WS-PROGRAM',
        '               USING WS-DATA.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('WS-PROGRAM');
      expect(r.calls[0].isQuoted).toBe(false);
    });

    it('CANCEL at end of line', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           CANCEL WS-OLD-PROG.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.cancels).toHaveLength(1);
      expect(r.cancels[0].target).toBe('WS-OLD-PROG');
      expect(r.cancels[0].isQuoted).toBe(false);
    });

    it('multiple CANCELs on same line', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CANCEL 'PROG-A' CANCEL 'PROG-B'.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.cancels).toHaveLength(2);
      expect(r.cancels[0].target).toBe('PROG-A');
      expect(r.cancels[1].target).toBe('PROG-B');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: EXEC SQL edge cases
  // -------------------------------------------------------------------------
  describe('EXEC SQL edge cases', () => {
    it('EXEC SQL INCLUDE does not extract tables', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '           EXEC SQL INCLUDE SQLCA END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks).toHaveLength(1);
      expect(r.execSqlBlocks[0].includeMember).toBe('SQLCA');
      expect(r.execSqlBlocks[0].tables).toHaveLength(0);
    });

    it('EXEC SQL SELECT INTO host variable does not capture as table', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL',
        '               SELECT CUST_NAME INTO :WS-NAME',
        '               FROM CUSTOMER',
        '               WHERE CUST_ID = :WS-ID',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks).toHaveLength(1);
      // CUSTOMER should be a table, :WS-NAME should NOT
      expect(r.execSqlBlocks[0].tables).toContain('CUSTOMER');
      expect(r.execSqlBlocks[0].tables).not.toContain('WS-NAME');
    });

    it('EXEC SQL with host variables extracted', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL',
        '               UPDATE CUSTOMER SET BALANCE = :WS-AMT',
        '               WHERE CUST_ID = :WS-ID',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.execSqlBlocks[0].hostVariables).toContain('WS-AMT');
      expect(r.execSqlBlocks[0].hostVariables).toContain('WS-ID');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: INITIALIZE extraction
  // -------------------------------------------------------------------------
  describe('INITIALIZE extraction', () => {
    it('INITIALIZE extracts target field', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           INITIALIZE WS-CUSTOMER-REC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.initializes).toHaveLength(1);
      expect(r.initializes[0].target).toBe('WS-CUSTOMER-REC');
      expect(r.initializes[0].caller).toBe('MAIN-PARA');
    });

    it('INITIALIZE multi-target extracts all targets', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           INITIALIZE WS-CUSTOMER WS-ORDER WS-LINE-ITEM.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.initializes).toHaveLength(3);
      expect(r.initializes.map((i) => i.target)).toEqual([
        'WS-CUSTOMER',
        'WS-ORDER',
        'WS-LINE-ITEM',
      ]);
    });

    it('INITIALIZE with REPLACING clause does not capture keywords as targets', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           INITIALIZE WS-RECORD REPLACING NUMERIC BY ZEROS.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.initializes).toHaveLength(1);
      expect(r.initializes[0].target).toBe('WS-RECORD');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: Nested program boundary tracking
  // -------------------------------------------------------------------------
  describe('Nested program boundary tracking', () => {
    it('sibling programs after END PROGRAM are correctly scoped', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER.',
        '      PROCEDURE DIVISION.',
        '       OUTER-MAIN.',
        '           STOP RUN.',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER-A.',
        '      PROCEDURE DIVISION.',
        '       A-MAIN.',
        '           STOP RUN.',
        '       END PROGRAM INNER-A.',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER-B.',
        '      PROCEDURE DIVISION.',
        '       B-MAIN.',
        '           STOP RUN.',
        '       END PROGRAM INNER-B.',
        '       END PROGRAM OUTER.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programs).toHaveLength(3);
      expect(r.programs.map((p) => p.name).sort()).toEqual(['INNER-A', 'INNER-B', 'OUTER']);
      const innerA = r.programs.find((p) => p.name === 'INNER-A')!;
      const innerB = r.programs.find((p) => p.name === 'INNER-B')!;
      expect(innerA.endLine).toBe(11); // END PROGRAM INNER-A
      expect(innerB.startLine).toBe(13); // PROGRAM-ID. INNER-B
    });

    it('PROGRAM-ID without IDENTIFICATION DIVISION header detected', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER.',
        '      PROCEDURE DIVISION.',
        '       OUTER-MAIN.',
        '           STOP RUN.',
        '       PROGRAM-ID. SIBLING.',
        '      PROCEDURE DIVISION.',
        '       SIB-MAIN.',
        '           STOP RUN.',
        '       END PROGRAM SIBLING.',
        '       END PROGRAM OUTER.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const names = r.programs.map((p) => p.name);
      expect(names).toContain('SIBLING');
      expect(names).toContain('OUTER');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: EXEC block EOF flush
  // -------------------------------------------------------------------------
  describe('EXEC block EOF flush', () => {
    it('unclosed EXEC SQL is flushed at EOF', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           EXEC SQL',
        '               SELECT * FROM CUSTOMER',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // Should still extract even without END-EXEC
      expect(r.execSqlBlocks).toHaveLength(1);
      expect(r.execSqlBlocks[0].tables).toContain('CUSTOMER');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: Multi-PERFORM on same line
  // -------------------------------------------------------------------------
  describe('Multi-PERFORM on same line', () => {
    it('captures both PERFORMs in IF/ELSE on single line', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           IF WS-FLAG = 1 PERFORM PARA-A ELSE PERFORM PARA-B END-IF.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const targets = r.performs.map((p) => p.target).sort();
      expect(targets).toEqual(['PARA-A', 'PARA-B']);
    });
  });

  // -------------------------------------------------------------------------
  // Regression: Data item IS EXTERNAL / IS GLOBAL
  // -------------------------------------------------------------------------
  describe('Data item IS EXTERNAL / IS GLOBAL', () => {
    it('IS EXTERNAL does not pollute usage string', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01 WS-SHARED PIC X(10) USAGE DISPLAY IS EXTERNAL.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const item = r.dataItems.find((d) => d.name === 'WS-SHARED');
      expect(item?.isExternal).toBe(true);
      // usage should NOT contain 'external' as a string suffix
      expect(item?.usage).toBe('DISPLAY');
    });
  });

  // -------------------------------------------------------------------------
  // Accumulator flush on division transitions
  // -------------------------------------------------------------------------
  describe('Accumulator flush on division transitions', () => {
    it('callAccum flushed when EXEC SQL interrupts multi-line CALL', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'SUBPROG'",
        '               USING WS-PARM',
        '           EXEC SQL',
        '               SELECT * FROM CUSTOMER',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // CALL should be extracted with USING parameters (flushed before EXEC SQL)
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('SUBPROG');
      expect(r.calls[0].parameters).toEqual(['WS-PARM']);
      // EXEC SQL should also be extracted
      expect(r.execSqlBlocks).toHaveLength(1);
      expect(r.execSqlBlocks[0].tables).toContain('CUSTOMER');
    });

    it('callAccum flushed when EXEC CICS interrupts multi-line CALL', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'SUBPROG'",
        '               USING WS-DATA',
        '           EXEC CICS',
        "               LINK PROGRAM('AUDITLOG')",
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-DATA']);
      expect(r.execCicsBlocks).toHaveLength(1);
    });

    it('callAccum flushed when EXEC DLI interrupts multi-line CALL', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'SUBPROG'",
        '               USING WS-KEY',
        '           EXEC DLI GU',
        '               USING PCB(1)',
        '               SEGMENT(CUSTOMER)',
        '           END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-KEY']);
      expect(r.execDliBlocks).toHaveLength(1);
      expect(r.execDliBlocks[0].verb).toBe('GU');
    });

    it('all accumulators flushed on division transition', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER-PGM.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'SUBPROG'",
        '               USING WS-DATA',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER-PGM.',
        '      PROCEDURE DIVISION.',
        '       INNER-MAIN.',
        '           STOP RUN.',
        '       END PROGRAM INNER-PGM.',
        '       END PROGRAM OUTER-PGM.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // CALL should be flushed before the new IDENTIFICATION DIVISION
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('SUBPROG');
      // Both programs should be detected
      expect(r.programs.map((p) => p.name).sort()).toEqual(['INNER-PGM', 'OUTER-PGM']);
    });
  });

  // -------------------------------------------------------------------------
  // Free-format COBOL handling
  // -------------------------------------------------------------------------
  describe('Free-format COBOL handling', () => {
    it('free-format source detected via >>SOURCE FREE', () => {
      const src = [
        '>>SOURCE FORMAT IS FREE',
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. FREEPROG.',
        'PROCEDURE DIVISION.',
        'MAIN-PARA.',
        '    PERFORM PROCESS-DATA.',
        'PROCESS-DATA.',
        '    STOP RUN.',
      ].join('\n');
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('FREEPROG');
      expect(r.paragraphs).toHaveLength(2);
      expect(r.performs).toHaveLength(1);
    });

    it('free-format *> comments stripped but not inside quotes', () => {
      const src = [
        '>>SOURCE FREE',
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. TESTPROG.',
        'DATA DIVISION.',
        'WORKING-STORAGE SECTION.',
        '01 WS-DATA PIC X(10). *> this is a comment',
      ].join('\n');
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.dataItems.find((d) => d.name === 'WS-DATA')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // CANCEL extraction in CALL ON EXCEPTION block
  // -------------------------------------------------------------------------
  describe('CANCEL extraction in CALL ON EXCEPTION block', () => {
    it('CANCEL inside CALL END-CALL block is extracted', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'MAINPROG'",
        '               USING WS-DATA',
        '               ON EXCEPTION',
        "                   CANCEL 'MAINPROG'",
        "                   CALL 'BACKUP-PGM'",
        '           END-CALL.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // Both CALLs should be captured
      expect(r.calls).toHaveLength(2);
      expect(r.calls.map((c) => c.target).sort()).toEqual(['BACKUP-PGM', 'MAINPROG']);
      // CANCEL should be captured from within the CALL block
      expect(r.cancels).toHaveLength(1);
      expect(r.cancels[0].target).toBe('MAINPROG');
    });
  });

  // -------------------------------------------------------------------------
  // SORT INPUT PROCEDURE THRU range
  // -------------------------------------------------------------------------
  describe('SORT INPUT PROCEDURE THRU range', () => {
    it('captures both start and thru target', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SORT SORT-FILE ON ASCENDING KEY SORT-KEY',
        '               INPUT PROCEDURE IS BUILD-INPUT THRU BUILD-END',
        '               OUTPUT PROCEDURE IS WRITE-OUTPUT.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      // INPUT PROCEDURE should produce a perform with thruTarget
      const inputProc = r.performs.find((p) => p.target === 'BUILD-INPUT');
      expect(inputProc).toBeDefined();
      expect(inputProc!.thruTarget).toBe('BUILD-END');
      // OUTPUT PROCEDURE should be captured too
      expect(r.performs.find((p) => p.target === 'WRITE-OUTPUT')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Shared verb constant coverage
  // -------------------------------------------------------------------------
  describe('Shared verb constant coverage', () => {
    it('COBOL_STATEMENT_VERBS flush trigger works for all major verbs', () => {
      // Test that each verb in the shared constant terminates callAccum
      const verbs = [
        'PERFORM NEXT-PARA.',
        'MOVE WS-A TO WS-B.',
        'DISPLAY "HELLO".',
        'GO TO EXIT-PARA.',
        'INSPECT WS-X REPLACING ALL SPACES BY ZEROS.',
        'SET WS-FLAG TO TRUE.',
        'INITIALIZE WS-REC.',
        'CANCEL WS-OLD.',
      ];
      for (const verb of verbs) {
        const src = cobol(
          '      IDENTIFICATION DIVISION.',
          '       PROGRAM-ID. TESTPROG.',
          '      PROCEDURE DIVISION.',
          '       MAIN-PARA.',
          "           CALL 'PGM'",
          '               USING WS-PARM',
          `           ${verb}`,
        );
        const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
        expect(r.calls.length).toBe(1);
        expect(r.calls[0].parameters).toEqual(['WS-PARM']);
      }
    });
  });

  // -------------------------------------------------------------------------
  // EXEC SQL INCLUDE edge cases
  // -------------------------------------------------------------------------
  describe('EXEC SQL INCLUDE edge cases', () => {
    it('multiple EXEC SQL INCLUDEs extracted', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '           EXEC SQL INCLUDE SQLCA END-EXEC.',
        '           EXEC SQL INCLUDE SQLDA END-EXEC.',
        '           EXEC SQL INCLUDE CUSTDCL END-EXEC.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      const includes = r.execSqlBlocks.filter((b) => b.includeMember);
      expect(includes).toHaveLength(3);
      expect(includes.map((i) => i.includeMember).sort()).toEqual(['CUSTDCL', 'SQLCA', 'SQLDA']);
    });
  });

  // -------------------------------------------------------------------------
  // Complete COBOL program integration
  // -------------------------------------------------------------------------
  describe('Complete COBOL program integration', () => {
    it('extracts all construct types from a realistic program', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. FULLTEST.',
        '       AUTHOR. TEST AUTHOR.',
        '      ENVIRONMENT DIVISION.',
        '      INPUT-OUTPUT SECTION.',
        '      FILE-CONTROL.',
        "          SELECT CUST-FILE ASSIGN TO 'CUSTFILE'",
        '              ORGANIZATION IS INDEXED',
        '              ACCESS IS DYNAMIC',
        '              RECORD KEY IS CUST-ID.',
        '      DATA DIVISION.',
        '      WORKING-STORAGE SECTION.',
        '       01 WS-COUNT PIC 9(4) VALUE 0.',
        '       01 WS-TABLE OCCURS 10 DEPENDING ON WS-COUNT.',
        '       01 WS-FLAG PIC 9 VALUE 0.',
        '           88 END-OF-FILE VALUE 1.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           PERFORM PROCESS-DATA',
        '           SET END-OF-FILE TO TRUE',
        "           CALL 'SUBPROG' USING WS-COUNT.",
        '       PROCESS-DATA.',
        "           INSPECT WS-FLAG REPLACING ALL '0' BY '1'.",
        '           INITIALIZE WS-TABLE.',
        '           STOP RUN.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.programName).toBe('FULLTEST');
      expect(r.programMetadata.author).toBe('TEST AUTHOR');
      expect(r.fileDeclarations).toHaveLength(1);
      expect(r.fileDeclarations[0].organization).toBe('INDEXED');
      expect(r.dataItems.find((d) => d.name === 'WS-COUNT')?.values).toEqual(['0']);
      expect(r.dataItems.find((d) => d.name === 'WS-TABLE')?.dependingOn).toBe('WS-COUNT');
      expect(r.paragraphs).toHaveLength(2);
      expect(r.performs).toHaveLength(1);
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0].form).toBe('to-true');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-COUNT']);
      expect(r.inspects).toHaveLength(1);
      expect(r.inspects[0].form).toBe('replacing');
      expect(r.initializes).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Accumulator flush at END PROGRAM boundary
  // -------------------------------------------------------------------------
  describe('Accumulator flush at END PROGRAM boundary', () => {
    it('multi-line CALL flushed at END PROGRAM', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER.',
        '      PROCEDURE DIVISION.',
        '       OUTER-MAIN.',
        "           CALL 'SUBPROG'",
        '               USING WS-DATA',
        '       END PROGRAM OUTER.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('SUBPROG');
      expect(r.calls[0].parameters).toEqual(['WS-DATA']);
    });

    it('multi-line CALL flushed at END PROGRAM in nested programs', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER.',
        '      PROCEDURE DIVISION.',
        '       OUTER-MAIN.',
        '           STOP RUN.',
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. INNER.',
        '      PROCEDURE DIVISION.',
        '       INNER-MAIN.',
        "           CALL 'INNERSUB'",
        '               USING WS-INNER-DATA',
        '       END PROGRAM INNER.',
        '       END PROGRAM OUTER.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('INNERSUB');
      expect(r.calls[0].parameters).toEqual(['WS-INNER-DATA']);
      expect(r.programs).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Accumulator flush at PROGRAM-ID sibling boundary
  // -------------------------------------------------------------------------
  describe('Accumulator flush at PROGRAM-ID sibling boundary', () => {
    it('multi-line CALL flushed when sibling PROGRAM-ID appears without ID DIVISION', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. OUTER.',
        '      PROCEDURE DIVISION.',
        '       OUTER-MAIN.',
        "           CALL 'OUTERSUB'",
        '               USING WS-OUTER',
        '       PROGRAM-ID. SIBLING.',
        '      PROCEDURE DIVISION.',
        '       SIB-MAIN.',
        '           STOP RUN.',
        '       END PROGRAM SIBLING.',
        '       END PROGRAM OUTER.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].target).toBe('OUTERSUB');
      expect(r.calls[0].parameters).toEqual(['WS-OUTER']);
      const names = r.programs.map((p) => p.name);
      expect(names).toContain('SIBLING');
    });
  });

  // -------------------------------------------------------------------------
  // Accumulator flush on arithmetic verb boundaries
  // -------------------------------------------------------------------------
  describe('Accumulator flush on arithmetic verb boundaries', () => {
    it('COMPUTE terminates multi-line CALL accumulation', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING WS-INPUT',
        '           COMPUTE WS-TOTAL = WS-A + WS-B.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-INPUT']);
    });

    it('ADD terminates multi-line CALL accumulation', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING WS-AMT',
        '           ADD WS-AMT TO WS-TOTAL.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-AMT']);
    });

    it('SUBTRACT terminates multi-line CALL accumulation', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING WS-VAL',
        '           SUBTRACT WS-DISCOUNT FROM WS-TOTAL.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-VAL']);
    });

    it('MULTIPLY terminates multi-line CALL accumulation', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING WS-QTY',
        '           MULTIPLY WS-PRICE BY WS-QTY.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-QTY']);
    });

    it('DIVIDE terminates multi-line CALL accumulation', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING WS-TOTAL',
        '           DIVIDE WS-TOTAL BY WS-COUNT GIVING WS-AVG.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-TOTAL']);
    });

    it('STRING terminates multi-line CALL accumulation', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING WS-NAME',
        '           STRING WS-FIRST DELIMITED BY SIZE INTO WS-FULL.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-NAME']);
    });

    it('UNSTRING terminates multi-line CALL accumulation', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM'",
        '               USING WS-LINE',
        "           UNSTRING WS-LINE DELIMITED BY ',' INTO WS-A WS-B.",
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].parameters).toEqual(['WS-LINE']);
    });
  });

  // -------------------------------------------------------------------------
  // Arithmetic verbs not captured as false USING parameters
  // -------------------------------------------------------------------------
  describe('Arithmetic verbs not captured as false USING parameters', () => {
    it('COMPUTE after CALL USING does not pollute parameters', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        "           CALL 'PGM' USING WS-INPUT.",
        '           COMPUTE WS-RESULT = WS-A * WS-B.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.calls).toHaveLength(1);
      // Only WS-INPUT should be a parameter, not WS-RESULT/WS-A/WS-B
      expect(r.calls[0].parameters).toEqual(['WS-INPUT']);
    });
  });

  // -------------------------------------------------------------------------
  // SORT accumulator flushed at program boundaries
  // -------------------------------------------------------------------------
  describe('SORT accumulator flushed at program boundaries', () => {
    it('multi-line SORT flushed at END PROGRAM', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           SORT SORT-FILE',
        '               USING INPUT-FILE',
        '       END PROGRAM TESTPROG.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.sorts).toHaveLength(1);
      expect(r.sorts[0].sortFile).toBe('SORT-FILE');
      expect(r.sorts[0].usingFiles).toEqual(['INPUT-FILE']);
    });
  });

  // -------------------------------------------------------------------------
  // INSPECT accumulator flushed at program boundaries
  // -------------------------------------------------------------------------
  describe('INSPECT accumulator flushed at program boundaries', () => {
    it('multi-line INSPECT flushed at END PROGRAM', () => {
      const src = cobol(
        '      IDENTIFICATION DIVISION.',
        '       PROGRAM-ID. TESTPROG.',
        '      PROCEDURE DIVISION.',
        '       MAIN-PARA.',
        '           INSPECT WS-DATA',
        "               REPLACING ALL 'X' BY 'Y'",
        '       END PROGRAM TESTPROG.',
      );
      const r = extractCobolSymbolsWithRegex(src, 'test.cbl');
      expect(r.inspects).toHaveLength(1);
      expect(r.inspects[0].inspectedField).toBe('WS-DATA');
      expect(r.inspects[0].form).toBe('replacing');
    });
  });
});
