import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Finding {
  // key identifies the expression and its enclosing declaration, independent of line offsets.
  key: string;
  /** A second identity for a declaration whose binding alone was renamed. */
  renamedBindingKey?: () => string;
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
    const priorByKey = new Map<string, Finding[]>();
    // Fetch historical contents only for changed files that actually have findings.
    if (previous && inScope(previous)) {
      for (const finding of scan(previous, git('cat-file', 'blob', base + ':' + previous))) {
        const entries = priorByKey.get(finding.key);
        if (entries) entries.push(finding);
        else priorByKey.set(finding.key, [finding]);
      }
    }
    const unmatched = current.filter((finding) => !priorByKey.get(finding.key)?.pop());
    if (!unmatched.length) continue;
    // Match unchanged owners first. Each remaining baseline occurrence can cover one rename.
    const renamedCounts = new Map<string, number>();
    for (const entries of priorByKey.values()) {
      for (const finding of entries) {
        const key = finding.renamedBindingKey?.();
        if (key !== undefined) renamedCounts.set(key, (renamedCounts.get(key) ?? 0) + 1);
      }
    }
    for (const finding of unmatched) {
      const key = renamedCounts.size ? finding.renamedBindingKey?.() : undefined;
      const remaining = key === undefined ? 0 : (renamedCounts.get(key) ?? 0);
      if (key !== undefined && remaining > 0) renamedCounts.set(key, remaining - 1);
      else added.push(finding.location);
    }
  }
  return added;
}
