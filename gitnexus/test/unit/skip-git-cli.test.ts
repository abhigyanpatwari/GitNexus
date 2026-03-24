import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('--skip-git CLI flag', () => {
  it('Commander maps --skip-git to options.skipGit (not --no-git inversion)', () => {
    // Verify the CLI defines --skip-git, not --no-git
    const helpOutput = execSync('node dist/cli/index.js analyze --help', {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(helpOutput).toContain('--skip-git');
    expect(helpOutput).not.toContain('--no-git');
  });

  it('rejects non-git folder without --skip-git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-no-git-'));
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'export const x = 1;');

    try {
      execSync(`node dist/cli/index.js analyze "${tmpDir}"`, {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 10000,
      });
      // Should not reach here
      expect.unreachable('Should have exited with non-zero');
    } catch (err: any) {
      expect(err.stdout || err.stderr || '').toContain('--skip-git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
