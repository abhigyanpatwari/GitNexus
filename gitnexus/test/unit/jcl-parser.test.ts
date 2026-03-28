import { describe, it, expect } from 'vitest';
import { parseJcl } from '../../src/core/ingestion/cobol/jcl-parser.js';
import type { JclParseResults } from '../../src/core/ingestion/cobol/jcl-parser.js';

describe('parseJcl', () => {
  // ── JOB statements ──────────────────────────────────────────────────

  describe('JOB statements', () => {
    it('extracts job name', () => {
      const jcl = `//MYJOB   JOB (ACCT),'MY JOB'`;
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0].name).toBe('MYJOB');
      expect(r.jobs[0].line).toBe(1);
    });

    it('extracts CLASS and MSGCLASS parameters', () => {
      const jcl = `//PAYJOB   JOB (ACCT),'PAYROLL',CLASS=A,MSGCLASS=X`;
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0].name).toBe('PAYJOB');
      expect(r.jobs[0].class).toBe('A');
      expect(r.jobs[0].msgclass).toBe('X');
    });

    it('handles job with no CLASS or MSGCLASS', () => {
      const jcl = `//BAREJOB  JOB (ACCT),'BARE'`;
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0].name).toBe('BAREJOB');
      expect(r.jobs[0].class).toBeUndefined();
      expect(r.jobs[0].msgclass).toBeUndefined();
    });
  });

  // ── EXEC statements ─────────────────────────────────────────────────

  describe('EXEC statements', () => {
    it('extracts step with PGM=program', () => {
      const jcl = ['//MYJOB   JOB (ACCT)', '//STEP1   EXEC PGM=IEFBR14'].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.steps).toHaveLength(1);
      expect(r.steps[0].name).toBe('STEP1');
      expect(r.steps[0].program).toBe('IEFBR14');
      expect(r.steps[0].proc).toBeUndefined();
    });

    it('extracts step with proc name (no PGM= keyword)', () => {
      const jcl = ['//MYJOB   JOB (ACCT)', '//STEP1   EXEC MYPROC'].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.steps).toHaveLength(1);
      expect(r.steps[0].name).toBe('STEP1');
      expect(r.steps[0].program).toBeUndefined();
      expect(r.steps[0].proc).toBe('MYPROC');
    });

    it('associates step with current job', () => {
      const jcl = [
        '//JOB1    JOB (ACCT)',
        '//STEPA   EXEC PGM=PROG1',
        '//JOB2    JOB (ACCT)',
        '//STEPB   EXEC PGM=PROG2',
      ].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.steps).toHaveLength(2);
      expect(r.steps[0].jobName).toBe('JOB1');
      expect(r.steps[1].jobName).toBe('JOB2');
    });
  });

  // ── DD statements ───────────────────────────────────────────────────

  describe('DD statements', () => {
    it('extracts DD name and dataset (DSN=)', () => {
      const jcl = [
        '//MYJOB   JOB (ACCT)',
        '//STEP1   EXEC PGM=IEFBR14',
        '//INPUT   DD DSN=MY.DATA.SET,DISP=SHR',
      ].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.ddStatements).toHaveLength(1);
      expect(r.ddStatements[0].ddName).toBe('INPUT');
      expect(r.ddStatements[0].dataset).toBe('MY.DATA.SET');
    });

    it('extracts DISP parameter', () => {
      const jcl = [
        '//MYJOB   JOB (ACCT)',
        '//STEP1   EXEC PGM=IEFBR14',
        '//OUTPUT  DD DSN=MY.OUT,DISP=(NEW,CATLG,DELETE)',
      ].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.ddStatements).toHaveLength(1);
      expect(r.ddStatements[0].disp).toBe('NEW');
    });

    it('associates DD with current step', () => {
      const jcl = [
        '//MYJOB   JOB (ACCT)',
        '//STEP1   EXEC PGM=PROG1',
        '//DD1     DD DSN=DS1,DISP=SHR',
        '//STEP2   EXEC PGM=PROG2',
        '//DD2     DD DSN=DS2,DISP=SHR',
      ].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.ddStatements).toHaveLength(2);
      expect(r.ddStatements[0].stepName).toBe('STEP1');
      expect(r.ddStatements[1].stepName).toBe('STEP2');
    });
  });

  // ── PROC definitions ────────────────────────────────────────────────

  describe('PROC definitions', () => {
    it('extracts in-stream PROC with name', () => {
      const jcl = ['//MYPROC  PROC', '//STEP1   EXEC PGM=IEFBR14', '// PEND'].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.procs).toHaveLength(1);
      expect(r.procs[0].name).toBe('MYPROC');
      expect(r.procs[0].isInStream).toBe(true);
    });

    it('handles PROC/PEND pairs', () => {
      const jcl = [
        '//PROC1   PROC',
        '//S1      EXEC PGM=PROG1',
        '// PEND',
        '//PROC2   PROC',
        '//S2      EXEC PGM=PROG2',
        '// PEND',
      ].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.procs).toHaveLength(2);
      expect(r.procs[0].name).toBe('PROC1');
      expect(r.procs[1].name).toBe('PROC2');
    });
  });

  // ── INCLUDE / SET ───────────────────────────────────────────────────

  describe('INCLUDE and SET', () => {
    it('extracts INCLUDE MEMBER=name', () => {
      const jcl = `// INCLUDE MEMBER=MYINCL`;
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.includes).toHaveLength(1);
      expect(r.includes[0].member).toBe('MYINCL');
      expect(r.includes[0].line).toBe(1);
    });

    it('extracts SET variable=value', () => {
      const jcl = `// SET ENV=PROD`;
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0].variable).toBe('ENV');
      expect(r.sets[0].value).toBe('PROD');
    });
  });

  // ── Conditionals ────────────────────────────────────────────────────

  describe('Conditionals', () => {
    it('extracts IF condition THEN', () => {
      const jcl = `// IF STEP1.RC = 0 THEN`;
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.conditionals).toHaveLength(1);
      expect(r.conditionals[0].type).toBe('IF');
      expect(r.conditionals[0].condition).toBe('STEP1.RC = 0');
    });

    it('extracts ELSE and ENDIF', () => {
      const jcl = [
        '// IF STEP1.RC = 0 THEN',
        '//GOOD    EXEC PGM=GOODPGM',
        '// ELSE',
        '//BAD     EXEC PGM=BADPGM',
        '// ENDIF',
      ].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.conditionals).toHaveLength(3);
      expect(r.conditionals[0].type).toBe('IF');
      expect(r.conditionals[1].type).toBe('ELSE');
      expect(r.conditionals[1].condition).toBeUndefined();
      expect(r.conditionals[2].type).toBe('ENDIF');
      expect(r.conditionals[2].condition).toBeUndefined();
    });
  });

  // ── JCLLIB ──────────────────────────────────────────────────────────

  describe('JCLLIB', () => {
    it('extracts JCLLIB ORDER=(lib1,lib2)', () => {
      const jcl = `// JCLLIB ORDER=(SYS1.PROCLIB,USER.PROCLIB)`;
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.jcllib).toHaveLength(1);
      expect(r.jcllib[0].order).toEqual(['SYS1.PROCLIB', 'USER.PROCLIB']);
      expect(r.jcllib[0].line).toBe(1);
    });
  });

  // ── Continuation lines ──────────────────────────────────────────────

  describe('Continuation lines', () => {
    it('joins continuation lines (col 72 non-blank + next line starts with //)', () => {
      // Build a DD line that is exactly 72 chars with non-blank at col 72 (index 71).
      // The continuation line provides the DISP parameter.
      // "//DD1     DD DSN=MY.VERY.LONG.DATASET.NAME.THAT.KEEPS.GOING," is 60 chars.
      // Pad to 71 then add non-blank at col 72.
      const base = '//DD1     DD DSN=MY.VERY.LONG.DATASET.NAME.THAT.KEEPS.GOING,';
      const padding = ' '.repeat(71 - base.length);
      const line1 = base + padding + 'X'; // col 72 is 'X' (non-blank) -> continuation
      const line2 = '//             DISP=SHR';
      const jcl = ['//MYJOB   JOB (ACCT)', '//STEP1   EXEC PGM=IEFBR14', line1, line2].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      // The continuation should join the DD line so both DSN and DISP are parsed
      expect(r.ddStatements).toHaveLength(1);
      expect(r.ddStatements[0].ddName).toBe('DD1');
      expect(r.ddStatements[0].dataset).toBe('MY.VERY.LONG.DATASET.NAME.THAT.KEEPS.GOING');
      expect(r.ddStatements[0].disp).toBe('SHR');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('skips JCL comments (//*)', () => {
      const jcl = ['//* This is a comment', '//MYJOB   JOB (ACCT)', '//* Another comment'].join(
        '\n',
      );
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0].name).toBe('MYJOB');
    });

    it('skips non-JCL lines', () => {
      const jcl = [
        'This is not a JCL line',
        '//MYJOB   JOB (ACCT)',
        '  Some data',
        '//STEP1   EXEC PGM=IEFBR14',
      ].join('\n');
      const r = parseJcl(jcl, 'test.jcl');
      expect(r.jobs).toHaveLength(1);
      expect(r.steps).toHaveLength(1);
    });

    it('empty input returns empty results', () => {
      const r = parseJcl('', 'test.jcl');
      expect(r.jobs).toEqual([]);
      expect(r.steps).toEqual([]);
      expect(r.ddStatements).toEqual([]);
      expect(r.procs).toEqual([]);
      expect(r.includes).toEqual([]);
      expect(r.sets).toEqual([]);
      expect(r.jcllib).toEqual([]);
      expect(r.conditionals).toEqual([]);
    });

    it('complete JCL job with multiple steps and DDs', () => {
      const jcl = [
        '//* Complete payroll job',
        "//PAYJOB   JOB (ACCT123),'PAYROLL RUN',CLASS=A,MSGCLASS=X",
        '// JCLLIB ORDER=(PAY.PROCLIB,SYS1.PROCLIB)',
        '// SET ENV=PROD',
        '// INCLUDE MEMBER=STDPARMS',
        '//*',
        '// IF 1 = 1 THEN',
        '//STEP01   EXEC PGM=PAYEXT',
        '//INPUT    DD DSN=PAY.MASTER,DISP=SHR',
        '//OUTPUT   DD DSN=PAY.EXTRACT,DISP=(NEW,CATLG,DELETE)',
        '//SYSPRINT DD SYSOUT=*',
        '//*',
        '//STEP02   EXEC PAYCALC',
        '//INFILE   DD DSN=PAY.EXTRACT,DISP=SHR',
        '// ELSE',
        '//STEP03   EXEC PGM=IEFBR14',
        '// ENDIF',
      ].join('\n');
      const r = parseJcl(jcl, 'payroll.jcl');

      // Jobs
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0]).toEqual({
        name: 'PAYJOB',
        line: 2,
        class: 'A',
        msgclass: 'X',
      });

      // JCLLIB
      expect(r.jcllib).toHaveLength(1);
      expect(r.jcllib[0].order).toEqual(['PAY.PROCLIB', 'SYS1.PROCLIB']);

      // SET
      expect(r.sets).toHaveLength(1);
      expect(r.sets[0]).toEqual({ variable: 'ENV', value: 'PROD', line: 4 });

      // INCLUDE
      expect(r.includes).toHaveLength(1);
      expect(r.includes[0].member).toBe('STDPARMS');

      // Conditionals
      expect(r.conditionals).toHaveLength(3);
      expect(r.conditionals[0].type).toBe('IF');
      expect(r.conditionals[1].type).toBe('ELSE');
      expect(r.conditionals[2].type).toBe('ENDIF');

      // Steps
      expect(r.steps).toHaveLength(3);
      expect(r.steps[0]).toMatchObject({ name: 'STEP01', program: 'PAYEXT', jobName: 'PAYJOB' });
      expect(r.steps[1]).toMatchObject({ name: 'STEP02', proc: 'PAYCALC', jobName: 'PAYJOB' });
      expect(r.steps[2]).toMatchObject({ name: 'STEP03', program: 'IEFBR14', jobName: 'PAYJOB' });

      // DD statements
      expect(r.ddStatements).toHaveLength(4);
      expect(r.ddStatements[0]).toMatchObject({
        ddName: 'INPUT',
        stepName: 'STEP01',
        dataset: 'PAY.MASTER',
        disp: 'SHR',
      });
      expect(r.ddStatements[1]).toMatchObject({
        ddName: 'OUTPUT',
        stepName: 'STEP01',
        disp: 'NEW',
      });
      expect(r.ddStatements[2]).toMatchObject({ ddName: 'SYSPRINT', stepName: 'STEP01' });
      expect(r.ddStatements[3]).toMatchObject({
        ddName: 'INFILE',
        stepName: 'STEP02',
        dataset: 'PAY.EXTRACT',
      });
    });
  });
});
