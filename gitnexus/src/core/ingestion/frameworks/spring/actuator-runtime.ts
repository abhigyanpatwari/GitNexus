import fs from 'node:fs/promises';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { SPRING_DI_PROVIDER_PROPERTY } from '../../di-extractors/spring.js';
import {
  normalizeExtractedRoutePath,
  normalizeRouteMethod,
  routeNodeKey,
} from '../../route-extractors/route-path.js';
import { stripBidiAndZeroWidth } from '../../utils/ast-helpers.js';
import { SPRING_CONFIG_DESCRIPTION } from './config-bindings.js';
import { getProviderForFile } from '../../languages/index.js';
import type { RuntimeCallableIdentity } from '../../language-provider.js';

const ACTUATOR_ENDPOINTS = ['mappings', 'beans', 'conditions', 'configprops', 'env'] as const;
type ActuatorEndpoint = (typeof ACTUATOR_ENDPOINTS)[number];

const MAX_ACTUATOR_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_RECORDS = 50_000;
const MAX_RUNTIME_DEPTH = 64;
const RUNTIME_FILE_PREFIX = 'spring-actuator:';

type JsonObject = Record<string, unknown>;

export interface SpringActuatorImportStats {
  readonly payloads: number;
  readonly mappings: number;
  readonly beans: number;
  readonly conditions: number;
  readonly configProperties: number;
  readonly environmentProperties: number;
}

interface MutableImportStats {
  payloads: number;
  mappings: number;
  beans: number;
  conditions: number;
  configProperties: number;
  environmentProperties: number;
}

export class SpringActuatorImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpringActuatorImportError';
  }
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function safeText(value: unknown, maxLength = 1024): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = stripBidiAndZeroWidth(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length === 0 ? undefined : sanitized.slice(0, maxLength);
}

function safeStrings(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) return [];
  const strings: string[] = [];
  for (const item of value.slice(0, limit)) {
    const text = safeText(item);
    if (text !== undefined) strings.push(text);
  }
  return strings;
}

async function readPayloadFile(filePath: string, label: string): Promise<JsonObject> {
  // Size gate and read share one handle so both observe the same inode.
  // Re-resolving the path for the read would let a swapped file bypass the
  // payload cap (CodeQL js/file-system-race).
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let raw: string;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SpringActuatorImportError(`Spring Actuator ${label} input must be a JSON file.`);
    }
    if (stat.size > MAX_ACTUATOR_PAYLOAD_BYTES) {
      throw new SpringActuatorImportError(
        `Spring Actuator ${label} payload exceeds the ${MAX_ACTUATOR_PAYLOAD_BYTES / 1024 / 1024} MiB limit.`,
      );
    }
    const buffer = Buffer.alloc(MAX_ACTUATOR_PAYLOAD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ACTUATOR_PAYLOAD_BYTES) {
      throw new SpringActuatorImportError(
        `Spring Actuator ${label} payload exceeds the ${MAX_ACTUATOR_PAYLOAD_BYTES / 1024 / 1024} MiB limit.`,
      );
    }
    raw = buffer.subarray(0, bytesRead).toString('utf8');
  } catch (err) {
    if (err instanceof SpringActuatorImportError) throw err;
    throw new SpringActuatorImportError(`Spring Actuator ${label} input could not be read.`);
  } finally {
    await handle?.close().catch(() => {});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do not include JSON.parse's message: newer runtimes may quote source text,
    // which could disclose an env/configprops value in CLI output.
    throw new SpringActuatorImportError(`Spring Actuator ${label} payload is not valid JSON.`);
  }
  const object = objectValue(parsed);
  if (object === undefined) {
    throw new SpringActuatorImportError(`Spring Actuator ${label} payload must be a JSON object.`);
  }
  return object;
}

async function loadPayloads(
  repoPath: string,
  configuredPath: string,
): Promise<Map<ActuatorEndpoint, JsonObject>> {
  const inputPath = path.resolve(repoPath, configuredPath);
  let stat;
  try {
    stat = await fs.stat(inputPath);
  } catch {
    throw new SpringActuatorImportError(
      'Spring Actuator input path does not exist or is unreadable.',
    );
  }

  const payloads = new Map<ActuatorEndpoint, JsonObject>();
  if (stat.isDirectory()) {
    for (const endpoint of ACTUATOR_ENDPOINTS) {
      const filePath = path.join(inputPath, `${endpoint}.json`);
      try {
        const endpointStat = await fs.stat(filePath);
        if (!endpointStat.isFile()) continue;
      } catch {
        continue;
      }
      payloads.set(endpoint, await readPayloadFile(filePath, endpoint));
    }
  } else if (stat.isFile()) {
    const parsed = await readPayloadFile(inputPath, 'bundle');
    const endpointFromName = ACTUATOR_ENDPOINTS.find(
      (endpoint) => path.basename(inputPath).toLowerCase() === `${endpoint}.json`,
    );
    if (endpointFromName !== undefined) {
      payloads.set(endpointFromName, parsed);
    } else {
      for (const endpoint of ACTUATOR_ENDPOINTS) {
        const payload = objectValue(parsed[endpoint]);
        if (payload !== undefined) payloads.set(endpoint, payload);
      }
    }
  } else {
    throw new SpringActuatorImportError(
      'Spring Actuator input must be a JSON bundle or a directory of endpoint JSON files.',
    );
  }

  if (payloads.size === 0) {
    throw new SpringActuatorImportError(
      'Spring Actuator input contains none of mappings, beans, conditions, configprops, or env.',
    );
  }
  return payloads;
}

function evidenceFile(graph: KnowledgeGraph, endpoint: ActuatorEndpoint): GraphNode {
  const filePath = `${RUNTIME_FILE_PREFIX}${endpoint}`;
  const id = generateId('File', filePath);
  const existing = graph.getNode(id);
  if (existing !== undefined) return existing;
  const node: GraphNode = {
    id,
    label: 'File',
    properties: { name: `${endpoint}.json`, filePath },
  };
  graph.addNode(node);
  return node;
}

function appendRuntimeMarker(node: GraphNode, marker: string): void {
  const current =
    typeof node.properties.description === 'string' ? node.properties.description : '';
  if (current.includes(marker)) return;
  node.properties.description = current.length === 0 ? marker : `${current}; ${marker}`;
}

function markRuntimeEvidence(
  graph: KnowledgeGraph,
  endpoint: ActuatorEndpoint,
  target: GraphNode,
  status: string = 'runtime-confirmed',
  confirmed: boolean = true,
): void {
  // Only Route declares structured runtime columns in the persisted schema.
  // Other labels retain the same evidence durably through their description
  // plus the DECLARES edge below; setting undeclared properties would make the
  // in-memory graph promise data that CSV/LadybugDB silently drops.
  if (target.label === 'Route') {
    target.properties.runtimeConfirmed = confirmed;
    target.properties.runtimeSource = 'spring-actuator';
    const previousStatus = safeText(target.properties.runtimeStatus);
    target.properties.runtimeStatus =
      previousStatus === undefined || previousStatus === status
        ? status
        : [previousStatus, status].sort().join(',');
  }
  const marker = `Spring Actuator ${endpoint} ${status}`;
  appendRuntimeMarker(target, marker);

  const evidence = evidenceFile(graph, endpoint);
  graph.addRelationship({
    id: generateId('DECLARES', `${evidence.id}->${target.id}:${status}`),
    sourceId: evidence.id,
    targetId: target.id,
    type: 'DECLARES',
    confidence: 1,
    reason: `spring-actuator:${endpoint}:${status}`,
  });
}

function normalizedQualifiedName(value: string): string {
  return value
    .replace(/\$\$(?:SpringCGLIB|EnhancerBySpringCGLIB|FastClassBySpringCGLIB).*$/, '')
    .replaceAll('$', '.');
}

function uniqueIndexAdd(index: Map<string, GraphNode | null>, key: string, node: GraphNode): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, node);
  else if (existing !== null && existing.id !== node.id) index.set(key, null);
}

interface RuntimeNodeIndexes {
  readonly classesByQualifiedName: Map<string, GraphNode | null>;
  readonly classesByRuntimeAlias: Map<string, GraphNode | null>;
  readonly classesBySimpleName: Map<string, GraphNode | null>;
  readonly beanProvidersByName: Map<string, GraphNode | null>;
  readonly methodsByOwnerId: Map<string, GraphNode[]>;
  readonly callablesByRuntimeOwner: Map<string, GraphNode[]>;
  readonly routeOwnerFileIdsByRouteId: Map<string, Set<string>>;
}

function addRuntimeCallable(
  index: Map<string, GraphNode[]>,
  ownerName: string,
  node: GraphNode,
): void {
  const normalizedOwner = normalizedQualifiedName(ownerName);
  const nodes = index.get(normalizedOwner) ?? [];
  if (!nodes.some((candidate) => candidate.id === node.id)) nodes.push(node);
  index.set(normalizedOwner, nodes);
}

function buildRuntimeNodeIndexes(graph: KnowledgeGraph): RuntimeNodeIndexes {
  const allNodes = [...graph.iterNodes()];
  const classesByQualifiedName = new Map<string, GraphNode | null>();
  const classesByRuntimeAlias = new Map<string, GraphNode | null>();
  const classesBySimpleName = new Map<string, GraphNode | null>();
  const beanProvidersByName = new Map<string, GraphNode | null>();
  const nodesById = new Map(allNodes.map((node) => [node.id, node]));
  const methodsByOwnerId = new Map<string, GraphNode[]>();
  const callablesByRuntimeOwner = new Map<string, GraphNode[]>();
  const routeOwnerFileIdsByRouteId = new Map<string, Set<string>>();
  for (const node of allNodes) {
    if (node.label === 'Class' || node.label === 'Record') {
      const qualified = safeText(node.properties.qualifiedName);
      if (qualified !== undefined) {
        uniqueIndexAdd(classesByQualifiedName, normalizedQualifiedName(qualified), node);
      }
      uniqueIndexAdd(classesBySimpleName, String(node.properties.name), node);
    }
    const provider = objectValue(node.properties[SPRING_DI_PROVIDER_PROPERTY]);
    for (const name of safeStrings(provider?.names))
      uniqueIndexAdd(beanProvidersByName, name, node);
  }
  const ownedNodeIds = new Set<string>();
  for (const relationshipType of ['HAS_METHOD', 'HAS_PROPERTY'] as const) {
    for (const relationship of graph.iterRelationshipsByType(relationshipType)) {
      const member = nodesById.get(relationship.targetId);
      const owner = nodesById.get(relationship.sourceId);
      if (
        member === undefined ||
        !['Method', 'Function', 'Property'].includes(member.label) ||
        owner === undefined
      ) {
        continue;
      }
      ownedNodeIds.add(member.id);
      if (member.label === 'Method' || member.label === 'Function') {
        const methods = methodsByOwnerId.get(relationship.sourceId) ?? [];
        methods.push(member);
        methodsByOwnerId.set(relationship.sourceId, methods);
      }
      const ownerQualifiedName = safeText(owner.properties.qualifiedName);
      if (ownerQualifiedName !== undefined) {
        addRuntimeCallable(callablesByRuntimeOwner, ownerQualifiedName, member);
      }
      const strategy = getProviderForFile(
        String(member.properties.filePath),
      )?.runtimeSymbolStrategy;
      for (const alias of strategy?.callableOwnerAliases?.(member, owner) ?? []) {
        addRuntimeCallable(callablesByRuntimeOwner, alias, member);
        if (
          (owner.label === 'Class' || owner.label === 'Record') &&
          ownerQualifiedName !== undefined &&
          normalizedQualifiedName(alias) !== normalizedQualifiedName(ownerQualifiedName)
        ) {
          uniqueIndexAdd(classesByRuntimeAlias, normalizedQualifiedName(alias), owner);
        }
      }
    }
  }
  for (const node of allNodes) {
    if (
      ownedNodeIds.has(node.id) ||
      (node.label !== 'Function' && node.label !== 'Method' && node.label !== 'Property')
    ) {
      continue;
    }
    const strategy = getProviderForFile(String(node.properties.filePath))?.runtimeSymbolStrategy;
    for (const alias of strategy?.callableOwnerAliases?.(node, undefined) ?? []) {
      addRuntimeCallable(callablesByRuntimeOwner, alias, node);
    }
  }
  for (const relationship of graph.iterRelationshipsByType('HANDLES_ROUTE')) {
    const owners = routeOwnerFileIdsByRouteId.get(relationship.targetId) ?? new Set<string>();
    owners.add(relationship.sourceId);
    routeOwnerFileIdsByRouteId.set(relationship.targetId, owners);
  }
  return {
    classesByQualifiedName,
    classesByRuntimeAlias,
    classesBySimpleName,
    beanProvidersByName,
    methodsByOwnerId,
    callablesByRuntimeOwner,
    routeOwnerFileIdsByRouteId,
  };
}

function resolveClass(
  indexes: RuntimeNodeIndexes,
  rawType: string | undefined,
): GraphNode | undefined {
  if (rawType === undefined) return undefined;
  const type = normalizedQualifiedName(rawType.replace(/\[\]$/, ''));
  const exact = indexes.classesByQualifiedName.get(type);
  if (exact !== null && exact !== undefined) return exact;
  const alias = indexes.classesByRuntimeAlias.get(type);
  if (alias !== null && alias !== undefined) return alias;
  // A qualified runtime name is authoritative. Falling back to a unique class
  // with the same simple name can bind a stale snapshot to a different package
  // and then mint confidence-1 handler evidence for the wrong source.
  if (type.includes('.')) return undefined;
  const simple = type.slice(type.lastIndexOf('.') + 1);
  const fallback = indexes.classesBySimpleName.get(simple);
  return fallback === null ? undefined : fallback;
}

function providerMatchesRuntimeType(
  indexes: RuntimeNodeIndexes,
  providerNode: GraphNode,
  runtimeType: string | undefined,
): boolean {
  if (runtimeType === undefined) return true;
  const provider = objectValue(providerNode.properties[SPRING_DI_PROVIDER_PROPERTY]);
  const providerType =
    safeText(provider?.providedTypeName) ??
    (providerNode.label === 'Class' || providerNode.label === 'Record'
      ? safeText(providerNode.properties.qualifiedName)
      : undefined);
  if (providerType === undefined) return true;

  const providerClass = resolveClass(indexes, providerType);
  const runtimeClass = resolveClass(indexes, runtimeType);
  if (providerClass !== undefined && runtimeClass !== undefined) {
    return providerClass.id === runtimeClass.id;
  }

  const normalizedProvider = normalizedQualifiedName(providerType);
  const normalizedRuntime = normalizedQualifiedName(runtimeType);
  if (normalizedProvider.includes('.')) return normalizedProvider === normalizedRuntime;
  return normalizedProvider === normalizedRuntime.slice(normalizedRuntime.lastIndexOf('.') + 1);
}

function descriptorParameterTypes(descriptor: string | undefined): string[] | undefined {
  if (descriptor === undefined || descriptor.charAt(0) !== '(') return undefined;
  const types: string[] = [];
  for (let index = 1; index < descriptor.length && descriptor.charAt(index) !== ')'; ) {
    while (descriptor.charAt(index) === '[') index++;
    if (descriptor.charAt(index) === 'L') {
      const end = descriptor.indexOf(';', index);
      if (end === -1) return undefined;
      types.push(descriptor.slice(index + 1, end));
      index = end + 1;
    } else {
      const primitive = descriptor.charAt(index);
      if (!'BCDFIJSZ'.includes(primitive)) return undefined;
      types.push(primitive);
      index++;
    }
  }
  return descriptor.includes(')') ? types : undefined;
}

function matchesRuntimeCallable(node: GraphNode, runtime: RuntimeCallableIdentity): boolean {
  const strategy = getProviderForFile(String(node.properties.filePath))?.runtimeSymbolStrategy;
  if (strategy !== undefined) return strategy.matchesCallable(node, runtime);
  return (
    (node.label === 'Method' || node.label === 'Function') &&
    node.properties.name === runtime.name &&
    (runtime.descriptorParameterTypes === undefined ||
      node.properties.parameterCount === runtime.descriptorParameterTypes.length)
  );
}

function resolveHandlerNode(
  indexes: RuntimeNodeIndexes,
  handlerMethod: JsonObject | undefined,
): GraphNode | undefined {
  const className = safeText(handlerMethod?.className);
  const methodName = safeText(handlerMethod?.name);
  if (methodName === undefined) return resolveClass(indexes, className);
  if (className === undefined) return undefined;
  const owner = resolveClass(indexes, className);
  const runtime: RuntimeCallableIdentity = {
    name: methodName,
    descriptorParameterTypes: descriptorParameterTypes(safeText(handlerMethod?.descriptor)),
  };
  const ownerCandidates = owner === undefined ? [] : (indexes.methodsByOwnerId.get(owner.id) ?? []);
  const aliasCandidates =
    indexes.callablesByRuntimeOwner.get(normalizedQualifiedName(className)) ?? [];
  const candidates = [...ownerCandidates, ...aliasCandidates]
    .filter((node, index, all) => all.findIndex((candidate) => candidate.id === node.id) === index)
    .filter((node) => matchesRuntimeCallable(node, runtime));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function predicateParts(predicate: string | undefined): {
  readonly methods: string[];
  readonly patterns: string[];
} {
  if (predicate === undefined) return { methods: [], patterns: [] };
  const methodListEnd = predicate.indexOf('[');
  const methodRegion = methodListEnd === -1 ? predicate : predicate.slice(0, methodListEnd);
  const methods = [
    ...methodRegion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b/g),
  ]
    .map((match) => match[1])
    .filter((method): method is string => method !== undefined);
  const patterns = [...predicate.matchAll(/(?:^|[\s[(])((?:\/)[^\s\]),}]+)/g)]
    .map((match) => safeText(match[1]))
    .filter((pattern): pattern is string => pattern !== undefined);
  return { methods: [...new Set(methods)], patterns: [...new Set(patterns)] };
}

function mappingEntries(payload: JsonObject): JsonObject[] {
  const entries: JsonObject[] = [];
  const contexts = objectValue(payload.contexts);
  if (contexts === undefined) return entries;
  for (const context of Object.values(contexts).slice(0, MAX_RUNTIME_RECORDS)) {
    const mappings = objectValue(objectValue(context)?.mappings);
    if (mappings === undefined) continue;
    for (const groupName of ['dispatcherServlets', 'dispatcherHandlers']) {
      const groups = objectValue(mappings[groupName]);
      if (groups === undefined) continue;
      for (const group of Object.values(groups)) {
        if (!Array.isArray(group)) continue;
        for (const entry of group) {
          const object = objectValue(entry);
          if (object !== undefined) entries.push(object);
          if (entries.length >= MAX_RUNTIME_RECORDS) return entries;
        }
      }
    }
  }
  return entries;
}

function importMappings(
  graph: KnowledgeGraph,
  payload: JsonObject,
  indexes: RuntimeNodeIndexes,
): number {
  let imported = 0;
  const seen = new Set<string>();
  for (const entry of mappingEntries(payload)) {
    const details = objectValue(entry.details);
    const conditions = objectValue(details?.requestMappingConditions);
    const predicate = predicateParts(safeText(entry.predicate));
    const patterns = safeStrings(conditions?.patterns);
    const methods = safeStrings(conditions?.methods)
      .map(normalizeRouteMethod)
      .filter((method): method is string => method !== undefined);
    const effectivePatterns = patterns.length > 0 ? patterns : predicate.patterns;
    const effectiveMethods = methods.length > 0 ? methods : predicate.methods;
    if (effectivePatterns.length === 0) continue;

    const handler = resolveHandlerNode(indexes, objectValue(details?.handlerMethod));
    for (const rawPattern of effectivePatterns) {
      const url = normalizeExtractedRoutePath(rawPattern, null);
      for (const method of effectiveMethods.length > 0 ? effectiveMethods : [undefined]) {
        if (imported >= MAX_RUNTIME_RECORDS) return imported;
        const normalizedMethod = normalizeRouteMethod(method);
        const key = routeNodeKey(normalizedMethod, url);
        if (seen.has(key)) continue;
        seen.add(key);
        const exactId = generateId('Route', key);
        const fallbackId = generateId('Route', url);
        let route = graph.getNode(exactId) ?? graph.getNode(fallbackId);
        if (route?.label !== 'Route') route = undefined;
        const routeWasPresent = route !== undefined;
        if (route === undefined) {
          route = {
            id: exactId,
            label: 'Route',
            properties: {
              name: url,
              filePath: handler?.properties.filePath ?? `${RUNTIME_FILE_PREFIX}mappings`,
              ...(normalizedMethod === undefined ? {} : { method: normalizedMethod }),
              ...(handler === undefined ? {} : { handlerSymbolId: handler.id }),
            },
          };
          graph.addNode(route);
        }
        const existingHandlerId = safeText(route.properties.handlerSymbolId);
        const handlerFilePath =
          handler !== undefined && typeof handler.properties.filePath === 'string'
            ? handler.properties.filePath
            : undefined;
        const handlerFileId =
          handlerFilePath === undefined ? undefined : generateId('File', handlerFilePath);
        const staticOwnerFileIds = indexes.routeOwnerFileIdsByRouteId.get(route.id);
        const conflictsWithStaticOwner =
          routeWasPresent &&
          handlerFileId !== undefined &&
          staticOwnerFileIds !== undefined &&
          [...staticOwnerFileIds].some((ownerFileId) => ownerFileId !== handlerFileId);
        if (
          handler !== undefined &&
          ((existingHandlerId !== undefined && existingHandlerId !== handler.id) ||
            conflictsWithStaticOwner)
        ) {
          // Static ownership and runtime ownership disagree. Preserve the
          // static handler, persist an explicit conflict, and do not mint an
          // authoritative HANDLES_ROUTE edge from the runtime candidate.
          markRuntimeEvidence(graph, 'mappings', route, 'handler-conflict', false);
          imported++;
          continue;
        }
        if (handler !== undefined && existingHandlerId === undefined) {
          route.properties.handlerSymbolId = handler.id;
        }
        markRuntimeEvidence(graph, 'mappings', route);
        if (handler !== undefined && handlerFileId !== undefined) {
          if (graph.getNode(handlerFileId) !== undefined) {
            graph.addRelationship({
              id: generateId('HANDLES_ROUTE', `${handlerFileId}->${route.id}`),
              sourceId: handlerFileId,
              targetId: route.id,
              type: 'HANDLES_ROUTE',
              confidence: 1,
              reason: 'spring-actuator:runtime-confirmed',
            });
          }
        }
        imported++;
      }
    }
  }
  return imported;
}

function contextObjects(payload: JsonObject): JsonObject[] {
  const contexts = objectValue(payload.contexts);
  if (contexts === undefined) return [];
  return Object.values(contexts)
    .slice(0, MAX_RUNTIME_RECORDS)
    .map(objectValue)
    .filter((context): context is JsonObject => context !== undefined);
}

function importBeans(
  graph: KnowledgeGraph,
  payload: JsonObject,
  indexes: RuntimeNodeIndexes,
): number {
  let imported = 0;
  const seen = new Set<string>();
  for (const [contextIndex, context] of contextObjects(payload).entries()) {
    const beans = objectValue(context.beans);
    if (beans === undefined) continue;
    for (const [rawBeanName, rawBean] of Object.entries(beans)) {
      if (imported >= MAX_RUNTIME_RECORDS) return imported;
      const beanName = safeText(rawBeanName, 512);
      const bean = objectValue(rawBean);
      if (beanName === undefined || bean === undefined) continue;
      const identity = `${contextIndex}:${beanName}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const type = safeText(bean.type, 1024);
      const named = indexes.beanProvidersByName.get(beanName);
      let target = named === null ? undefined : named;
      if (target !== undefined && !providerMatchesRuntimeType(indexes, target, type)) {
        target = undefined;
      }
      target ??= resolveClass(indexes, type);
      if (target === undefined) {
        const id = generateId('CodeElement', `spring-runtime-bean:${identity}`);
        target = graph.getNode(id);
        if (target === undefined) {
          const scope = safeText(bean.scope, 128);
          target = {
            id,
            label: 'CodeElement',
            properties: {
              name: beanName,
              filePath: `${RUNTIME_FILE_PREFIX}beans`,
              description:
                `Spring runtime Bean ${beanName}` +
                (type === undefined ? '' : ` of type ${type}`) +
                (scope === undefined ? '' : ` (${scope})`),
              ...(type === undefined ? {} : { qualifiedName: normalizedQualifiedName(type) }),
            },
          };
          graph.addNode(target);
        }
      }
      markRuntimeEvidence(graph, 'beans', target);
      imported++;
    }
  }
  return imported;
}

function resolveConditionOwner(
  indexes: RuntimeNodeIndexes,
  rawName: string,
): GraphNode | undefined {
  const separator = rawName.lastIndexOf('#');
  return resolveHandlerNode(indexes, {
    className: separator === -1 ? rawName : rawName.slice(0, separator),
    ...(separator === -1 ? {} : { name: rawName.slice(separator + 1) }),
  });
}

function importConditions(
  graph: KnowledgeGraph,
  payload: JsonObject,
  indexes: RuntimeNodeIndexes,
): number {
  let imported = 0;
  const seen = new Set<string>();
  for (const context of contextObjects(payload)) {
    for (const [field, status] of [
      ['positiveMatches', 'matched'],
      ['negativeMatches', 'not-matched'],
    ] as const) {
      const matches = objectValue(context[field]);
      if (matches === undefined) continue;
      for (const rawName of Object.keys(matches)) {
        if (imported >= MAX_RUNTIME_RECORDS) return imported;
        const name = safeText(rawName);
        if (name === undefined || seen.has(`${status}:${name}`)) continue;
        seen.add(`${status}:${name}`);
        const owner = resolveConditionOwner(indexes, name);
        if (owner === undefined) continue;
        // Actuator reports this status for the aggregate owner entry. Its child
        // details may contain a mix of matched and not-matched conditions, but
        // do not carry a stable identifier that maps to our CONDITIONAL_ON
        // targets. Keep the aggregate on the owner instead of guessing.
        markRuntimeEvidence(graph, 'conditions', owner, status);
        imported++;
      }
    }
  }
  return imported;
}

function relaxedPropertyName(value: string): string {
  return value.toLowerCase().replace(/[-_.\[\]]/g, '');
}

interface RuntimePropertyIndex {
  readonly exact: Map<string, GraphNode | null>;
  readonly relaxed: Map<string, GraphNode | null>;
}

function buildRuntimePropertyIndex(graph: KnowledgeGraph): RuntimePropertyIndex {
  const exact = new Map<string, GraphNode | null>();
  const relaxed = new Map<string, GraphNode | null>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Property') continue;
    const description = safeText(node.properties.description) ?? '';
    if (!description.startsWith(SPRING_CONFIG_DESCRIPTION) && !node.id.includes('spring-runtime')) {
      continue;
    }
    const name = String(node.properties.name);
    uniqueIndexAdd(exact, name, node);
    uniqueIndexAdd(relaxed, relaxedPropertyName(name), node);
  }
  return { exact, relaxed };
}

function ensureRuntimeProperty(
  graph: KnowledgeGraph,
  index: RuntimePropertyIndex,
  endpoint: 'configprops' | 'env',
  rawName: string,
): GraphNode | undefined {
  const name = safeText(rawName, 1024);
  if (name === undefined) return undefined;
  const exact = index.exact.get(name);
  let node = exact === null ? undefined : exact;
  if (node === undefined) {
    const relaxed = index.relaxed.get(relaxedPropertyName(name));
    node = relaxed === null ? undefined : relaxed;
  }
  if (node === undefined) {
    const id = generateId('Property', `spring-runtime-config:${name}`);
    node = graph.getNode(id);
    if (node === undefined) {
      node = {
        id,
        label: 'Property',
        properties: {
          name,
          filePath: `${RUNTIME_FILE_PREFIX}${endpoint}`,
          description: `${SPRING_CONFIG_DESCRIPTION}; imported from Spring Actuator ${endpoint}`,
        },
      };
      graph.addNode(node);
    }
    uniqueIndexAdd(index.exact, name, node);
    uniqueIndexAdd(index.relaxed, relaxedPropertyName(name), node);
  }
  markRuntimeEvidence(graph, endpoint, node);
  return node;
}

function configInputPaths(inputs: unknown): string[] {
  const out: string[] = [];
  const stack: Array<{ value: unknown; prefix: string; depth: number }> = [
    { value: inputs, prefix: '', depth: 0 },
  ];
  while (stack.length > 0 && out.length < MAX_RUNTIME_RECORDS) {
    const current = stack.pop();
    if (current === undefined || current.depth > MAX_RUNTIME_DEPTH) continue;
    const object = objectValue(current.value);
    if (object === undefined) {
      if (current.prefix.length > 0) out.push(current.prefix);
      continue;
    }
    const keys = Object.keys(object);
    const metadataLeaf =
      keys.length === 0 || keys.every((key) => key === 'value' || key === 'origin');
    if (metadataLeaf) {
      if (current.prefix.length > 0) out.push(current.prefix);
      continue;
    }
    for (let index = keys.length - 1; index >= 0; index--) {
      const rawKey = keys[index];
      if (rawKey === undefined) continue;
      const key = safeText(rawKey, 256);
      if (key === undefined) continue;
      stack.push({
        value: object[rawKey],
        prefix: current.prefix.length === 0 ? key : `${current.prefix}.${key}`,
        depth: current.depth + 1,
      });
    }
  }
  return out;
}

function importConfigProperties(
  graph: KnowledgeGraph,
  payload: JsonObject,
  propertyIndex: RuntimePropertyIndex,
): number {
  let imported = 0;
  const seen = new Set<string>();
  for (const context of contextObjects(payload)) {
    const beans = objectValue(context.beans);
    if (beans === undefined) continue;
    for (const rawBean of Object.values(beans)) {
      const bean = objectValue(rawBean);
      const prefix = safeText(bean?.prefix, 512)?.replace(/\.+$/, '');
      if (bean === undefined || prefix === undefined) continue;
      const paths = configInputPaths(bean.inputs);
      const names = paths.length === 0 ? [prefix] : paths.map((entry) => `${prefix}.${entry}`);
      for (const name of names) {
        if (imported >= MAX_RUNTIME_RECORDS) return imported;
        if (seen.has(name)) continue;
        seen.add(name);
        if (ensureRuntimeProperty(graph, propertyIndex, 'configprops', name) !== undefined)
          imported++;
      }
    }
  }
  return imported;
}

function importEnvironmentProperties(
  graph: KnowledgeGraph,
  payload: JsonObject,
  propertyIndex: RuntimePropertyIndex,
): number {
  let imported = 0;
  const seen = new Set<string>();
  if (!Array.isArray(payload.propertySources)) return imported;
  for (const rawSource of payload.propertySources.slice(0, MAX_RUNTIME_RECORDS)) {
    const properties = objectValue(objectValue(rawSource)?.properties);
    if (properties === undefined) continue;
    // Deliberately enumerate keys only. Never read, retain, interpolate, or log
    // the corresponding {value, origin} objects.
    for (const rawName of Object.keys(properties)) {
      if (imported >= MAX_RUNTIME_RECORDS) return imported;
      const name = safeText(rawName, 1024);
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      if (ensureRuntimeProperty(graph, propertyIndex, 'env', name) !== undefined) imported++;
    }
  }
  return imported;
}

/**
 * Import explicitly supplied Spring Boot Actuator snapshots. Runtime evidence
 * is additive: it confirms existing static nodes where possible and creates
 * conservative synthetic Route/Bean/Property nodes otherwise. Raw payloads,
 * condition messages, config values, env values, origins, and source names are
 * never copied into graph properties or logs.
 */
export async function importSpringActuatorRuntime(
  graph: KnowledgeGraph,
  repoPath: string,
  configuredPath: string,
): Promise<SpringActuatorImportStats> {
  const payloads = await loadPayloads(repoPath, configuredPath);
  const stats: MutableImportStats = {
    payloads: payloads.size,
    mappings: 0,
    beans: 0,
    conditions: 0,
    configProperties: 0,
    environmentProperties: 0,
  };
  const indexes = buildRuntimeNodeIndexes(graph);
  const propertyIndex = buildRuntimePropertyIndex(graph);

  const mappings = payloads.get('mappings');
  if (mappings !== undefined) stats.mappings = importMappings(graph, mappings, indexes);
  const beans = payloads.get('beans');
  if (beans !== undefined) stats.beans = importBeans(graph, beans, indexes);
  const conditions = payloads.get('conditions');
  if (conditions !== undefined) stats.conditions = importConditions(graph, conditions, indexes);
  const configprops = payloads.get('configprops');
  if (configprops !== undefined) {
    stats.configProperties = importConfigProperties(graph, configprops, propertyIndex);
  }
  const env = payloads.get('env');
  if (env !== undefined) {
    stats.environmentProperties = importEnvironmentProperties(graph, env, propertyIndex);
  }
  return stats;
}
