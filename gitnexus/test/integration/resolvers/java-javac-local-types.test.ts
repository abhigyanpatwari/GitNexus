import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from './helpers.js';

const javacAvailable = spawnSync('javac', ['-version'], { stdio: 'ignore' }).status === 0;

describe('Java local-type names emitted by javac', () => {
  it.runIf(javacAvailable)('matches the identities asserted by the resolver fixture', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'gitnexus-javac-local-types-'));
    const output = path.join(temp, 'classes');
    mkdirSync(output);

    try {
      const sourceDir = path.join(FIXTURES, 'java-local-class-naming', 'src');
      const sources = readdirSync(sourceDir)
        .filter((name) => name.endsWith('.java'))
        .map((name) => path.join(sourceDir, name));
      execFileSync('javac', ['-d', output, ...sources]);

      expect(readdirSync(output).sort()).toEqual([
        'Compact$1.class',
        'Compact$1Local.class',
        'Compact.class',
        'Outer$1.class',
        'Outer$1CtorHost$1Local.class',
        'Outer$1CtorHost.class',
        'Outer$1Cyclic.class',
        'Outer$1InstanceLocal.class',
        'Outer$1LambdaLocal.class',
        'Outer$1Local$1.class',
        'Outer$1Local.class',
        'Outer$1NestedHost$Member$1Local.class',
        'Outer$1NestedHost$Member.class',
        'Outer$1NestedHost.class',
        'Outer$1StaticLocal.class',
        'Outer$2.class',
        'Outer$2Local.class',
        'Outer$3$1Local.class',
        'Outer$3.class',
        'Outer$3Local.class',
        'Outer$4Local.class',
        'Outer$Cyclic.class',
        'Outer$MemberHost$1Local.class',
        'Outer$MemberHost.class',
        'Outer.class',
        'Types$1.class',
        'Types$1E.class',
        'Types$1I.class',
        'Types$1R.class',
        'Types.class',
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
