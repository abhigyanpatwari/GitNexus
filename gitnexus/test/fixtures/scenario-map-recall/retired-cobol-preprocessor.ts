// Static recall-audit input. Keep the original suite names and callback for issue #3785.
import { describe, it, expect } from 'vitest';
import { extractCobolSymbolsWithRegex } from '../../../src/core/ingestion/cobol/cobol-preprocessor.js';

function cobol(...lines: string[]): string {
  return lines.join('\n');
}

describe('extractCobolSymbolsWithRegex', () => {
  describe('Linkage & Data Flow', () => {
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
  });
});
