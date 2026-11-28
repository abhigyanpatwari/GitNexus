/**
 * Phase: symfonyConfig
 *
 * Detects Symfony container projects, stamps PHP DI metadata for the shared
 * `di` phase, and reads `config/services*.yaml` aliases when present (#1857).
 *
 * @deps    parse
 * @reads   filesystem (services.yaml / services.php / services.xml / composer.json),
 *          graph (Class / Method nodes)
 * @writes  graph Class/Method properties (`symfonyDiProvider`, constructor enable)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { GraphNode } from 'gitnexus-shared';
import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import {
  SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY,
  SYMFONY_DI_PROVIDER_PROPERTY,
  defaultSymfonyProvider,
} from '../di-extractors/symfony.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as typeof import('js-yaml');

const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;

const SYMFONY_UNKNOWN_SCALAR_TAG = yaml.defineScalarTag('!', {
  matchByTagPrefix: true,
  resolve: (source: string) => source,
  identify: () => false,
});
const SYMFONY_UNKNOWN_SEQUENCE_TAG = yaml.defineSequenceTag('!', {
  matchByTagPrefix: true,
  create: () => [] as unknown[],
  addItem: (carrier: unknown[], item: unknown) => {
    carrier.push(item);
  },
  identify: () => false,
});
const SYMFONY_UNKNOWN_MAPPING_TAG = yaml.defineMappingTag('!', {
  matchByTagPrefix: true,
  create: () => ({}) as Record<string, unknown>,
  addPair: (carrier: Record<string, unknown>, key: unknown, value: unknown) => {
    carrier[String(key)] = value;
    return '';
  },
  has: (carrier: Record<string, unknown>, key: unknown) =>
    Object.prototype.hasOwnProperty.call(carrier, String(key)),
  keys: (result: Record<string, unknown>) => Object.keys(result),
  get: (result: Record<string, unknown>, key: unknown) => result[String(key)],
  identify: () => false,
});
const SYMFONY_YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(
  yaml.mergeTag,
  yaml.timestampTag,
  yaml.binaryTag,
  yaml.omapTag,
  yaml.pairsTag,
  yaml.setTag,
  SYMFONY_UNKNOWN_SCALAR_TAG,
  SYMFONY_UNKNOWN_SEQUENCE_TAG,
  SYMFONY_UNKNOWN_MAPPING_TAG,
);

export interface SymfonyConfigOutput {
  aliasesApplied: number;
  aliasesFound: number;
}

export interface SymfonyServiceAlias {
  interfaceName: string;
  implementationName: string;
  filePath: string;
}

const SERVICES_YAML_RE = /(?:^|\/)config\/services(?:_[a-zA-Z0-9]+)?(?:\/[^/]+)?\.ya?ml$/i;
const SERVICES_PHP_RE = /(?:^|\/)config\/services(?:_[a-zA-Z0-9]+)?\.php$/i;
const SERVICES_XML_RE = /(?:^|\/)config\/services(?:_[a-zA-Z0-9]+)?\.xml$/i;

const SYMFONY_COMPOSER_PACKAGES: ReadonlySet<string> = new Set([
  'symfony/framework-bundle',
  'symfony/dependency-injection',
  'symfony/runtime',
]);

export function isServicesYaml(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return SERVICES_YAML_RE.test(normalized);
}

export function isServicesPhpOrXml(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return SERVICES_PHP_RE.test(normalized) || SERVICES_XML_RE.test(normalized);
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

function namesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
    if (key.startsWith('_')) continue;
    if (typeof value === 'string' && value.trim().startsWith('@')) {
      aliases.push({
        interfaceName: stripServiceId(key),
        implementationName: stripServiceId(value),
        filePath,
      });
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const alias = (value as Record<string, unknown>).alias;
    if (typeof alias === 'string' && alias.trim().length > 0) {
      aliases.push({
        interfaceName: stripServiceId(key),
        implementationName: stripServiceId(alias),
        filePath,
      });
    }
  }
  return aliases;
}

/** Map custom service IDs (`app.file_logger`) to their declared `class:`. */
export function extractSymfonyServiceIdClasses(services: unknown): Map<string, string> {
  const idToClass = new Map<string, string>();
  if (services === null || typeof services !== 'object' || Array.isArray(services)) {
    return idToClass;
  }
  const map = services as Record<string, unknown>;
  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith('_')) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const className = (value as Record<string, unknown>).class;
    if (typeof className !== 'string' || className.trim().length === 0) continue;
    idToClass.set(stripServiceId(key), stripServiceId(className));
  }
  return idToClass;
}

export function resolveSymfonyImplementationName(
  implementationName: string,
  serviceIdToClass: ReadonlyMap<string, string>,
): string {
  const direct = serviceIdToClass.get(implementationName);
  if (direct !== undefined) return direct;
  const lower = implementationName.toLowerCase();
  for (const [serviceId, className] of serviceIdToClass) {
    if (serviceId.toLowerCase() === lower) return className;
  }
  return implementationName;
}

export interface SymfonyServicesParseResult {
  aliases: SymfonyServiceAlias[];
  serviceIdToClass: Map<string, string>;
}

export function parseSymfonyServicesYaml(content: string, filePath: string): SymfonyServiceAlias[] {
  return parseSymfonyServicesDocument(content, filePath).aliases;
}

export function parseSymfonyServicesDocument(
  content: string,
  filePath: string,
): SymfonyServicesParseResult {
  let doc: unknown;
  try {
    doc = yaml.load(content, { schema: SYMFONY_YAML_SCHEMA });
  } catch {
    return { aliases: [], serviceIdToClass: new Map() };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { aliases: [], serviceIdToClass: new Map() };
  }
  const root = doc as Record<string, unknown>;
  return {
    aliases: extractSymfonyServiceAliases(root.services, filePath),
    serviceIdToClass: extractSymfonyServiceIdClasses(root.services),
  };
}

export function classMatchesName(
  nodeName: string,
  qualifiedName: unknown,
  wanted: string,
): boolean {
  const target = stripServiceId(wanted);
  const targetSimple = simpleName(target);
  const wantedIsFqcn = target.includes('\\');

  if (typeof qualifiedName === 'string' && qualifiedName.length > 0) {
    const q = stripServiceId(qualifiedName);
    if (namesEqual(q, target)) return true;
    if (!wantedIsFqcn && namesEqual(simpleName(q), target)) return true;
    return false;
  }

  return namesEqual(nodeName, target) || namesEqual(nodeName, targetSimple);
}

async function collectServiceYamlPaths(
  repoPath: string,
  allPaths: readonly string[],
): Promise<string[]> {
  // Only paths admitted by the repository scan (honours ignore rules / size caps).
  const existing: string[] = [];
  for (const rel of allPaths.filter(isServicesYaml)) {
    const filePath = path.isAbsolute(rel) ? rel : path.join(repoPath, rel);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size <= MAX_CONFIG_FILE_BYTES) {
        existing.push(filePath);
      }
    } catch {
      // missing
    }
  }
  return existing;
}

async function composerRequiresSymfony(repoPath: string): Promise<boolean> {
  const composerPath = path.join(repoPath, 'composer.json');
  try {
    const stat = await fs.stat(composerPath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) return false;
    const raw = await fs.readFile(composerPath, 'utf8');
    const json = JSON.parse(raw) as {
      require?: Record<string, string>;
      'require-dev'?: Record<string, string>;
    };
    const packages = {
      ...(json.require ?? {}),
      ...(json['require-dev'] ?? {}),
    };
    return Object.keys(packages).some((name) => SYMFONY_COMPOSER_PACKAGES.has(name));
  } catch {
    return false;
  }
}

async function hasSymfonyContainerEvidence(
  repoPath: string,
  allPaths: readonly string[],
  yamlPaths: readonly string[],
): Promise<boolean> {
  if (yamlPaths.length > 0) return true;
  if (allPaths.some(isServicesPhpOrXml)) return true;
  return composerRequiresSymfony(repoPath);
}

function stampPhpDiMetadata(ctx: PipelineContext): void {
  ctx.graph.forEachNode((node) => {
    if (node.properties.language !== 'php') return;
    if (node.label === 'Class') {
      const base = defaultSymfonyProvider(node);
      if (base !== null) {
        node.properties[SYMFONY_DI_PROVIDER_PROPERTY] = base;
      }
      return;
    }
    if (node.label === 'Method' && node.properties.name.toLowerCase() === '__construct') {
      node.properties[SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY] = true;
    }
  });
}

function readPriorPreferenceByType(node: GraphNode): Record<string, string> {
  const existing = node.properties[SYMFONY_DI_PROVIDER_PROPERTY];
  if (
    existing !== null &&
    typeof existing === 'object' &&
    (existing as { preferenceByType?: unknown }).preferenceByType !== null &&
    typeof (existing as { preferenceByType?: unknown }).preferenceByType === 'object' &&
    !Array.isArray((existing as { preferenceByType?: unknown }).preferenceByType)
  ) {
    return { ...(existing as { preferenceByType: Record<string, string> }).preferenceByType };
  }
  return {};
}

export const symfonyConfigPhase: PipelinePhase<SymfonyConfigOutput> = {
  name: 'symfonyConfig',
  deps: ['parse'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<SymfonyConfigOutput> {
    const parseOutput = getPhaseOutput<ParseOutput>(deps, 'parse');
    const allPaths = parseOutput.allPaths ?? [];
    const yamlPaths = await collectServiceYamlPaths(ctx.repoPath, allPaths);

    const enableDi = await hasSymfonyContainerEvidence(ctx.repoPath, allPaths, yamlPaths);
    if (!enableDi) {
      return { aliasesApplied: 0, aliasesFound: 0 };
    }

    stampPhpDiMetadata(ctx);

    const aliases: SymfonyServiceAlias[] = [];
    const serviceIdToClass = new Map<string, string>();
    for (const yamlPath of yamlPaths) {
      try {
        const content = await fs.readFile(yamlPath, 'utf8');
        if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_FILE_BYTES) continue;
        const rel = path.relative(ctx.repoPath, yamlPath) || yamlPath;
        const parsed = parseSymfonyServicesDocument(content, rel);
        aliases.push(...parsed.aliases);
        for (const [serviceId, className] of parsed.serviceIdToClass) {
          serviceIdToClass.set(serviceId, className);
        }
      } catch {
        // unreadable
      }
    }

    let aliasesApplied = 0;
    for (const alias of aliases) {
      const implementationName = resolveSymfonyImplementationName(
        alias.implementationName,
        serviceIdToClass,
      );
      const matches: GraphNode[] = [];
      ctx.graph.forEachNode((node) => {
        if (node.label !== 'Class') return;
        if (node.properties.language !== 'php') return;
        if (
          !classMatchesName(node.properties.name, node.properties.qualifiedName, implementationName)
        ) {
          return;
        }
        if (defaultSymfonyProvider(node) === null) return;
        matches.push(node);
      });

      if (matches.length !== 1) continue;
      const node = matches[0];

      const base = defaultSymfonyProvider(node);
      if (base === null) continue;

      const reason = `Symfony services.yaml alias ${alias.interfaceName} → ${implementationName}`;
      const preferenceByType = readPriorPreferenceByType(node);
      preferenceByType[alias.interfaceName] = reason;

      node.properties[SYMFONY_DI_PROVIDER_PROPERTY] = {
        ...base,
        preferenceByType,
      };
      aliasesApplied++;
    }

    return { aliasesApplied, aliasesFound: aliases.length };
  },
};
