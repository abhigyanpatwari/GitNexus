import { createRequire } from 'node:module';
import type { GroupConfig, GroupManifestLink, ContractType, ContractRole } from './types.js';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

const VALID_CONTRACT_TYPES: ContractType[] = ['http', 'grpc', 'topic', 'lib', 'custom'];
const VALID_ROLES: ContractRole[] = ['provider', 'consumer'];

const DEFAULT_DETECT = {
  http: true,
  grpc: true,
  topics: true,
  shared_libs: true,
  embedding_fallback: true,
  workspace_deps: true,
};

const DEFAULT_MATCHING = {
  bm25_threshold: 0.7,
  embedding_threshold: 0.65,
  max_candidates_per_step: 3,
  exclude_links_paths: [] as string[],
  exclude_links_param_only_paths: false,
};

export function parseGroupConfig(yamlContent: string): GroupConfig {
  const raw = yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid YAML: expected an object');
  }

  if (raw.version === undefined) throw new Error('version is required in group.yaml');
  if (raw.version !== 1) {
    throw new Error(`Unsupported group.yaml version: ${raw.version}. Expected 1.`);
  }
  if (!raw.name || typeof raw.name !== 'string') throw new Error('name is required in group.yaml');
  if (!raw.repos || typeof raw.repos !== 'object' || Array.isArray(raw.repos)) {
    throw new Error('repos is required in group.yaml (must be a mapping)');
  }

  const repos = raw.repos as Record<string, string>;
  const repoPaths = new Set(Object.keys(repos));

  const rawLinks = (raw.links as unknown[]) || [];
  const links: GroupManifestLink[] = rawLinks.map((l: unknown, i: number) => {
    const link = l as Record<string, unknown>;
    if (!link.from || !repoPaths.has(link.from as string)) {
      throw new Error(`links[${i}].from "${link.from}" does not match any repo path in group`);
    }
    if (!link.to || !repoPaths.has(link.to as string)) {
      throw new Error(`links[${i}].to "${link.to}" does not match any repo path in group`);
    }
    if (!VALID_CONTRACT_TYPES.includes(link.type as ContractType)) {
      throw new Error(
        `links[${i}].type "${link.type}" is invalid. Expected: ${VALID_CONTRACT_TYPES.join(', ')}`,
      );
    }
    if (!VALID_ROLES.includes(link.role as ContractRole)) {
      throw new Error(`links[${i}].role "${link.role}" is invalid. Expected: provider | consumer`);
    }
    if (
      link.contract === undefined ||
      link.contract === null ||
      String(link.contract).trim() === ''
    ) {
      throw new Error(`links[${i}].contract is required`);
    }
    return {
      from: link.from as string,
      to: link.to as string,
      type: link.type as ContractType,
      contract: String(link.contract),
      role: link.role as ContractRole,
    };
  });

  const detect = { ...DEFAULT_DETECT, ...((raw.detect as object) || {}) };
  const matching = { ...DEFAULT_MATCHING, ...((raw.matching as object) || {}) };
  const packages = (raw.packages as Record<string, Record<string, string>>) || {};

  return {
    version: 1,
    name: raw.name as string,
    description: (raw.description as string) || '',
    repos,
    links,
    packages,
    detect,
    matching,
  };
}

export class GroupNotFoundError extends Error {
  constructor(public readonly groupName: string) {
    super(`Group "${groupName}" not found`);
    this.name = 'GroupNotFoundError';
  }
}

export async function loadGroupConfig(groupDir: string): Promise<GroupConfig> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const yamlPath = path.join(groupDir, 'group.yaml');
  let content: string;
  try {
    content = await fsp.readFile(yamlPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GroupNotFoundError(path.basename(groupDir));
    }
    throw err;
  }
  return parseGroupConfig(content);
}
