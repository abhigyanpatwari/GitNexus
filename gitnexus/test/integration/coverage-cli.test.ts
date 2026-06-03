import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('coverage CLI (smoke)', () => {
  const repoPath = process.cwd();
  const testData = `TN:
SF:src/test.ts
DA:1,5
DA:2,0
end_of_record
`;

  it('imports LCOV coverage and lists runs', () => {
    const tmpFile = path.join(os.tmpdir(), `test-cov-${Date.now()}.lcov`);
    fs.writeFileSync(tmpFile, testData);

    try {
      const cliEntry = path.join(repoPath, 'dist', 'cli', 'index.js');
      // Skip if not built
      if (!fs.existsSync(cliEntry)) {
        console.log('CLI not built — skipping smoke test');
        return;
      }

      const importOut = execSync(
        `node ${cliEntry} coverage import ${tmpFile} --format lcov --label "smoke-test"`,
        { cwd: repoPath, encoding: 'utf-8', timeout: 30000 },
      );
      expect(importOut).toContain('Coverage imported');

      const listOut = execSync(
        `node ${cliEntry} coverage list`,
        { cwd: repoPath, encoding: 'utf-8', timeout: 15000 },
      );
      expect(listOut).toContain('Coverage runs');

      // Grab a run ID from the list output
      const listLines = listOut.split('\n').filter(l => l.trim());
      const runIdLine = listLines.find(l => l.includes('smoke-test'));
      const runId = runIdLine ? runIdLine.trim().split(/\s+/)[0].trim() : null;

      if (runId) {
        execSync(
          `node ${cliEntry} coverage rm ${runId}`,
          { cwd: repoPath, encoding: 'utf-8', timeout: 15000 },
        );
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
});
