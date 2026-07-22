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
import type { Event as YamlEvent } from 'js-yaml';
import { SPRING_CONFIG_DESCRIPTION } from '../frameworks/spring/config-bindings.js';
import { generateId } from '../../../lib/utils.js';
import type { PipelineContext, PipelinePhase, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as typeof import('js-yaml');
// js-yaml 5 dropped DEFAULT_SCHEMA; CORE plus these tags is what it used to be, so
// explicitly tagged values keep parsing instead of throwing (an unknown tag aborts
// the whole file). None of them can execute code.
const SPRING_YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(
  yaml.mergeTag,
  yaml.timestampTag,
  yaml.binaryTag,
  yaml.omapTag,
  yaml.pairsTag,
  yaml.setTag,
);
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
  readonly kind: 'scalar' | 'sequence' | 'mapping' | 'alias' | null;
  readonly result: unknown;
  readonly aliasOf: YamlParseEvent | undefined;
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

// Aliases are resolved to their anchor event by name while the tree is built,
// so following one here is a single pointer hop.
function resolveYamlAliasEvent(event: YamlParseEvent | undefined): YamlParseEvent | undefined {
  return event?.aliasOf ?? event;
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

/**
 * First match in a pre-order walk of `event`, following sequences and `<<` merge
 * chains. Iterative: children are pushed in reverse so the explicit stack pops
 * them in declaration order, which is what makes "first match" mean the same
 * thing it did when this recursed.
 */
function findYamlMappingLocation(
  event: YamlParseEvent | undefined,
  key: string,
  traversal: YamlTraversalState,
): YamlMappingLocation | undefined {
  const visited = new Set<YamlParseEvent>();
  const stack: Array<{ event: YamlParseEvent | undefined; depth: number }> = [{ event, depth: 0 }];

  while (stack.length > 0) {
    const step = stack.pop();
    if (step === undefined) break;
    consumeYamlTraversalBudget(traversal, step.depth);
    const resolved = resolveYamlAliasEvent(step.event);
    if (resolved === undefined || visited.has(resolved)) continue;
    visited.add(resolved);

    if (resolved.kind === 'sequence') {
      for (let index = resolved.children.length - 1; index >= 0; index--) {
        stack.push({ event: resolved.children[index], depth: step.depth + 1 });
      }
      continue;
    }
    if (resolved.kind !== 'mapping') continue;

    const pairs = yamlMappingPairs(resolved);
    const direct = pairs.find((pair) => pair.key === key);
    if (direct !== undefined) {
      return { valueEvent: direct.valueEvent, line: direct.keyEvent.startLine };
    }
    const merges = pairs.filter((pair) => pair.key === '<<');
    for (let index = merges.length - 1; index >= 0; index--) {
      stack.push({ event: merges[index].valueEvent, depth: step.depth + 1 });
    }
  }
  return undefined;
}

type YamlFlattenStep =
  | {
      readonly kind: 'visit';
      readonly value: unknown;
      readonly event: YamlParseEvent | undefined;
      readonly prefix: string;
      readonly sourceLine: number;
      readonly depth: number;
    }
  // Pops after every descendant of the object that pushed it, which is where the
  // recursive form's `finally` used to release the cycle guard.
  | { readonly kind: 'leave'; readonly object: object };

/**
 * Flatten a document to `dotted.key -> line`, iteratively. Children are pushed in
 * reverse so the stack pops them in declaration order, keeping `out` in the same
 * insertion order — and the traversal budget consumed in the same sequence — as
 * the recursive walk this replaced.
 */
function flattenYamlValue(
  value: unknown,
  event: YamlParseEvent | undefined,
  prefix: string,
  out: Map<string, number>,
  traversal: YamlTraversalState,
): void {
  const stack: YamlFlattenStep[] = [
    { kind: 'visit', value, event, prefix, sourceLine: event?.startLine ?? 1, depth: 0 },
  ];

  while (stack.length > 0) {
    const step = stack.pop();
    if (step === undefined) break;
    if (step.kind === 'leave') {
      traversal.activeObjects.delete(step.object);
      continue;
    }

    const { value: current, prefix: currentPrefix, sourceLine, depth } = step;
    consumeYamlTraversalBudget(traversal, depth);
    const resolvedEvent = resolveYamlAliasEvent(step.event);
    const trackedObject = isObjectValue(current) ? current : undefined;
    if (trackedObject !== undefined) {
      if (traversal.activeObjects.has(trackedObject)) continue;
      traversal.activeObjects.add(trackedObject);
      stack.push({ kind: 'leave', object: trackedObject });
    }

    if (Array.isArray(current)) {
      if (current.length === 0 && currentPrefix.length > 0 && !out.has(currentPrefix)) {
        out.set(currentPrefix, sourceLine);
      }
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push({
          kind: 'visit',
          value: current[index],
          event: resolvedEvent?.children[index],
          prefix: `${currentPrefix}[${index}]`,
          sourceLine,
          depth: depth + 1,
        });
      }
      continue;
    }

    if (
      current !== null &&
      typeof current === 'object' &&
      (resolvedEvent?.kind === 'mapping' || resolvedEvent === undefined)
    ) {
      // js-yaml 5 builds `!!set` as a native Set, whose members are not own
      // properties; v4 built a plain `{member: null}` object. Enumerate them so a
      // tagged set still contributes one key per member instead of a bare leaf.
      const entries: Array<[string, unknown]> =
        current instanceof Set
          ? [...current].map((member) => [String(member), null])
          : Object.entries(current as Record<string, unknown>);
      if (entries.length === 0 && currentPrefix.length > 0 && !out.has(currentPrefix)) {
        out.set(currentPrefix, sourceLine);
      }
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, nested] = entries[index];
        const location = findYamlMappingLocation(resolvedEvent, key, traversal);
        stack.push({
          kind: 'visit',
          value: nested,
          event: location?.valueEvent,
          prefix: currentPrefix.length === 0 ? key : `${currentPrefix}.${key}`,
          sourceLine: location?.line ?? sourceLine,
          depth: depth + 1,
        });
      }
      continue;
    }

    if (currentPrefix.length > 0 && !out.has(currentPrefix)) out.set(currentPrefix, sourceLine);
  }
}

// js-yaml 5 reports node positions as source offsets; map them to 1-based lines.
function makeLineResolver(source: string): (offset: number) => number {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') lineStarts.push(index + 1);
  }
  return (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    let line = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lineStarts[mid] <= offset) {
        line = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return line + 1;
  };
}

/**
 * Rebuild the parse tree from js-yaml 5's event stream (v4's `listener` option
 * was removed). Returns each document's root event, with aliases already
 * resolved to their anchor event so merged/aliased keys keep the line where
 * they were declared.
 *
 * One node per event, so this pass is bounded by MAX_CONFIG_FILE_BYTES alone —
 * MAX_YAML_TRAVERSAL_NODES governs the later walk, which can revisit a shared
 * anchor many times and so needs a budget this linear pass does not.
 */
function buildYamlEventTree(
  events: readonly YamlEvent[],
  source: string,
): Array<YamlParseEvent | undefined> {
  const lineOf = makeLineResolver(source);
  const anchors = new Map<string, YamlParseEvent>();
  const stack: YamlParseEvent[] = [];
  const documentRoots: Array<YamlParseEvent | undefined> = [];

  const anchorName = (start: number, end: number): string | null =>
    start >= 0 && end > start ? source.slice(start, end) : null;
  const attach = (node: YamlParseEvent): void => {
    stack[stack.length - 1]?.children.push(node);
  };
  const register = (name: string | null, node: YamlParseEvent): void => {
    if (name !== null) anchors.set(name, node);
  };

  for (const event of events) {
    switch (event.type) {
      case yaml.EVENT_DOCUMENT:
        // Anchors are document-scoped. constructFromEvents already rejects a
        // cross-document alias before we get here, so this only keeps the two
        // layers from disagreeing.
        anchors.clear();
        stack.push({
          startLine: 1,
          kind: null,
          result: undefined,
          aliasOf: undefined,
          children: [],
        });
        break;
      case yaml.EVENT_MAPPING:
      case yaml.EVENT_SEQUENCE: {
        const node: YamlParseEvent = {
          startLine: lineOf(event.start),
          kind: event.type === yaml.EVENT_MAPPING ? 'mapping' : 'sequence',
          result: undefined,
          aliasOf: undefined,
          children: [],
        };
        register(anchorName(event.anchorStart, event.anchorEnd), node);
        attach(node);
        stack.push(node);
        break;
      }
      case yaml.EVENT_SCALAR: {
        const node: YamlParseEvent = {
          startLine: lineOf(event.valueStart),
          kind: 'scalar',
          result: yaml.getScalarValue(source, event),
          aliasOf: undefined,
          children: [],
        };
        register(anchorName(event.anchorStart, event.anchorEnd), node);
        attach(node);
        break;
      }
      case yaml.EVENT_ALIAS: {
        const target = anchors.get(anchorName(event.anchorStart, event.anchorEnd) ?? '');
        attach({ startLine: 1, kind: 'alias', result: undefined, aliasOf: target, children: [] });
        break;
      }
      case yaml.EVENT_POP: {
        const done = stack.pop();
        // Documents are the only top-level containers, so a pop that empties the
        // stack closes a document; its single child is the document's root value.
        if (done !== undefined && stack.length === 0) documentRoots.push(done.children[0]);
        break;
      }
    }
  }
  return documentRoots;
}

/** Parse and flatten YAML leaves without retaining their values. */
export function parseSpringYaml(
  content: string,
  filePath: string,
  profile?: string,
): SpringConfigKey[] {
  const flattened = new Map<string, number>();
  const traversal: YamlTraversalState = {
    remainingNodes: MAX_YAML_TRAVERSAL_NODES,
    activeObjects: new Set<object>(),
  };

  const events = yaml.parseEvents(content, { maxDepth: MAX_YAML_TRAVERSAL_DEPTH });
  const documents = yaml.constructFromEvents(events, {
    source: content,
    schema: SPRING_YAML_SCHEMA,
    json: true,
  });
  const documentEvents = buildYamlEventTree(events, content);

  documents.forEach((document, index) =>
    flattenYamlValue(document, documentEvents[index], '', flattened, traversal),
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
