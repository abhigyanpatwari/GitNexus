import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('debug2', () => {
  it('check with delete NODE_OPTIONS', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-no-git-'));
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'export const x = 1;');
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_OPTIONS;

    try {
      execSync(`node dist/cli/index.js analyze "${tmpDir}"`, {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 10000,
        env: cleanEnv,
      });
      expect.unreachable();
    } catch (err: any) {
      console.log('stdout:', JSON.stringify(err.stdout));
      console.log('stderr:', JSON.stringify(err.stderr));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
