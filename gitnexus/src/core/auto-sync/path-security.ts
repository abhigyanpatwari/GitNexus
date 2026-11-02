import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { getGlobalDir } from '../../storage/repo-manager.js';
import { getAutoSyncWatchDir } from './state.js';

const WINDOWS_DANGEROUS_ROOTS =
  process.platform === 'win32'
    ? [
        process.env.SystemRoot,
        process.env.ProgramData,
        process.env.ProgramFiles,
        process.env['ProgramFiles(x86)'],
      ].filter((entry): entry is string => Boolean(entry))
    : [];

const DANGEROUS_ROOTS = new Set(
  [
    '/',
    os.homedir(),
    os.tmpdir(),
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/lib',
    '/lib64',
    '/opt',
    '/proc',
    '/private/tmp',
    '/private/var',
    '/root',
    '/sbin',
    '/sys',
    '/tmp',
    '/usr',
    '/var',
    ...WINDOWS_DANGEROUS_ROOTS,
  ].map((entry) => path.resolve(entry)),
);

const DANGEROUS_PARENT_ROOTS = new Set(
  [
    os.tmpdir(),
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/lib',
    '/lib64',
    '/opt',
    '/proc',
    '/private/tmp',
    '/private/var',
    '/root',
    '/sbin',
    '/sys',
    '/tmp',
    '/usr',
    '/var',
    ...WINDOWS_DANGEROUS_ROOTS,
  ].map((entry) => path.resolve(entry)),
);

const QUARANTINE_RETENTION_DAYS = 14;
const QUARANTINE_MAX_ENTRIES_PER_REPO = 5;

// `auto-sync-<stamp>-<pid>-<uuid>-<repo basename>` — see quarantineAutoSyncPartial.
// The UUID is the only fixed-shape field, so it anchors the grouping key, and
// everything after it is the basename (`[A-Za-z0-9._-]` by construction).
const QUARANTINE_ENTRY_PATTERN =
  /^auto-sync-.+-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i;

export interface AutoSyncCloneRoot {
  root: string;
  quarantineRoot: string;
  quarantineRetentionDays: number;
}

export async function resolveConfiguredCloneRoot(localPath: string): Promise<AutoSyncCloneRoot> {
  const root = normalizeConfiguredCloneRoot(localPath);
  assertNotDangerousRoot(root);
  await assertNoSymlinkPath(root);
  await fs.mkdir(root, { recursive: true });
  await assertDirectoryOwnerAndPermissions(root);
  const realRoot = await fs.realpath(root);
  assertContainedOrSame(
    root,
    realRoot,
    'Configured clone root realpath escaped its normalized path',
  );
  assertNotDangerousRoot(realRoot);
  assertNotGitNexusInternalRoot(realRoot);
  const quarantineRoot = path.join(getAutoSyncWatchDir(), 'quarantine');
  await pruneQuarantineEntries(quarantineRoot);

  return {
    root: realRoot,
    quarantineRoot,
    quarantineRetentionDays: QUARANTINE_RETENTION_DAYS,
  };
}

export function normalizeConfiguredCloneRoot(localPath: string): string {
  const value = localPath.trim();
  if (!value) throw new Error('local_path is required');
  if (!path.isAbsolute(value)) throw new Error('local_path must be an absolute path');
  if (value.split(path.sep).includes('..')) {
    throw new Error('local_path must be normalized and must not contain traversal segments');
  }
  const resolved = path.resolve(value);
  if (resolved !== path.normalize(value)) {
    throw new Error('local_path must be normalized and must not contain traversal segments');
  }
  return resolved;
}

export async function quarantineAutoSyncPartial(
  targetDir: string,
  quarantineRoot: string,
): Promise<string> {
  await fs.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  const base = path.basename(targetDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(
    quarantineRoot,
    `auto-sync-${stamp}-${process.pid}-${randomUUID()}-${base}`,
  );
  try {
    await fs.rename(targetDir, destination);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.cp(targetDir, destination, { recursive: true });
    await fs.rm(targetDir, { recursive: true, force: true });
  }
  await fs.writeFile(
    `${destination}.README.txt`,
    [
      'GitNexus auto-sync isolated a partial or unsafe clone result.',
      `Created at: ${new Date().toISOString()}`,
      `Original path: ${targetDir}`,
      `Retention: keep for ${QUARANTINE_RETENTION_DAYS} days unless an operator reviews and removes it earlier.`,
      'Cleanup: verify the original path and remote before manual deletion.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return destination;
}

async function pruneQuarantineEntries(quarantineRoot: string): Promise<void> {
  const cutoff = Date.now() - QUARANTINE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  // readdir and stat both resolve through a link, so a symlinked quarantine
  // root would age-sweep and delete entries somewhere else entirely.
  const rootStat = await fs.lstat(quarantineRoot).catch(() => undefined);
  if (rootStat?.isSymbolicLink()) {
    throw new Error(`Refusing symlinked auto-sync quarantine root: ${quarantineRoot}`);
  }
  let entries;
  try {
    entries = await fs.readdir(quarantineRoot);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const survivors = (
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith('auto-sync-'))
        .map(async (entry) => {
          const entryPath = path.join(quarantineRoot, entry);
          const stat = await fs.stat(entryPath).catch(() => undefined);
          if (stat && stat.mtimeMs < cutoff) {
            await fs.rm(entryPath, { recursive: true, force: true });
            return undefined;
          }
          return entry;
        }),
    )
  ).filter((entry): entry is string => entry !== undefined);

  // Age alone never bounds a repo that fails on every tick: one partial clone
  // per tick stays inside the retention window forever. Keep the newest few per
  // repo. Entries that do not match the generated naming scheme (operator
  // notes, names from another version) are left to the age sweep alone.
  const byRepo = new Map<string, string[]>();
  for (const entry of survivors) {
    if (entry.endsWith('.README.txt')) continue;
    const repo = QUARANTINE_ENTRY_PATTERN.exec(entry)?.[1];
    if (!repo) continue;
    const group = byRepo.get(repo) ?? [];
    group.push(entry);
    byRepo.set(repo, group);
  }
  await Promise.all(
    [...byRepo.values()].flatMap((group) =>
      group
        // The timestamp is the leading fixed-width field, so a descending
        // string sort is newest-first.
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        .slice(QUARANTINE_MAX_ENTRIES_PER_REPO)
        .map(async (entry) => {
          await fs.rm(path.join(quarantineRoot, entry), { recursive: true, force: true });
          await fs.rm(path.join(quarantineRoot, `${entry}.README.txt`), { force: true });
        }),
    ),
  );
}

function assertNotDangerousRoot(root: string): void {
  if (root === path.resolve(getGlobalDir(), 'repos')) return;
  if (DANGEROUS_ROOTS.has(root)) throw new Error(`Refusing unsafe auto-sync clone root: ${root}`);
  for (const dangerousRoot of DANGEROUS_PARENT_ROOTS) {
    const rel = path.relative(dangerousRoot, root);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new Error(`Refusing unsafe auto-sync clone root under ${dangerousRoot}: ${root}`);
    }
  }
  if (path.parse(root).root === root)
    throw new Error(`Refusing filesystem root as clone root: ${root}`);
}

function assertNotGitNexusInternalRoot(root: string): void {
  const gitnexusDir = path.resolve(getGlobalDir());
  const blocked = [
    path.join(gitnexusDir, 'groups'),
    path.join(gitnexusDir, 'indexes'),
    path.join(gitnexusDir, 'quarantine'),
    path.join(getAutoSyncWatchDir(gitnexusDir), 'quarantine'),
  ];
  for (const blockedRoot of blocked) {
    const rel = path.relative(blockedRoot, root);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw new Error(`Refusing GitNexus internal directory as auto-sync clone root: ${root}`);
    }
  }
}

async function assertNoSymlinkPath(root: string): Promise<void> {
  const parsed = path.parse(root);
  let current = parsed.root;
  const parts = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
    if (stat.isSymbolicLink())
      throw new Error(`Refusing symlink in auto-sync clone root path: ${current}`);
  }
}

export async function assertDirectoryOwnerAndPermissions(root: string): Promise<void> {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`auto-sync clone root is not a directory: ${root}`);
  // POSIX uid/mode have no meaning on Windows, and this runs on every tick for
  // every project, so throwing here failed 100% of repos forever while `watch
  // status` still read `running`. Skip the ownership assertions rather than the
  // whole feature: the caller's other guards — dangerous-root rejection
  // (including the Windows system roots), symlink refusal, realpath containment
  // and the GitNexus-internal-root check — all still apply, and managed git runs
  // with `core.hooksPath` pinned to the null device.
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`auto-sync clone root is owned by uid ${stat.uid}, not current process uid`);
  }
  const mode = stat.mode & 0o777;
  const groupWritable = (mode & 0o020) !== 0;
  const worldWritable = (mode & 0o002) !== 0;
  if (worldWritable) {
    throw new Error(`Refusing world-writable auto-sync clone root: ${root}`);
  }
  if (groupWritable) {
    throw new Error(`Refusing group-writable auto-sync clone root: ${root}`);
  }
}

function assertContainedOrSame(root: string, child: string, message: string): void {
  const rel = path.relative(root, child);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(message);
}
