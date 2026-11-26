import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createTestEnvironment } from '../support/environment.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { expect } from 'expect';
import { diffArgsFor } from '../../../../test/helpers/detect-changes-diff-args.js';
import { commitAll, initGitRepo } from '../../../../test/helpers/temp-git-repo.js';

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

const { readHead, onlyMarkdownChanged, canSkipMarkdownReindex } = createRequire(import.meta.url)(
  '../../../../hooks/claude/git-mutation-command.cjs',
);

it('suppresses a docs-only gap but still warns for an earlier unindexed code change', () => {
  const environment = createTestEnvironment();
  const repo = fs.mkdtempSync(path.join(tmpdir(), 'gn-hook-gap-'));
  try {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, 'app.py'), 'v = 1\n');
    commitAll(repo, 'indexed base');
    const base = readHead(repo, repo).head;
    fs.writeFileSync(path.join(repo, 'README.md'), 'notes\n');
    fs.writeFileSync(path.join(repo, 'guide.MDX'), '# Usage\n');
    commitAll(repo, 'docs');
    expect(onlyMarkdownChanged(repo, repo, base, readHead(repo, repo).head)).toBe(true);
    environment.set('GIT_LITERAL_PATHSPECS', '1');
    expect(onlyMarkdownChanged(repo, repo, base, readHead(repo, repo).head)).toBe(true);
    const head = readHead(repo, repo).head;
    const cli = path.join(repo, '.git', 'status.cjs');
    for (const [identity, reasons, expected] of [
      ['current', [], true],
      ['current', ['incremental-in-progress'], false],
      ['stale-or-unknown', [], false],
    ] as const) {
      const status = {
        current: { commit: head },
        index: { commit: base, runnerIdentityStatus: identity, incompleteReasons: reasons },
      };
      fs.writeFileSync(cli, 'console.log(' + JSON.stringify(JSON.stringify(status)) + ')');
      expect(canSkipMarkdownReindex(repo, repo, base, head, () => cli)).toBe(expected);
    }
    fs.writeFileSync(path.join(repo, 'new.ts'), 'untracked');
    expect(onlyMarkdownChanged(repo, repo, base, head)).toBe(false);
    expect(spawnSync('git', ['add', 'new.ts'], { cwd: repo }).status).toBe(0);
    expect(onlyMarkdownChanged(repo, repo, base, head)).toBe(false);
    fs.writeFileSync(path.join(repo, 'app.py'), 'v = 2\n');
    commitAll(repo, 'change code');
    fs.writeFileSync(path.join(repo, 'README.md'), 'more notes\n');
    commitAll(repo, 'more docs');
    expect(onlyMarkdownChanged(repo, repo, base, readHead(repo, repo).head)).toBe(false);
    const docs = path.join(repo, 'docs');
    fs.mkdirSync(docs);
    expect(spawnSync('git', ['config', 'diff.relative', 'true'], { cwd: repo }).status).toBe(0);
    expect(onlyMarkdownChanged(docs, docs, base, readHead(docs, docs).head)).toBe(false);
  } finally {
    environment.restore();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
