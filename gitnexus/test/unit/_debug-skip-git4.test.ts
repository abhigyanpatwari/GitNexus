import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('debug4', () => {
  it('check what env the analyze child actually gets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-no-git-'));
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'export const x = 1;');
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_OPTIONS;

    // First: just run a simple node script with the same cwd
    try {
      const out = execSync('node -e "console.log(JSON.stringify({NODE_OPTIONS: process.env.NODE_OPTIONS, version: process.version}))"', {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 5000,
        env: cleanEnv,
      });
      console.log('Simple child env:', out.trim());
    } catch (e: any) {
      console.log('Simple child err stdout:', e.stdout);
      console.log('Simple child err stderr:', e.stderr);
    }

    // Then: the analyze command
    try {
      execSync(`node dist/cli/index.js analyze "${tmpDir}"`, {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 10000,
        env: cleanEnv,
      });
    } catch (err: any) {
      console.log('Analyze stdout:', JSON.stringify(err.stdout?.slice(0, 200)));
      console.log('Analyze stderr:', JSON.stringify(err.stderr?.slice(0, 200)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
