/**
 * Phase: springConfig
 *
 * Adds key-only nodes for statically readable Spring
 * `application*.properties` / `application*.yml` / `application*.yaml` files.
 * Language-specific ScopeResolver hooks attach consumers later. Configuration
 * values are deliberately never copied into the graph because they may contain
 * credentials and key identity is sufficient for impact analysis.
 *
 * @deps    structure
 * @reads   Spring application configuration files
 * @writes  Property nodes and DEFINES edges
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { EventType as YamlEventType, State as YamlState } from 'js-yaml';
import { SPRING_CONFIG_DESCRIPTION } from '../frameworks/spring/config-bindings.js';
import { generateId } from '../../../lib/utils.js';
import type { PipelineContext, PipelinePhase, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as typeof import('js-yaml');
const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_YAML_TRAVERSAL_DEPTH = 128;
const MAX_YAML_TRAVERSAL_NODES = 100_000;

export interface SpringConfigKey {
  readonly key: string;
  readonly filePath: string;
  readonly line: number;
  readonly profile?: string;
  readonly format: 'properties' | 'yaml';
}

interface SpringConfigFile {
  readonly filePath: string;
  readonly profile?: string;
  readonly format: SpringConfigKey['format'];
}

export interface SpringConfigOutput {
  readonly configKeys: number;
}

/** Match only Spring Boot's conventional application config file names. */
export function classifySpringConfigFile(filePath: string): SpringConfigFile | null {
  const base = path.posix.basename(filePath.replaceAll('\\', '/'));
  const match = /^application(?:-([^.]+))?\.(properties|ya?ml)$/i.exec(base);
  if (match === null) return null;
  return {
    filePath,
    ...(match[1] ? { profile: match[1] } : {}),
    format: match[2].toLowerCase() === 'properties' ? 'properties' : 'yaml',
  };
}

function unescapePropertyKey(raw: string): string {
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\([:=#!\\ ])/g, '$1');
}

function logicalPropertiesLines(content: string): Array<{ text: string; line: number }> {
  const physical = content.split(/\r?\n/);
  const logical: Array<{ text: string; line: number }> = [];
  let current = '';
  let startLine = 1;

  for (let index = 0; index < physical.length; index++) {
    const line = physical[index];
    if (current.length === 0) startLine = index + 1;
    current += current.length === 0 ? line : line.trimStart();

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

/** Parse `.properties` keys without retaining their values. */
export function parseSpringProperties(
  content: string,
  filePath: string,
  profile?: string,
): SpringConfigKey[] {
  const keys: SpringConfigKey[] = [];
  const seen = new Set<string>();

  for (const logical of logicalPropertiesLines(content)) {
    const trimmed = logical.text.trimStart();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;

    let separator = -1;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index++) {
      const char = trimmed[index];
      if (!escaped && (char === '=' || char === ':' || /\s/.test(char))) {
        separator = index;
        break;
      }
      escaped = !escaped && char === '\\';
      if (char !== '\\') escaped = false;
    }
    const rawKey = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    const key = unescapePropertyKey(rawKey);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push({
      key,
      filePath,
      line: logical.line,
      ...(profile ? { profile } : {}),
      format: 'properties',
    });
  }

  return keys;
}

interface YamlParseEvent {
  readonly startLine: number;
  kind: string | null;
  result: unknown;
  tag: string | null;
  readonly children: YamlParseEvent[];
}

interface YamlMappingLocation {
  readonly valueEvent: YamlParseEvent;
  readonly line: number;
}

interface YamlTraversalState {
  remainingNodes: number;
  readonly activeObjects: Set<object>;
}

function consumeYamlTraversalBudget(state: YamlTraversalState, depth: number): void {
  if (depth > MAX_YAML_TRAVERSAL_DEPTH) {
    throw new Error(`Spring YAML traversal depth exceeds ${MAX_YAML_TRAVERSAL_DEPTH}`);
  }
  state.remainingNodes--;
  if (state.remainingNodes < 0) {
    throw new Error(`Spring YAML traversal exceeds ${MAX_YAML_TRAVERSAL_NODES} nodes`);
  }
}

function isObjectValue(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function resolveYamlAliasEvent(
  event: YamlParseEvent | undefined,
  objectEvents: WeakMap<object, YamlParseEvent>,
): YamlParseEvent | undefined {
  if (event?.kind !== null || !isObjectValue(event.result)) return event;
  return objectEvents.get(event.result) ?? event;
}

function yamlMappingPairs(event: YamlParseEvent): Array<{
  key: string;
  keyEvent: YamlParseEvent;
  valueEvent: YamlParseEvent;
}> {
  const pairs: Array<{ key: string; keyEvent: YamlParseEvent; valueEvent: YamlParseEvent }> = [];
  for (let index = 0; index + 1 < event.children.length; index += 2) {
    const keyEvent = event.children[index];
    const valueEvent = event.children[index + 1];
    if (keyEvent.kind !== 'scalar') continue;
    pairs.push({ key: String(keyEvent.result), keyEvent, valueEvent });
  }
  return pairs;
}

function findYamlMappingLocation(
  event: YamlParseEvent | undefined,
  key: string,
  objectEvents: WeakMap<object, YamlParseEvent>,
  traversal: YamlTraversalState,
  visited = new Set<YamlParseEvent>(),
  depth = 0,
): YamlMappingLocation | undefined {
  consumeYamlTraversalBudget(traversal, depth);
  const resolved = resolveYamlAliasEvent(event, objectEvents);
  if (resolved === undefined || visited.has(resolved)) return undefined;
  visited.add(resolved);

  if (resolved.kind === 'sequence') {
    for (const child of resolved.children) {
      const found = findYamlMappingLocation(
        child,
        key,
        objectEvents,
        traversal,
        visited,
        depth + 1,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (resolved.kind !== 'mapping') return undefined;

  const pairs = yamlMappingPairs(resolved);
  const direct = pairs.find((pair) => pair.key === key);
  if (direct !== undefined) {
    return { valueEvent: direct.valueEvent, line: direct.keyEvent.startLine };
  }
  for (const merge of pairs.filter((pair) => pair.key === '<<')) {
    const found = findYamlMappingLocation(
      merge.valueEvent,
      key,
      objectEvents,
      traversal,
      visited,
      depth + 1,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

function flattenYamlValue(
  value: unknown,
  event: YamlParseEvent | undefined,
  prefix: string,
  out: Map<string, number>,
  objectEvents: WeakMap<object, YamlParseEvent>,
  traversal: YamlTraversalState,
  sourceLine = event?.startLine ?? 1,
  depth = 0,
): void {
  consumeYamlTraversalBudget(traversal, depth);
  const resolvedEvent = resolveYamlAliasEvent(event, objectEvents);
  const trackedObject = isObjectValue(value) ? value : undefined;
  if (trackedObject !== undefined && traversal.activeObjects.has(trackedObject)) return;
  if (trackedObject !== undefined) traversal.activeObjects.add(trackedObject);
  try {
    if (Array.isArray(value)) {
      if (value.length === 0 && prefix.length > 0 && !out.has(prefix)) out.set(prefix, sourceLine);
      value.forEach((item, index) =>
        flattenYamlValue(
          item,
          resolvedEvent?.children[index],
          `${prefix}[${index}]`,
          out,
          objectEvents,
          traversal,
          sourceLine,
          depth + 1,
        ),
      );
      return;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      (resolvedEvent?.kind === 'mapping' || resolvedEvent === undefined)
    ) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0 && prefix.length > 0 && !out.has(prefix))
        out.set(prefix, sourceLine);
      for (const [key, nested] of entries) {
        const next = prefix.length === 0 ? key : `${prefix}.${key}`;
        const location = findYamlMappingLocation(resolvedEvent, key, objectEvents, traversal);
        flattenYamlValue(
          nested,
          location?.valueEvent,
          next,
          out,
          objectEvents,
          traversal,
          location?.line ?? sourceLine,
          depth + 1,
        );
      }
      return;
    }
    if (prefix.length > 0 && !out.has(prefix)) out.set(prefix, sourceLine);
  } finally {
    if (trackedObject !== undefined) traversal.activeObjects.delete(trackedObject);
  }
}

/** Parse and flatten YAML leaves without retaining their values. */
export function parseSpringYaml(
  content: string,
  filePath: string,
  profile?: string,
): SpringConfigKey[] {
  const flattened = new Map<string, number>();
  const eventStack: YamlParseEvent[] = [];
  const documentEvents: YamlParseEvent[] = [];
  const objectEvents = new WeakMap<object, YamlParseEvent>();
  const documents: unknown[] = [];
  const traversal: YamlTraversalState = {
    remainingNodes: MAX_YAML_TRAVERSAL_NODES,
    activeObjects: new Set<object>(),
  };

  yaml.loadAll(content, (document) => documents.push(document), {
    schema: yaml.DEFAULT_SCHEMA,
    json: true,
    listener: (eventType: YamlEventType, state: YamlState) => {
      if (eventType === 'open') {
        eventStack.push({
          startLine: state.line + 1,
          kind: null,
          result: undefined,
          tag: null,
          children: [],
        });
        return;
      }

      const event = eventStack.pop();
      if (event === undefined) return;
      event.kind = state.kind ?? null;
      event.result = state.result;
      event.tag = (state as YamlState & { tag?: string | null }).tag ?? null;
      if (isObjectValue(event.result) && event.kind !== null) {
        objectEvents.set(event.result, event);
      }
      const parent = eventStack[eventStack.length - 1];
      if (parent === undefined) documentEvents.push(event);
      else parent.children.push(event);
    },
  });

  documents.forEach((document, index) =>
    flattenYamlValue(document, documentEvents[index], '', flattened, objectEvents, traversal),
  );
  return [...flattened.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, line]) => ({
      key,
      filePath,
      line,
      ...(profile ? { profile } : {}),
      format: 'yaml' as const,
    }));
}

function configKeyNodeId(entry: SpringConfigKey): string {
  return generateId('Property', `spring-config:${entry.filePath}:${entry.key}`);
}

async function readConfigKeys(
  repoPath: string,
  scannedFiles: StructureOutput['scannedFiles'],
): Promise<SpringConfigKey[]> {
  const keys: SpringConfigKey[] = [];
  for (const scanned of scannedFiles) {
    const classified = classifySpringConfigFile(scanned.path);
    if (classified === null || scanned.size > MAX_CONFIG_FILE_BYTES) continue;
    try {
      const content = await fs.readFile(path.join(repoPath, scanned.path), 'utf8');
      keys.push(
        ...(classified.format === 'properties'
          ? parseSpringProperties(content, classified.filePath, classified.profile)
          : parseSpringYaml(content, classified.filePath, classified.profile)),
      );
    } catch {
      // Malformed configuration is not a reason to fail the entire code index.
      // Fail closed: no keys and therefore no misleading bindings for this file.
    }
  }
  return keys;
}

export const springConfigPhase: PipelinePhase<SpringConfigOutput> = {
  name: 'springConfig',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<SpringConfigOutput> {
    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    const configKeys = await readConfigKeys(ctx.repoPath, scannedFiles);
    for (const entry of configKeys) {
      const nodeId = configKeyNodeId(entry);
      ctx.graph.addNode({
        id: nodeId,
        label: 'Property',
        properties: {
          name: entry.key,
          filePath: entry.filePath,
          startLine: entry.line,
          endLine: entry.line,
          description: entry.profile
            ? `${SPRING_CONFIG_DESCRIPTION} (profile: ${entry.profile})`
            : SPRING_CONFIG_DESCRIPTION,
        },
      });
      const fileId = generateId('File', entry.filePath);
      if (ctx.graph.getNode(fileId) !== undefined) {
        ctx.graph.addRelationship({
          id: generateId('DEFINES', `${fileId}->${nodeId}`),
          sourceId: fileId,
          targetId: nodeId,
          type: 'DEFINES',
          confidence: 1,
          reason: 'spring-config:key',
        });
      }
    }

    return { configKeys: configKeys.length };
  },
};
