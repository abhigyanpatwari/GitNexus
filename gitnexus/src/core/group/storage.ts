import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  ContractRegistry,
  BridgeHandle,
  BridgeMeta,
  LegacyContractRegistry,
} from './types.js';
import { closeBridgeDb, openBridgeDbReadOnly, readBridgeMeta } from './bridge-db.js';

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

/**
 * @deprecated Used only as internal JSON fallback for openBridgeOrFallback.
 * New data is written to bridge.lbug via writeBridge.
 */
async function readContractRegistryJson(groupDir: string): Promise<ContractRegistry | null> {
  const filePath = path.join(groupDir, 'contracts.json');
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
`;
  await fsp.writeFile(path.join(groupDir, 'group.yaml'), template, 'utf-8');
  return groupDir;
}

export async function openBridgeOrFallback(
  groupDir: string,
): Promise<
  | { type: 'bridge'; handle: BridgeHandle; meta: BridgeMeta }
  | { type: 'json'; registry: LegacyContractRegistry; deprecationWarning: string }
  | { type: 'none' }
> {
  const handle = await openBridgeDbReadOnly(groupDir);
  if (handle) {
    // readBridgeMeta has its own try/catch and returns a default when
    // meta.json is missing, but defensively guard against any other
    // failure so we never leak an opened bridge handle.
    try {
      const meta = await readBridgeMeta(groupDir);
      return { type: 'bridge', handle, meta };
    } catch (err) {
      await closeBridgeDb(handle).catch(() => {
        /* ignore: cleanup path, best effort */
      });
      throw err;
    }
  }
  // JSON fallback
  const registry = await readContractRegistryJson(groupDir);
  if (registry) {
    return {
      type: 'json',
      registry,
      deprecationWarning:
        'contracts.json is deprecated. Run "gitnexus group sync <name>" to migrate to bridge.lbug.',
    };
  }
  return { type: 'none' };
}
