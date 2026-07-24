/**
 * Phase: springAutoConfiguration
 *
 * Discovers Spring Boot auto-configuration declarations from repository
 * metadata after source symbols have been resolved. Metadata-backed classes
 * are linked through AUTO_REGISTERS; when source is unavailable, a lightweight
 * synthetic Class preserves the third-party/starter contribution.
 *
 * @deps    structure, scopeResolution
 * @reads   META-INF/spring.factories and AutoConfiguration.imports
 * @writes  Class nodes and AUTO_REGISTERS edges
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { generateId } from '../../../lib/utils.js';
import type { StructureOutput } from './structure.js';
import type { PipelineContext, PipelinePhase, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';

const MAX_SPRING_METADATA_BYTES = 2 * 1024 * 1024;
const ENABLE_AUTO_CONFIGURATION_KEY =
  'org.springframework.boot.autoconfigure.EnableAutoConfiguration';
const AUTO_CONFIGURATION_IMPORTS =
  'META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports';

export interface SpringAutoConfigurationEntry {
  readonly className: string;
  readonly line: number;
}

type SpringAutoConfigurationMetadataKind = 'imports' | 'spring-factories';

interface SpringAutoConfigurationMetadataFile {
  readonly filePath: string;
  readonly kind: SpringAutoConfigurationMetadataKind;
}

export interface SpringAutoConfigurationOutput {
  readonly metadataFiles: number;
  readonly autoConfigurations: number;
}

export function classifySpringAutoConfigurationMetadata(
  filePath: string,
): SpringAutoConfigurationMetadataFile | null {
  const normalized = filePath.replaceAll('\\', '/');
  const lower = `/${normalized}`.toLowerCase();
  if (lower.endsWith(`/${AUTO_CONFIGURATION_IMPORTS.toLowerCase()}`)) {
    return { filePath, kind: 'imports' };
  }
  if (lower.endsWith('/meta-inf/spring.factories')) {
    return { filePath, kind: 'spring-factories' };
  }
  return null;
}

/** Parse Boot 2.7+/3.x one-class-per-line auto-configuration imports. */
export function parseSpringAutoConfigurationImports(
  content: string,
): SpringAutoConfigurationEntry[] {
  const entries: SpringAutoConfigurationEntry[] = [];
  const seen = new Set<string>();
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s*#.*$/, '').trim();
    if (line.length === 0 || seen.has(line)) continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(line)) continue;
    seen.add(line);
    entries.push({ className: line, line: index + 1 });
  }
  return entries;
}

function logicalFactoryLines(content: string): Array<{ text: string; line: number }> {
  const logical: Array<{ text: string; line: number }> = [];
  let current = '';
  let startLine = 1;
  const physical = content.split(/\r?\n/);
  for (let index = 0; index < physical.length; index++) {
    const raw = physical[index] ?? '';
    if (current.length === 0) startLine = index + 1;
    const trimmed = current.length === 0 ? raw.trimStart() : raw.trim();
    current += trimmed;
    let trailingBackslashes = 0;
    for (let cursor = current.length - 1; cursor >= 0 && current[cursor] === '\\'; cursor--) {
      trailingBackslashes++;
    }
    if (trailingBackslashes % 2 === 1) {
      current = current.slice(0, -1);
      continue;
    }
    logical.push({ text: current, line: startLine });
    current = '';
  }
  if (current.length > 0) logical.push({ text: current, line: startLine });
  return logical;
}

/** Parse the legacy Boot 1.x/2.x EnableAutoConfiguration factory entry. */
export function parseSpringFactoriesAutoConfigurations(
  content: string,
): SpringAutoConfigurationEntry[] {
  const entries: SpringAutoConfigurationEntry[] = [];
  const seen = new Set<string>();
  for (const logical of logicalFactoryLines(content)) {
    const trimmed = logical.text.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const separator = trimmed.search(/[:=]/);
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key !== ENABLE_AUTO_CONFIGURATION_KEY) continue;
    const value = trimmed
      .slice(separator + 1)
      .replace(/\s+#.*$/, '')
      .trim();
    for (const candidate of value.split(',')) {
      const className = candidate.trim();
      if (
        className.length === 0 ||
        seen.has(className) ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(className)
      ) {
        continue;
      }
      seen.add(className);
      entries.push({ className, line: logical.line });
    }
  }
  return entries;
}

function normalizedQualifiedName(value: string): string {
  return value.replaceAll('$', '.');
}

function simpleClassName(qualifiedName: string): string {
  const separator = Math.max(qualifiedName.lastIndexOf('.'), qualifiedName.lastIndexOf('$'));
  return separator === -1 ? qualifiedName : qualifiedName.slice(separator + 1);
}

function sourceClassIndexes(graph: PipelineContext['graph']): {
  readonly byQualifiedName: ReadonlyMap<string, readonly GraphNode[]>;
  readonly bySimpleName: ReadonlyMap<string, readonly GraphNode[]>;
} {
  const byQualifiedName = new Map<string, GraphNode[]>();
  const bySimpleName = new Map<string, GraphNode[]>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Class') continue;
    const qualifiedName =
      typeof node.properties.qualifiedName === 'string'
        ? normalizedQualifiedName(node.properties.qualifiedName)
        : undefined;
    if (qualifiedName !== undefined) {
      const qualified = byQualifiedName.get(qualifiedName) ?? [];
      qualified.push(node);
      byQualifiedName.set(qualifiedName, qualified);
    }
    const simple = String(node.properties.name);
    const candidates = bySimpleName.get(simple) ?? [];
    candidates.push(node);
    bySimpleName.set(simple, candidates);
  }
  return { byQualifiedName, bySimpleName };
}

function resolveOrCreateAutoConfigurationClass(
  ctx: PipelineContext,
  metadata: SpringAutoConfigurationMetadataFile,
  entry: SpringAutoConfigurationEntry,
  indexes: ReturnType<typeof sourceClassIndexes>,
): GraphNode {
  const qualifiedName = normalizedQualifiedName(entry.className);
  const exact = indexes.byQualifiedName.get(qualifiedName) ?? [];
  const [exactMatch] = exact;
  if (exact.length === 1 && exactMatch !== undefined) return exactMatch;

  const simpleMatches = indexes.bySimpleName.get(simpleClassName(entry.className)) ?? [];
  const [simpleMatch] = simpleMatches;
  if (simpleMatches.length === 1 && simpleMatch !== undefined) return simpleMatch;

  const nodeId = generateId(
    'Class',
    `spring-auto-configuration:${metadata.filePath}:${entry.className}`,
  );
  const syntheticClass: GraphNode = {
    id: nodeId,
    label: 'Class',
    properties: {
      name: simpleClassName(entry.className),
      qualifiedName: entry.className,
      filePath: metadata.filePath,
      startLine: entry.line,
      endLine: entry.line,
      description:
        'Spring Boot auto-configuration declared by metadata; implementation source unavailable',
    },
  };
  ctx.graph.addNode(syntheticClass);
  return syntheticClass;
}

export const springAutoConfigurationPhase: PipelinePhase<SpringAutoConfigurationOutput> = {
  name: 'springAutoConfiguration',
  deps: ['structure', 'scopeResolution'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<SpringAutoConfigurationOutput> {
    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    let indexes: ReturnType<typeof sourceClassIndexes> | undefined;
    let metadataFiles = 0;
    let autoConfigurations = 0;

    for (const scanned of scannedFiles) {
      const metadata = classifySpringAutoConfigurationMetadata(scanned.path);
      if (metadata === null || scanned.size > MAX_SPRING_METADATA_BYTES) continue;
      let content: string;
      try {
        content = await fs.readFile(path.join(ctx.repoPath, scanned.path), 'utf8');
      } catch {
        continue;
      }
      metadataFiles++;
      const entries =
        metadata.kind === 'imports'
          ? parseSpringAutoConfigurationImports(content)
          : parseSpringFactoriesAutoConfigurations(content);
      const fileId = generateId('File', metadata.filePath);
      if (ctx.graph.getNode(fileId) === undefined) continue;

      for (const entry of entries) {
        indexes ??= sourceClassIndexes(ctx.graph);
        const autoConfiguration = resolveOrCreateAutoConfigurationClass(
          ctx,
          metadata,
          entry,
          indexes,
        );
        ctx.graph.addRelationship({
          id: generateId(
            'AUTO_REGISTERS',
            `${fileId}->${autoConfiguration.id}:${metadata.kind}:${entry.className}`,
          ),
          sourceId: fileId,
          targetId: autoConfiguration.id,
          type: 'AUTO_REGISTERS',
          confidence: 1,
          reason:
            metadata.kind === 'imports'
              ? 'spring-auto-configuration:AutoConfiguration.imports'
              : 'spring-auto-configuration:spring.factories',
        });
        autoConfigurations++;
      }
    }

    return { metadataFiles, autoConfigurations };
  },
};
