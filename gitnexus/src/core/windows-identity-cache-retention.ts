import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** Keep the published entry and two recent predecessors in the private Windows default cache. */
export function pruneWindowsIdentityCache(directory: string, keep: string): void {
  const files: { name: string; modified: number }[] = [];
  const expired = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of readdirSync(directory)) {
    if (name === keep) continue;
    const data = /^[0-9a-f]{64}\.json$/.test(name);
    const temporary = /^[0-9a-f]{64}\.json\.\d+\.[0-9a-f]{12}\.tmp$/.test(name);
    if (!data && !temporary) continue;
    const file = path.join(directory, name);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) continue;
      if (data) files.push({ name, modified: stat.mtimeMs });
      else if (stat.mtimeMs < expired) unlinkSync(file);
    } catch {
      // A concurrent writer may have renamed or removed this entry.
    }
  }
  files.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  for (const { name } of files.slice(2)) {
    try {
      unlinkSync(path.join(directory, name));
    } catch {
      // A concurrent cleanup may have removed the entry.
    }
  }
}
