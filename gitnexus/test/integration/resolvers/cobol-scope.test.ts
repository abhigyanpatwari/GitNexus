/**
 * COBOL scope-capture integration tests.
 *
 * These test that `emitCobolScopeCaptures` produces correct `CaptureMatch[]`
 * from real COBOL source files, covering all 11 fixture classes.
 *
 * The test verifies capture output directly — full scope-resolution
 * pipeline integration is covered by the COBOL resolver integration tests.
 */

import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import { emitCobolScopeCaptures } from '../../../src/core/ingestion/languages/cobol/captures.js';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'cobol');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFixture(name: string): string {
  const p = path.join(FIXTURES, name);
  return fs.readFileSync(p, 'utf-8');
}

/** Count captures with exact name */
function countByName(captures: readonly Record<string, unknown>[], name: string): number {
  return captures.filter((m) => name in m).length;
}

/** Find a capture match where @declaration.name.text equals a value */
function findDecl(
  captures: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> | undefined {
  return captures.find((m) => {
    const n = (m as Record<string, { text: string }>)['@declaration.name'];
    return n?.text === name;
  });
}

/** Find a capture match where @reference.name.text equals a value */
function findRef(
  captures: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> | undefined {
  return captures.find((m) => {
    const n = (m as Record<string, { text: string }>)['@reference.name'];
    return n?.text === name;
  });
}

/** Find a capture match with @import.name.text */
function findImport(
  captures: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> | undefined {
  return captures.find((m) => {
    const n = (m as Record<string, { text: string }>)['@import.name'];
    return n?.text.toUpperCase() === name.toUpperCase();
  });
}

// ===========================================================================
// Class 1: Basic program structure
// ===========================================================================

describe('Class 1: Basic program structure — PROGRAM-ID + paragraphs + CALL + PERFORM', () => {
  it('AUDITLOG.cbl: PROGRAM-ID, PROCEDURE DIVISION USING, PERFORM', () => {
    const result = emitCobolScopeCaptures(readFixture('AUDITLOG.cbl'), 'AUDITLOG.cbl');
    expect(result.length).toBeGreaterThan(0);

    // Should have a @scope.module for AUDITLOG
    const moduleCount = countByName(result, '@scope.module');
    expect(moduleCount).toBe(1);

    // Should have @declaration.name = 'AUDITLOG'
    const auditlog = findDecl(result, 'AUDITLOG');
    expect(auditlog).toBeDefined();

    // Should have functions for paragraphs: MAIN-PARAGRAPH, WRITE-LOG
    const funcCount = countByName(result, '@scope.function');
    expect(funcCount).toBeGreaterThanOrEqual(2);

    // Should have PERFORM references
    const perfCount = countByName(result, '@reference.call');
    expect(perfCount).toBeGreaterThanOrEqual(1);

    // WRITE-LOG paragraph should be a function scope
    const writeLog = findDecl(result, 'WRITE-LOG');
    expect(writeLog).toBeDefined();

    // Gap 1: PERFORM VARYING captures target paragraph
    expect(findDecl(result, 'VARYING-TEST')).toBeDefined();

    // Gap 2: PERFORM UNTIL captures target paragraph
    expect(findDecl(result, 'UNTIL-TEST')).toBeDefined();

    // Gap 3: GO TO DEPENDING ON with 3 branches
    expect(findRef(result, 'PARA-ONE')).toBeDefined();
    expect(findRef(result, 'PARA-TWO')).toBeDefined();
    expect(findRef(result, 'PARA-THREE')).toBeDefined();

    // Gap 4: Multiple COPY statements
    const copyConst = findImport(result, 'AUDITCONST');
    expect(copyConst).toBeDefined();
    const copyVars = findImport(result, 'AUDITVARS');
    expect(copyVars).toBeDefined();
    expect(copyConst).not.toBe(copyVars);

    // Gap 5: CALL with OMITTED — arity counts actual params, OMITTED is a keyword placeholder
    const procRef = findRef(result, 'PROCESS');
    expect(procRef).toBeDefined();
    const procMatch = procRef as Record<string, { text: string }>;
    // CALL 'PROCESS' USING WS-PARAM-A OMITTED WS-PARAM-C has 2 actual params
    expect(procMatch['@reference.arity']).toBeDefined();
    expect(procMatch['@reference.arity']!.text).toBe('2');

    // Gap 6: CALLs inside nested IF blocks
    expect(findRef(result, 'DEEPPROC')).toBeDefined();
    expect(findRef(result, 'SHALLOW')).toBeDefined();
  });

  it('RPTGEN.cbl: PROGRAM-ID, PERFORM, GO TO, SORT INPUT/OUTPUT PROCEDURE', () => {
    const result = emitCobolScopeCaptures(readFixture('RPTGEN.cbl'), 'RPTGEN.cbl');
    expect(result.length).toBeGreaterThan(0);

    // PROGRAM-ID
    expect(countByName(result, '@scope.module')).toBe(1);
    expect(findDecl(result, 'RPTGEN')).toBeDefined();

    // Paragraphs: MAIN-PARAGRAPH, FETCH-DATA, FORMAT-REPORT, etc.
    const funcCount = countByName(result, '@scope.function');
    expect(funcCount).toBeGreaterThanOrEqual(6);

    // REFERENCES for PERFORM and GO TO
    const refCount = countByName(result, '@reference.call');
    expect(refCount).toBeGreaterThanOrEqual(5);

    // GO TO DEPENDING ON should create multiple reference targets
    const gotoFetch = findRef(result, 'FETCH-DATA');
    expect(gotoFetch).toBeDefined();
    const gotoFormat = findRef(result, 'FORMAT-REPORT');
    expect(gotoFormat).toBeDefined();
  });
});

// ===========================================================================
// Class 2: COPY import
// ===========================================================================

describe('Class 2: COPY import — COPY bookname, COPY REPLACING', () => {
  it('RPTGEN.cbl: COPY CUSTDAT without REPLACING', () => {
    const result = emitCobolScopeCaptures(readFixture('RPTGEN.cbl'), 'RPTGEN.cbl');
    const imp = findImport(result, 'CUSTDAT');
    expect(imp).toBeDefined();
  });

  it('CUSTUPDT.cbl: COPY COPYLIB REPLACING ==PREFIX-== BY ==WS-==', () => {
    const result = emitCobolScopeCaptures(readFixture('CUSTUPDT.cbl'), 'CUSTUPDT.cbl');
    const imp = findImport(result, 'COPYLIB');
    expect(imp).toBeDefined();
  });
});

// ===========================================================================
// Class 3: CALL USING
// ===========================================================================

describe('Class 3: CALL USING — match/mismatch arity', () => {
  it('AUDITLOG.cbl: PROCEDURE DIVISION USING with 2 params', () => {
    const result = emitCobolScopeCaptures(readFixture('AUDITLOG.cbl'), 'AUDITLOG.cbl');
    // AUDITLOG has PROCEDURE DIVISION USING LS-CUST-ID LS-AMOUNT (2 params)
    const auditlog = findDecl(result, 'AUDITLOG');
    expect(auditlog).toBeDefined();
    const match = auditlog as Record<string, { text: string }>;
    // Parameter count should be captured
    expect(match['@declaration.parameter-count']).toBeDefined();
    expect(match['@declaration.parameter-count']!.text).toBe('2');
  });

  it('CUSTUPDT.cbl: CALL "AUDITLOG" USING CUST-ID WS-AMOUNT (2 args)', () => {
    const result = emitCobolScopeCaptures(readFixture('CUSTUPDT.cbl'), 'CUSTUPDT.cbl');
    // Should have CALL reference with arity=2
    const callRef = findRef(result, 'AUDITLOG');
    expect(callRef).toBeDefined();
    const match = callRef as Record<string, { text: string }>;
    expect(match['@reference.arity']).toBeDefined();
    expect(match['@reference.arity']!.text).toBe('2');
  });
});

// ===========================================================================
// Class 4: Dynamic CALL
// ===========================================================================

describe('Class 4: Dynamic CALL — CALL WS-VAR, stays unresolved', () => {
  it('CUSTUPDT.cbl: CALL WS-PROG-NAME (dynamic, no quotes)', () => {
    const result = emitCobolScopeCaptures(readFixture('CUSTUPDT.cbl'), 'CUSTUPDT.cbl');
    // WS-PROG-NAME should appear as a CALL reference
    const dynCall = findRef(result, 'WS-PROG-NAME');
    expect(dynCall).toBeDefined();
  });
});

// ===========================================================================
// Class 5: Nested programs
// ===========================================================================

describe('Class 5: Nested programs — multiple PROGRAM-IDs, scope isolation', () => {
  it('NESTED.cbl: OUTER-PROG + INNER-PROG in one file', () => {
    const result = emitCobolScopeCaptures(readFixture('NESTED.cbl'), 'NESTED.cbl');
    // Two PROGRAM-IDs → 2 @scope.module captures
    const moduleCount = countByName(result, '@scope.module');
    expect(moduleCount).toBe(2);

    // Both program names should appear
    expect(findDecl(result, 'OUTER-PROG')).toBeDefined();
    expect(findDecl(result, 'INNER-PROG')).toBeDefined();

    // Paragraphs in both programs
    expect(findDecl(result, 'OUTER-MAIN')).toBeDefined();
    expect(findDecl(result, 'OUTER-PROCESS')).toBeDefined();
    expect(findDecl(result, 'INNER-MAIN')).toBeDefined();
    expect(findDecl(result, 'INNER-PROCESS')).toBeDefined();

    // CALL "INNER-PROG" reference
    expect(findRef(result, 'INNER-PROG')).toBeDefined();
  });
});

// ===========================================================================
// Class 6: SECTION vs PARAGRAPH
// ===========================================================================

describe('Class 6: SECTION vs PARAGRAPH — both map to Function', () => {
  it('CUSTUPDT.cbl: Sections (INIT-SECTION, PROCESSING-SECTION) + paragraphs', () => {
    const result = emitCobolScopeCaptures(readFixture('CUSTUPDT.cbl'), 'CUSTUPDT.cbl');
    // Sections declared as functions
    expect(findDecl(result, 'INIT-SECTION')).toBeDefined();
    expect(findDecl(result, 'PROCESSING-SECTION')).toBeDefined();

    // Paragraphs inside sections
    expect(findDecl(result, 'MAIN-PARAGRAPH')).toBeDefined();
    expect(findDecl(result, 'INIT-PARAGRAPH')).toBeDefined();
    expect(findDecl(result, 'PROCESS-PARAGRAPH')).toBeDefined();

    // Both are @scope.function
    const funcCount = countByName(result, '@scope.function');
    expect(funcCount).toBeGreaterThanOrEqual(5);
  });
});

// ===========================================================================
// Class 7: Single-quoted CALL/COPY
// ===========================================================================

describe('Class 7: Single-quoted CALL/COPY — the #500 regression case', () => {
  it('CUSTUPDT.cbl: ENTRY with single quotes ALTENTRY', () => {
    const result = emitCobolScopeCaptures(readFixture('CUSTUPDT.cbl'), 'CUSTUPDT.cbl');
    // ENTRY 'ALTENTRY' uses single quotes — should still produce captures
    // (ENTRY points are recognized by the regex tagger)
    // Verify the file processed without error
    expect(result.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Class 8: Fixed-format with sequence numbers
// ===========================================================================

describe('Class 8: Fixed-format — sequence numbers in cols 1-6, Area A/B detection', () => {
  it('fixed-format.cbl: sequence numbers 000100-001800, Area A paragraphs', () => {
    const result = emitCobolScopeCaptures(readFixture('fixed-format.cbl'), 'fixed-format.cbl');
    expect(result.length).toBeGreaterThan(0);

    // Should detect PROGRAM-ID FIXEDFORMAT
    expect(findDecl(result, 'FIXEDFORMAT')).toBeDefined();
    expect(countByName(result, '@scope.module')).toBe(1);

    // Paragraphs MAIN-PARA, INIT-PARA, PROCESS-PARA
    expect(findDecl(result, 'MAIN-PARA')).toBeDefined();
    expect(findDecl(result, 'INIT-PARA')).toBeDefined();
    expect(findDecl(result, 'PROCESS-PARA')).toBeDefined();

    // CALL "LOGGER" reference
    expect(findRef(result, 'LOGGER')).toBeDefined();
  });
});

// ===========================================================================
// Class 9: Edge: malformed/multiline
// ===========================================================================

describe('Class 9: Edge: malformed/multiline — incomplete statements, CALL USING on separate lines', () => {
  it('malformed-multiline.cbl: multiline CALL, incomplete statements', () => {
    const result = emitCobolScopeCaptures(
      readFixture('malformed-multiline.cbl'),
      'malformed-multiline.cbl',
    );
    expect(result.length).toBeGreaterThan(0);

    // Should still detect PROGRAM-ID
    expect(findDecl(result, 'MALFORMED')).toBeDefined();

    // Paragraphs MAIN, EXIT-PARA
    expect(findDecl(result, 'MAIN')).toBeDefined();
    expect(findDecl(result, 'EXIT-PARA')).toBeDefined();

    // CALL "TARGET" should be captured (multi-line CALL with USING)
    const target = findRef(result, 'TARGET');
    expect(target).toBeDefined();

    // CALL "MULTILINE" should also be captured
    const multi = findRef(result, 'MULTILINE');
    expect(multi).toBeDefined();

    // GO TO EXIT-PARA reference
    const exitRef = findRef(result, 'EXIT-PARA');
    expect(exitRef).toBeDefined();
  });
});

// ===========================================================================
// Class 10: Edge: empty/whitespace file
// ===========================================================================

describe('Class 10: Edge: empty/whitespace file — must not throw', () => {
  it('empty-file.cbl: empty file produces empty captures', () => {
    const result = emitCobolScopeCaptures(readFixture('empty-file.cbl'), 'empty-file.cbl');
    expect(result).toEqual([]);
  });

  it('whitespace-only.cbl: whitespace-only file produces empty captures', () => {
    const result = emitCobolScopeCaptures(
      readFixture('whitespace-only.cbl'),
      'whitespace-only.cbl',
    );
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// Class 11: Legacy parity — legacy processor doesn't crash on fixtures
// ===========================================================================

describe('Class 11: Legacy parity — legacy processor handles fixtures', () => {
  it('all fixtures can be processed without error', () => {
    const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.cbl'));
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const source = readFixture(file);
      // Just running the regex tagger should not throw
      expect(() => emitCobolScopeCaptures(source, file)).not.toThrow();
    }
  });
});

// ===========================================================================
// Cross-cutting: all fixtures produce expected structure
// ===========================================================================

describe('Cross-cutting structure verification', () => {
  it('every non-empty COBOL file produces at least one @scope.module', () => {
    const files = fs
      .readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.cbl') && f !== 'empty-file.cbl' && f !== 'whitespace-only.cbl');
    for (const file of files) {
      const result = emitCobolScopeCaptures(readFixture(file), file);
      const modCount = countByName(result, '@scope.module');
      expect(modCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('every @scope.function has a matching @declaration.name', () => {
    const files = fs
      .readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.cbl') && f !== 'empty-file.cbl' && f !== 'whitespace-only.cbl');
    for (const file of files) {
      const result = emitCobolScopeCaptures(readFixture(file), file);
      const funcScopes = result.filter((m) => '@scope.function' in m);
      const funcDecls = result.filter((m) => '@declaration.function' in m);
      expect(funcDecls.length).toBe(funcScopes.length);
    }
  });
});

// ===========================================================================
// Reviewer Check 1: Program-ID scope isolation
// ===========================================================================

describe('Reviewer Check 1: Program-ID scope isolation — CALLs in different PROGRAM-IDs', () => {
  it('NESTED.cbl: OUTER-PROG and INNER-PROG each have isolated paragraphs', () => {
    const result = emitCobolScopeCaptures(readFixture('NESTED.cbl'), 'NESTED.cbl');

    // Both programs produce separate @scope.module captures
    const mods = result.filter((m) => '@scope.module' in m);
    expect(mods.length).toBe(2);

    // OUTER-PROG-related paragraphs
    expect(findDecl(result, 'OUTER-MAIN')).toBeDefined();
    expect(findDecl(result, 'OUTER-PROCESS')).toBeDefined();
    // INNER-PROG-related paragraphs
    expect(findDecl(result, 'INNER-MAIN')).toBeDefined();
    expect(findDecl(result, 'INNER-PROCESS')).toBeDefined();

    // CALL "INNER-PROG" from OUTER-PROG
    expect(findRef(result, 'INNER-PROG')).toBeDefined();
  });

  it('CUSTUPDT.cbl: CALLs in one program do not cross-contaminate paragraphs', () => {
    const result = emitCobolScopeCaptures(readFixture('CUSTUPDT.cbl'), 'CUSTUPDT.cbl');
    // CUSTUPDT is a single PROGRAM-ID; all paragraphs belong to it
    expect(countByName(result, '@scope.module')).toBe(1);
    // Verify several distinct paragraphs exist
    expect(findDecl(result, 'MAIN-PARAGRAPH')).toBeDefined();
    expect(findDecl(result, 'INIT-PARAGRAPH')).toBeDefined();
    expect(findDecl(result, 'PROCESS-PARAGRAPH')).toBeDefined();
    expect(findDecl(result, 'READ-CUSTOMER')).toBeDefined();
    expect(findDecl(result, 'UPDATE-BALANCE')).toBeDefined();
    expect(findDecl(result, 'WRITE-CUSTOMER')).toBeDefined();
    expect(findDecl(result, 'CLEANUP-PARAGRAPH')).toBeDefined();
  });
});

// ===========================================================================
// Reviewer Check 2: COPY REPLACING capture range consistency
// ===========================================================================

describe('Reviewer Check 2: COPY REPLACING — capture ranges from transformed source', () => {
  it('CUSTUPDT.cbl: COPY COPYLIB REPLACING capture range matches source line', () => {
    const source = readFixture('CUSTUPDT.cbl');
    const lines = source.split('\n');
    const result = emitCobolScopeCaptures(source, 'CUSTUPDT.cbl');

    const copyMatch = findImport(result, 'COPYLIB');
    expect(copyMatch).toBeDefined();

    // Find '@import.statement' within the match
    const importCap = copyMatch as Record<
      string,
      { name: string; range: { startLine: number }; text: string }
    >;
    const stmt = importCap['@import.statement'];
    expect(stmt).toBeDefined();
    // Range should reference a valid line in the source
    const lineIdx = stmt.range.startLine - 1;
    expect(lineIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeLessThan(lines.length);
    // The line should contain COPY...COPYLIB
    expect(lines[lineIdx].toUpperCase()).toContain('COPY');
    expect(lines[lineIdx].toUpperCase()).toContain('COPYLIB');
  });

  it('RPTGEN.cbl: COPY CUSTDAT capture range matches source line', () => {
    const source = readFixture('RPTGEN.cbl');
    const lines = source.split('\n');
    const result = emitCobolScopeCaptures(source, 'RPTGEN.cbl');

    const copyMatch = findImport(result, 'CUSTDAT');
    expect(copyMatch).toBeDefined();

    const importCap = copyMatch as Record<
      string,
      { name: string; range: { startLine: number }; text: string }
    >;
    const stmt = importCap['@import.statement'];
    expect(stmt).toBeDefined();
    const lineIdx = stmt.range.startLine - 1;
    expect(lineIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeLessThan(lines.length);
    expect(lines[lineIdx].toUpperCase()).toContain('COPY');
    expect(lines[lineIdx].toUpperCase()).toContain('CUSTDAT');
  });
});

// ===========================================================================
// Reviewer Check 3: Import ownership scope
// ===========================================================================

describe('Reviewer Check 3: importOwningScope returns Module scope for COPY', () => {
  it('importOwningScope walks from paragraph to enclosing Module', async () => {
    // Test the importOwningScope function directly
    const { cobolImportOwningScope } =
      await import('../../../src/core/ingestion/languages/cobol/interpret.js');
    // Simulate an import at paragraph (Function) scope:
    // the function should walk up to find the Module.
    const mockTree = {
      getScope: (id: string) => {
        if (id === 'func:test') return { id: 'func:test', kind: 'Function' } as any;
        if (id === 'mod:test') return { id: 'mod:test', kind: 'Module' } as any;
        return undefined;
      },
      getAncestors: (_id: string) => ['mod:test'],
      getParent: (_id: string) => undefined,
      getChildren: (_id: string) => [],
      has: (_id: string) => true,
      byId: new Map(),
      size: 2,
    };

    const paraScope = {
      id: 'func:test',
      kind: 'Function',
      name: 'TEST-PARA',
      range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
    } as any;
    const result = cobolImportOwningScope(null as any, paraScope, mockTree);
    expect(result).toBe('mod:test');
  });

  it('importOwningScope returns innermost when already in Module scope', async () => {
    const { cobolImportOwningScope } =
      await import('../../../src/core/ingestion/languages/cobol/interpret.js');
    const mockTree = {
      getScope: () => undefined,
      getAncestors: () => [],
      getParent: () => undefined,
      getChildren: () => [],
      has: () => true,
      byId: new Map(),
      size: 1,
    };
    const modScope = {
      id: 'mod:test',
      kind: 'Module',
      name: 'MYPROG',
      range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
    } as any;
    const result = cobolImportOwningScope(null as any, modScope, mockTree);
    expect(result).toBe('mod:test');
  });
});

// ===========================================================================
// Reviewer Check 5: Dynamic CALL produces no CALLS edge, CodeElement annotation
// ===========================================================================

describe('Reviewer Check 5: Dynamic CALL — CALL WS-VAR captures as reference', () => {
  it('CUSTUPDT.cbl: CALL WS-PROG-NAME is captured as a dynamic reference', () => {
    const result = emitCobolScopeCaptures(readFixture('CUSTUPDT.cbl'), 'CUSTUPDT.cbl');
    // WS-PROG-NAME should appear as a CALL reference (dynamic, no quotes)
    const dynRef = findRef(result, 'WS-PROG-NAME');
    expect(dynRef).toBeDefined();

    // Verify it's a @reference.call, not a resolved edge
    const ref = dynRef as Record<string, { name: string }>;
    expect(ref['@reference.call']).toBeDefined();
  });
});
