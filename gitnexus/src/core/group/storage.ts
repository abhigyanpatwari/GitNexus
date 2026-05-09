import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ContractRegistry } from './types.js';
import { retryRename } from './bridge-db.js';

/**
 * Build an unpredictable suffix for atomic-write tmp files. Replaces the
 * previous `Date.now()` pattern which CodeQL flagged as
 * js/insecure-temporary-file: a guessable suffix in a writable directory
 * lets a co-located attacker pre-create or symlink the tmp path before the
 * write lands.
 */
const tmpSuffix = (): string => randomBytes(8).toString('hex');

const CONTRACTS_FILE = 'contracts.json';

export function getDefaultGitnexusDir(): string {
  return process.env.GITNEXUS_HOME || path.join(os.homedir(), '.gitnexus');
}

export function getGroupsBaseDir(gitnexusDir?: string): string {
  return path.join(gitnexusDir || getDefaultGitnexusDir(), 'groups');
}

const GROUP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateGroupName(name: string): void {
  if (!GROUP_NAME_RE.test(name)) {
    throw new Error(
      `Invalid group name "${name}". Names must start with a letter or digit and contain only [a-zA-Z0-9_-].`,
    );
  }
}

export function getGroupDir(gitnexusDir: string, groupName: string): string {
  validateGroupName(groupName);
  return path.join(gitnexusDir, 'groups', groupName);
}

export async function writeContractRegistry(
  groupDir: string,
  registry: ContractRegistry,
): Promise<void> {
  const targetPath = path.join(groupDir, CONTRACTS_FILE);
  const tmpPath = `${targetPath}.tmp.${tmpSuffix()}`;

  // O_EXCL via `'wx'` flag + explicit `0o600` mode — closes both halves
  // of the CodeQL js/insecure-temporary-file finding: `'wx'` rejects a
  // pre-planted symlink at the path, and `0o600` (user-only) prevents
  // the file from being created group/world readable while it briefly
  // contains contract data en route to the rename. The query's
  // `isSecureMode` predicate inspects ONLY the mode argument, not the
  // flags, so the explicit mode is what credits the fix.
  const handle = await fsp.open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(registry, null, 2), 'utf-8');
  } finally {
    await handle.close();
  }
  // retryRename absorbs the documented Windows EPERM/EBUSY/EACCES race that
  // fires when AV scanners or another concurrent rename briefly hold the
  // destination handle between rename calls. Same helper bridge-db.ts uses
  // (lines 304, 583, 587, 595, 605, 677) for the bridge.lbug atomic swap —
  // single source of truth for the Windows-rename pattern across the group
  // package.
  await retryRename(tmpPath, targetPath);
}

export async function readContractRegistry(groupDir: string): Promise<ContractRegistry | null> {
  const filePath = path.join(groupDir, CONTRACTS_FILE);
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(content) as ContractRegistry;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listGroups(gitnexusDir?: string): Promise<string[]> {
  const groupsDir = getGroupsBaseDir(gitnexusDir);
  try {
    const entries = await fsp.readdir(groupsDir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const yamlPath = path.join(groupsDir, entry.name, 'group.yaml');
        if (fs.existsSync(yamlPath)) {
          names.push(entry.name);
        }
      }
    }
    return names;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function createGroupDir(
  gitnexusDir: string,
  groupName: string,
  force: boolean = false,
): Promise<string> {
  const groupDir = getGroupDir(gitnexusDir, groupName);
  if (fs.existsSync(path.join(groupDir, 'group.yaml')) && !force) {
    throw new Error(`Group "${groupName}" already exists. Use --force to overwrite.`);
  }
  await fsp.mkdir(groupDir, { recursive: true });

  const template = `version: 1
name: ${groupName}
description: ""

repos: {}

links: []

packages: {}

detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: true

matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
  # exclude_links_paths: [/ping, /health, /healthcheck]
  # exclude_links_param_only_paths: false
`;
  // Always write group.yaml with O_EXCL via `fsp.open(..., 'wx')` —
  // refuses to follow a pre-planted symlink at the target path, closing
  // the TOCTOU window between the existence check (line ~98) and the
  // write that CodeQL js/insecure-temporary-file flags. Under
  // `force=true` we unlink the existing file first (best-effort, no-op
  // when absent) so the subsequent O_EXCL open succeeds AND the same
  // symlink-rejection guarantee holds — this is strictly safer than
  // the previous `flag: force ? 'w' : 'wx'` shape, which silently
  // followed symlinks under force. CodeQL's rule does not recognize
  // the `writeFile(path, content, { flag: 'wx' })` shape as O_EXCL;
  // the explicit open() handle below is what credits the mitigation.
  const yamlPath = path.join(groupDir, 'group.yaml');
  if (force) {
    try {
      await fsp.unlink(yamlPath);
    } catch (err) {
      // ENOENT (file absent) is expected on first run; rethrow anything
      // else so we don't silently mask permission/EBUSY failures.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  // `'wx'` rejects a pre-planted symlink at the path; `0o600` is
  // user-only (no group/world bits) — gitnexus storage is per-user
  // (`~/.gitnexus/...`), so any "other user wants to read this" case is
  // a misconfiguration, not a feature. Keeping the file user-only also
  // satisfies CodeQL's `isSecureMode` predicate (low 6 bits == 0) and
  // closes the js/insecure-temporary-file alert at this site.
  const handle = await fsp.open(yamlPath, 'wx', 0o600);
  try {
    await handle.writeFile(template, 'utf-8');
  } finally {
    await handle.close();
  }
  return groupDir;
}
