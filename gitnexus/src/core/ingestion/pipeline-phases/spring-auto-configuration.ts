/**
 * Phase: springAutoConfiguration
 *
 * Discovers Spring Boot auto-configuration declarations from repository
 * metadata after source symbols have been resolved. Metadata-backed classes
 * are linked through DECLARES; when source is unavailable, a lightweight
 * synthetic Class preserves the third-party/starter contribution.
 *
 * @deps    structure, scopeResolution
 * @reads   META-INF/spring.factories and AutoConfiguration.imports
 * @writes  Class nodes and DECLARES edges
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { generateId } from '../../../lib/utils.js';
import { logger } from '../../logger.js';
import {
  SPRING_AUTO_CONFIGURATION_FACTORY_REASON,
  SPRING_AUTO_CONFIGURATION_IMPORT_REASON,
  SPRING_AUTO_CONFIGURATION_SYNTHETIC_DESCRIPTION,
} from '../frameworks/spring/auto-configuration.js';
import {
  importSpringActuatorRuntime,
  MAX_RUNTIME_RECORDS,
  type SpringActuatorImportStats,
} from '../frameworks/spring/actuator-runtime.js';
import { isDev } from '../utils/env.js';
import type { StructureOutput } from './structure.js';
import type { PipelineContext, PipelinePhase, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';

const MAX_SPRING_METADATA_BYTES = 2 * 1024 * 1024;
const ENABLE_AUTO_CONFIGURATION_KEY =
  'org.springframework.boot.autoconfigure.EnableAutoConfiguration';
const AUTO_CONFIGURATION_IMPORTS =
  'META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports';
const SPRING_FACTORIES = 'META-INF/spring.factories';
const AUTO_CONFIGURATION_IMPORTS_LOWER = AUTO_CONFIGURATION_IMPORTS.toLowerCase();
const SPRING_FACTORIES_LOWER = SPRING_FACTORIES.toLowerCase();

/**
 * Case-insensitive ASCII path-suffix match without allocating a normalized or
 * lower-cased copy of every scanned path. Spring metadata suffixes are ASCII;
 * both POSIX and Windows separators are accepted.
 */
function hasPathSuffix(filePath: string, suffix: string): boolean {
  let fileCursor = filePath.length - 1;
  for (let suffixCursor = suffix.length - 1; suffixCursor >= 0; suffixCursor--, fileCursor--) {
    if (fileCursor < 0) return false;
    const expected = suffix.charCodeAt(suffixCursor);
    const actual = filePath.charCodeAt(fileCursor);
    if (expected === 47) {
      if (actual !== 47 && actual !== 92) return false;
      continue;
    }
    const lowerActual = actual >= 65 && actual <= 90 ? actual + 32 : actual;
    if (lowerActual !== expected) return false;
  }
  if (fileCursor < 0) return true;
  const boundary = filePath.charCodeAt(fileCursor);
  return boundary === 47 || boundary === 92;
}

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
  readonly ambiguousAutoConfigurations: number;
  readonly actuatorRuntime?: SpringActuatorImportStats;
}

export function classifySpringAutoConfigurationMetadata(
  filePath: string,
): SpringAutoConfigurationMetadataFile | null {
  if (hasPathSuffix(filePath, AUTO_CONFIGURATION_IMPORTS_LOWER)) {
    return { filePath, kind: 'imports' };
  }
  if (hasPathSuffix(filePath, SPRING_FACTORIES_LOWER)) {
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

function sourceClassIndexes(
  graph: PipelineContext['graph'],
): ReadonlyMap<string, GraphNode | null> {
  const byQualifiedName = new Map<string, GraphNode | null>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Class') continue;
    const qualifiedName =
      typeof node.properties.qualifiedName === 'string'
        ? normalizedQualifiedName(node.properties.qualifiedName)
        : undefined;
    if (qualifiedName !== undefined) {
      const existing = byQualifiedName.get(qualifiedName);
      if (existing === undefined) {
        byQualifiedName.set(qualifiedName, node);
      } else if (existing !== null) {
        // Only uniqueness matters. A null sentinel avoids retaining an array of
        // every duplicate while preserving fail-closed ambiguity semantics.
        byQualifiedName.set(qualifiedName, null);
      }
    }
  }
  return byQualifiedName;
}

function resolveOrCreateAutoConfigurationClass(
  ctx: PipelineContext,
  metadata: SpringAutoConfigurationMetadataFile,
  qualifiedName: string,
  line: number,
  classesByQualifiedName: ReturnType<typeof sourceClassIndexes>,
): GraphNode | undefined {
  const exact = classesByQualifiedName.get(qualifiedName);
  if (exact !== null && exact !== undefined) return exact;
  // The runtime classpath chooses one of duplicate FQNs. GitNexus has no
  // reliable module/classpath precedence here, so fail closed instead of
  // guessing, fanning out, or fabricating a third candidate.
  if (exact === null) return undefined;

  const nodeId = generateId('Class', `spring-auto-configuration:${qualifiedName}`);
  const syntheticClass: GraphNode = {
    id: nodeId,
    label: 'Class',
    properties: {
      name: simpleClassName(qualifiedName),
      qualifiedName,
      filePath: metadata.filePath,
      startLine: line,
      endLine: line,
      description: SPRING_AUTO_CONFIGURATION_SYNTHETIC_DESCRIPTION,
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
    let classesByQualifiedName: ReturnType<typeof sourceClassIndexes> | undefined;
    const resolutions = new Map<string, GraphNode | null>();
    const ambiguousQualifiedNames = new Set<string>();
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
      const declaredQualifiedNames = new Set<string>();

      for (const entry of entries) {
        const qualifiedName = normalizedQualifiedName(entry.className);
        if (declaredQualifiedNames.has(qualifiedName)) continue;
        declaredQualifiedNames.add(qualifiedName);
        let autoConfiguration = resolutions.get(qualifiedName);
        if (autoConfiguration === undefined) {
          classesByQualifiedName ??= sourceClassIndexes(ctx.graph);
          autoConfiguration =
            resolveOrCreateAutoConfigurationClass(
              ctx,
              metadata,
              qualifiedName,
              entry.line,
              classesByQualifiedName,
            ) ?? null;
          resolutions.set(qualifiedName, autoConfiguration);
        }
        if (autoConfiguration === null) {
          ambiguousQualifiedNames.add(qualifiedName);
          continue;
        }
        ctx.graph.addRelationship({
          id: generateId(
            'DECLARES',
            `${fileId}->${autoConfiguration.id}:${metadata.kind}:${entry.className}`,
          ),
          sourceId: fileId,
          targetId: autoConfiguration.id,
          type: 'DECLARES',
          confidence: 1,
          reason:
            metadata.kind === 'imports'
              ? SPRING_AUTO_CONFIGURATION_IMPORT_REASON
              : SPRING_AUTO_CONFIGURATION_FACTORY_REASON,
        });
        autoConfigurations++;
      }
    }

    if (isDev && ambiguousQualifiedNames.size > 0) {
      logger.debug(
        `Spring auto-configuration: skipped ${ambiguousQualifiedNames.size} ambiguous FQN(s) ` +
          `because classpath precedence is unknown: ${[...ambiguousQualifiedNames].sort().join(', ')}`,
      );
    }

    const actuatorRuntime =
      ctx.options?.springActuatorPath === undefined
        ? undefined
        : await importSpringActuatorRuntime(
            ctx.graph,
            ctx.repoPath,
            ctx.options.springActuatorPath,
          );
    if (actuatorRuntime !== undefined && actuatorRuntime.truncatedEndpoints.length > 0) {
      logger.warn(
        `Spring Actuator runtime import reached the ${MAX_RUNTIME_RECORDS.toLocaleString('en-US')}-record limit for: ${actuatorRuntime.truncatedEndpoints.join(', ')}. Runtime evidence is incomplete.`,
      );
    }

    return {
      metadataFiles,
      autoConfigurations,
      ambiguousAutoConfigurations: ambiguousQualifiedNames.size,
      ...(actuatorRuntime === undefined ? {} : { actuatorRuntime }),
    };
  },
};
