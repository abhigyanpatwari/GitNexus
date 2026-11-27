/**
 * Phase: symfonyConfig
 *
 * Reads Symfony `config/services.yaml` (and siblings) for explicit service
 * aliases (`Interface: '@Concrete'`) and stamps preferred-provider metadata
 * onto matching Class nodes for the shared `di` phase (#1857).
 *
 * @deps    parse
 * @reads   filesystem (services.yaml), graph (Class nodes)
 * @writes  graph Class node properties (`symfonyDiProvider`)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import {
  SYMFONY_DI_PROVIDER_PROPERTY,
  defaultSymfonyProvider,
} from '../di-extractors/symfony.js';

// ParseOutput.allPaths lists every repo-relative path discovered upstream.

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as typeof import('js-yaml');

export interface SymfonyConfigOutput {
  /** Number of Interface → Impl aliases applied to Class providers. */
  aliasesApplied: number;
  /** Alias entries discovered in services YAML files. */
  aliasesFound: number;
}

export interface SymfonyServiceAlias {
  /** FQCN or short name of the aliased type (usually an interface). */
  interfaceName: string;
  /** FQCN or short name of the concrete service (leading `@` stripped). */
  implementationName: string;
  filePath: string;
}

const SERVICES_PATH_RE = /(?:^|\/)config\/services(?:\/[^/]+)?\.ya?ml$/i;

function isServicesYaml(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return SERVICES_PATH_RE.test(normalized);
}

function stripServiceId(raw: string): string {
  let id = raw.trim();
  if (id.startsWith('@')) id = id.slice(1);
  if (id.startsWith('\\')) id = id.slice(1);
  return id;
}

function simpleName(fqcn: string): string {
  const cleaned = stripServiceId(fqcn);
  const idx = cleaned.lastIndexOf('\\');
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

/**
 * Extract Interface → Impl aliases from a parsed Symfony services mapping.
 *
 * Recognizes:
 * - `App\Log\Logger: '@App\Log\FileLogger'`
 * - `App\Log\Logger: { alias: App\Log\FileLogger }`
 */
export function extractSymfonyServiceAliases(
  services: unknown,
  filePath: string,
): SymfonyServiceAlias[] {
  if (services === null || typeof services !== 'object' || Array.isArray(services)) return [];
  const map = services as Record<string, unknown>;
  const aliases: SymfonyServiceAlias[] = [];

  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith('_')) continue; // _defaults, _instanceof, …
    if (typeof value === 'string' && value.trim().startsWith('@')) {
      aliases.push({
        interfaceName: stripServiceId(key),
        implementationName: stripServiceId(value),
        filePath,
      });
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const alias = (value as Record<string, unknown>).alias;
      if (typeof alias === 'string' && alias.trim().length > 0) {
        aliases.push({
          interfaceName: stripServiceId(key),
          implementationName: stripServiceId(alias),
          filePath,
        });
      }
    }
  }
  return aliases;
}

export function parseSymfonyServicesYaml(
  content: string,
  filePath: string,
): SymfonyServiceAlias[] {
  let doc: unknown;
  try {
    doc = yaml.load(content);
  } catch {
    return [];
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const root = doc as Record<string, unknown>;
  return extractSymfonyServiceAliases(root.services, filePath);
}

function classMatchesName(nodeName: string, qualifiedName: unknown, wanted: string): boolean {
  const target = stripServiceId(wanted);
  if (nodeName === target || nodeName === simpleName(target)) return true;
  if (typeof qualifiedName === 'string') {
    const q = stripServiceId(qualifiedName);
    if (q === target || simpleName(q) === simpleName(target)) return true;
  }
  return false;
}

async function collectServiceYamlPaths(
  repoPath: string,
  allPaths: readonly string[],
): Promise<string[]> {
  const fromScan = allPaths.filter(isServicesYaml);
  const candidates = new Set(
    fromScan.map((f) => (path.isAbsolute(f) ? f : path.join(repoPath, f))),
  );

  // Also probe the conventional Symfony layout when YAML was not scanned.
  for (const rel of ['config/services.yaml', 'config/services.yml']) {
    candidates.add(path.join(repoPath, rel));
  }

  const existing: string[] = [];
  for (const filePath of candidates) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) existing.push(filePath);
    } catch {
      // absent — fine
    }
  }
  return existing;
}

export const symfonyConfigPhase: PipelinePhase<SymfonyConfigOutput> = {
  name: 'symfonyConfig',
  deps: ['parse'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<SymfonyConfigOutput> {
    const parseOutput = getPhaseOutput<ParseOutput>(deps, 'parse');
    const yamlPaths = await collectServiceYamlPaths(ctx.repoPath, parseOutput.allPaths ?? []);

    const aliases: SymfonyServiceAlias[] = [];
    for (const yamlPath of yamlPaths) {
      try {
        const content = await fs.readFile(yamlPath, 'utf8');
        const rel = path.relative(ctx.repoPath, yamlPath) || yamlPath;
        aliases.push(...parseSymfonyServicesYaml(content, rel));
      } catch {
        // Unreadable / malformed YAML — fail closed for that file.
      }
    }

    let aliasesApplied = 0;
    for (const alias of aliases) {
      ctx.graph.forEachNode((node) => {
        if (node.label !== 'Class') return;
        if (node.properties.language !== 'php') return;
        if (
          !classMatchesName(node.properties.name, node.properties.qualifiedName, alias.implementationName)
        ) {
          return;
        }
        const base = defaultSymfonyProvider(node);
        if (base === null) return;
        node.properties[SYMFONY_DI_PROVIDER_PROPERTY] = {
          ...base,
          preferenceReason: `Symfony services.yaml alias ${alias.interfaceName} → ${alias.implementationName}`,
        };
        aliasesApplied++;
      });
    }

    return { aliasesApplied, aliasesFound: aliases.length };
  },
};
