import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDetectChangesDiffArgs } from '../../src/mcp/local/local-backend.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

describe('detect_changes EOL filtering', () => {
  it.each([
    ['unstaged', undefined, ['diff', '--ignore-cr-at-eol', '-U0']],
    ['staged', undefined, ['diff', '--ignore-cr-at-eol', '--staged', '-U0']],
    ['all', undefined, ['diff', '--ignore-cr-at-eol', 'HEAD', '-U0']],
    ['compare', 'main', ['diff', '--ignore-cr-at-eol', 'main', '-U0']],
  ])('adds the EOL guard for %s scope', (scope, baseRef, expected) => {
    expect(buildDetectChangesDiffArgs(scope, baseRef)).toEqual(expected);
  });

  it('requires a base ref for compare scope', () => {
    expect(buildDetectChangesDiffArgs('compare')).toBeNull();
  });

  it('suppresses CRLF-only changes but retains other whitespace changes', () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), 'gitnexus-detect-eol-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'sample.ts'), 'const first = 1;\r\nconst second = 2;\r\n');
      commitAll(repoDir, 'initial');

      writeFileSync(path.join(repoDir, 'sample.ts'), 'const first = 1;\nconst second = 2;\n');
      const diffArgs = buildDetectChangesDiffArgs('unstaged');
      if (!diffArgs) throw new Error('unstaged scope must produce git diff arguments');
      expect(
        execFileSync('git', diffArgs, {
          cwd: repoDir,
          encoding: 'utf8',
        }),
      ).toBe('');

      writeFileSync(path.join(repoDir, 'sample.ts'), 'const first = 1;\n  const second = 2;\n');
      expect(
        execFileSync('git', diffArgs, {
          cwd: repoDir,
          encoding: 'utf8',
        }),
      ).toContain('+  const second = 2;');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
