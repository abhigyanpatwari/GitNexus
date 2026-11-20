import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Finding {
  // key identifies the expression and its enclosing declaration, independent of line offsets.
  key: string;
  location: string;
}

interface ChangedFile {
  file: string;
  previous?: string;
}

/** Compare the working tree (including newly added files) with the pinned merge base. */
export function newLanguageFindings(
  root: string,
  target: string,
  roots: string[],
  inScope: (file: string) => boolean,
  scan: (file: string, source: string) => Finding[],
): string[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  const revision = git('rev-parse', '--verify', '--end-of-options', target + '^{commit}').trim();
  const base = git('merge-base', revision, 'HEAD').trim();
  const records = git(
    'diff',
    '--name-status',
    '--no-relative',
    '--no-ext-diff',
    '--find-renames',
    '--diff-filter=ACMRT',
    '-z',
    base,
    '--',
    ...roots,
  ).split('\0');
  const changed: ChangedFile[] = [];
  for (let i = 0; i < records.length - 1; ) {
    const status = records[i++];
    const first = records[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const file = records[i++];
      // Copies add a new occurrence. A rename can only inherit a prior shared implementation.
      changed.push({ file, previous: status.startsWith('R') ? first : undefined });
    } else {
      changed.push({ file: first, previous: status === 'M' ? first : undefined });
    }
  }
  for (const file of git('ls-files', '--others', '--exclude-standard', '-z', '--', ...roots).split(
    '\0',
  )) {
    if (file) changed.push({ file });
  }
  const added: string[] = [];
  for (const { file, previous } of changed) {
    if (!inScope(file)) continue;
    const working = path.join(root, file);
    if (!lstatSync(working).isFile()) continue;
    const current = scan(file, readFileSync(working, 'utf8'));
    if (!current.length) continue;
    const counts = new Map<string, number>();
    // Fetch historical contents only for changed files that actually have findings.
    if (previous && inScope(previous)) {
      for (const { key } of scan(previous, git('cat-file', 'blob', base + ':' + previous))) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    for (const finding of current) {
      const allowed = counts.get(finding.key) ?? 0;
      if (allowed > 0) counts.set(finding.key, allowed - 1);
      else added.push(finding.location);
    }
  }
  return added;
}
