import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDetectChangesDiffArgs } from '../../src/mcp/local/local-backend.js';
import { parseDiffHunks } from '../../src/storage/git.js';
import { diffArgsFor } from '../helpers/detect-changes-diff-args.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

/** The five flags every scope carries, ahead of its own ref/staging arguments. */
const GUARD_FLAGS = [
  'diff',
  '--ignore-cr-at-eol',
  '--no-ext-diff',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

describe('detect_changes EOL filtering', () => {
  it.each([
    ['unstaged', undefined, [...GUARD_FLAGS, '-U0']],
    ['staged', undefined, [...GUARD_FLAGS, '--staged', '-U0']],
    ['all', undefined, [...GUARD_FLAGS, 'HEAD', '-U0']],
    ['compare', 'main', [...GUARD_FLAGS, 'main', '-U0']],
  ])('adds the EOL and prefix guards for %s scope', (scope, baseRef, expected) => {
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
      const diffArgs = diffArgsFor('unstaged');
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

/**
 * #2915 — the user's own git config could turn the pre-commit gate into a
 * silent all-clear.
 *
 * `parseDiffHunks` recognises a file by its `+++ b/` header, and git only emits
 * that prefix by default: `diff.noprefix` emits `+++ sample.py` and
 * `diff.mnemonicPrefix` emits `+++ w/sample.py`. Either one parses to ZERO
 * files, which `detect_changes` reported as "No changes detected." with exit 0
 * and no `partial`. The flags pin the prefixes the parser matches.
 */
describe('detect_changes diff prefix pinning', () => {
  it.each([
    ['diff.noprefix', '+++ sample.py'],
    ['diff.mnemonicPrefix', '+++ w/sample.py'],
  ])('parses the diff even with %s configured', (configKey, hostileHeader) => {
    const repoDir = mkdtempSync(path.join(tmpdir(), 'gitnexus-detect-prefix-'));
    try {
      initGitRepo(repoDir);
      writeFileSync(path.join(repoDir, 'sample.py'), 'def hello():\n    return 1\n');
      commitAll(repoDir, 'initial');
      execFileSync('git', ['config', configKey, 'true'], { cwd: repoDir });
      writeFileSync(path.join(repoDir, 'sample.py'), 'def hello():\n    return 2\n');

      // The config really is hostile: without the prefix flags git relabels the
      // headers and the whole diff parses to nothing.
      const unguarded = execFileSync('git', ['diff', '--ignore-cr-at-eol', '-U0'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      expect(unguarded).toContain(hostileHeader);
      expect(parseDiffHunks(unguarded)).toEqual([]);

      // Source line 2 is the edit; the hunk header is git's own 1-based space.
      expect(
        parseDiffHunks(
          execFileSync('git', diffArgsFor('unstaged'), { cwd: repoDir, encoding: 'utf8' }),
        ),
      ).toEqual([{ filePath: 'sample.py', hunks: [{ startLine: 2, endLine: 2 }] }]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
