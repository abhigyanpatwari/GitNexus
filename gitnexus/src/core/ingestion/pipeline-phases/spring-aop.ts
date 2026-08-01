/**
 * Phase: springAop
 *
 * Materializes statically visible Spring proxy/advice behavior after every
 * language resolver has attached normalized metadata to the shared graph.
 *
 * @deps    scopeResolution
 * @reads   Class/Method nodes, HAS_METHOD edges, shared Spring AOP metadata
 * @writes  synthetic CodeElement nodes, DEFINES/DECLARES/ADVISED_BY edges
 */

import type { GraphNode } from 'gitnexus-shared';
import { generateId } from '../../../lib/utils.js';
import {
  encodeSpringAopReason,
  getSpringAopGraphMetadata,
  parseSpringAopPointcut,
  SPRING_AOP_EVIDENCE_DESCRIPTION_PREFIX,
  springAopPointcutMatches,
  type SpringAopAdviceRecord,
  type SpringAopAspectRecord,
  type SpringAopBehaviorRecord,
  type SpringAopPointcutReason,
} from '../frameworks/spring/aop.js';
import {
  createSpringAopCandidateIndex,
  type SpringAopCandidateIndex,
  type SpringAopOwnedMethod,
} from '../frameworks/spring/aop-candidates.js';
import { toZeroBasedLine } from '../utils/line-base.js';
import type { PipelineContext, PipelinePhase } from './types.js';

export interface SpringAopOutput {
  readonly advisedByEdges: number;
  readonly evidenceNodes: number;
  readonly unresolvedPointcuts: number;
}

function simpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

function eligibleMethod(
  node: GraphNode,
  owner: GraphNode | undefined,
  singletonInstanceClassIds: ReadonlySet<string>,
): boolean {
  return (
    node.label === 'Method' &&
    (node.properties.isStatic !== true ||
      (owner !== undefined && singletonInstanceClassIds.has(owner.id))) &&
    node.properties.visibility !== 'private'
  );
}

function eligibleOwner(node: GraphNode): boolean {
  return node.label === 'Class' || node.label === 'Interface';
}

function addEvidenceNode(
  ctx: PipelineContext,
  owner: GraphNode,
  annotation: string,
  line: number,
  discriminator: string,
  description: string,
): GraphNode {
  const evidenceId = generateId(
    'CodeElement',
    `spring-aop:${owner.id}:${line}:${annotation}:${discriminator}`,
  );
  const evidence: GraphNode = {
    id: evidenceId,
    label: 'CodeElement',
    properties: {
      name: `@${simpleName(annotation)}`,
      filePath: owner.properties.filePath,
      startLine: toZeroBasedLine(line),
      endLine: toZeroBasedLine(line),
      isExported: false,
      description: `${SPRING_AOP_EVIDENCE_DESCRIPTION_PREFIX}${description}`,
    },
  };
  ctx.graph.addNode(evidence);

  const fileId = generateId('File', owner.properties.filePath);
  if (ctx.graph.getNode(fileId) !== undefined) {
    ctx.graph.addRelationship({
      id: generateId('DEFINES', `${fileId}->${evidenceId}`),
      sourceId: fileId,
      targetId: evidenceId,
      type: 'DEFINES',
      confidence: 1,
      reason: 'spring-aop:evidence',
    });
  }
  return evidence;
}

function emitBehavior(
  ctx: PipelineContext,
  record: SpringAopBehaviorRecord,
  classMethods: ReadonlyMap<string, readonly GraphNode[]>,
  ownerByMethod: ReadonlyMap<string, GraphNode>,
  singletonInstanceClassIds: ReadonlySet<string>,
): { edges: number; evidence: number } {
  const owner = ctx.graph.getNode(record.ownerId);
  if (owner === undefined || (!eligibleOwner(owner) && owner.label !== 'Method')) {
    return { edges: 0, evidence: 0 };
  }
  if (
    owner.label === 'Method' &&
    !eligibleMethod(owner, ownerByMethod.get(owner.id), singletonInstanceClassIds)
  ) {
    return { edges: 0, evidence: 0 };
  }
  const evidence = addEvidenceNode(
    ctx,
    owner,
    record.annotation,
    record.line,
    `behavior:${record.behavior}`,
    `${record.behavior} interceptor; activation unknown; proxy possible`,
  );
  const reason = encodeSpringAopReason({
    kind: 'behavior',
    annotation: record.annotation,
    behavior: record.behavior,
    declaredOn: record.ownerKind === 'class' ? 'class' : 'method',
    activation: 'unknown',
    proxy: 'possible',
  });

  const sources =
    record.ownerKind === 'class' ? [owner, ...(classMethods.get(owner.id) ?? [])] : [owner];
  let edges = 0;
  for (const source of sources) {
    if (
      !eligibleOwner(source) &&
      !eligibleMethod(source, ownerByMethod.get(source.id), singletonInstanceClassIds)
    ) {
      continue;
    }
    ctx.graph.addRelationship({
      id: generateId(
        'ADVISED_BY',
        `${source.id}->${evidence.id}:${record.line}:${record.behavior}`,
      ),
      sourceId: source.id,
      targetId: evidence.id,
      type: 'ADVISED_BY',
      confidence: 1,
      reason,
    });
    edges++;
  }
  return { edges, evidence: 1 };
}

function emitAspect(ctx: PipelineContext, record: SpringAopAspectRecord): number {
  const owner = ctx.graph.getNode(record.ownerId);
  if (owner === undefined || !eligibleOwner(owner)) return 0;
  const evidence = addEvidenceNode(
    ctx,
    owner,
    record.annotation,
    record.line,
    'aspect',
    'AspectJ aspect marker; registration unknown; activation unknown',
  );
  ctx.graph.addRelationship({
    id: generateId('DECLARES', `${owner.id}->${evidence.id}`),
    sourceId: owner.id,
    targetId: evidence.id,
    type: 'DECLARES',
    confidence: 1,
    reason: encodeSpringAopReason({
      kind: 'aspect',
      annotation: record.annotation,
      activation: 'unknown',
      registration: 'unknown',
    }),
  });
  return 1;
}

function pointcutReason(record: SpringAopAdviceRecord, resolved: boolean): SpringAopPointcutReason {
  return {
    kind: 'pointcut',
    annotation: record.annotation,
    pointcut: record.pointcut,
    match: resolved ? 'static' : 'unresolved',
    resolution: resolved ? 'resolved' : 'unknown',
  };
}

function emitAdvice(
  ctx: PipelineContext,
  record: SpringAopAdviceRecord,
  aspectClassIds: ReadonlySet<string>,
  ownerByMethod: ReadonlyMap<string, GraphNode>,
  candidateIndex: SpringAopCandidateIndex,
  methodAnnotations: ReadonlyMap<string, ReadonlySet<string>>,
): { edges: number; evidence: number; unresolved: number } {
  const adviceNode = ctx.graph.getNode(record.ownerId);
  if (adviceNode === undefined || adviceNode.label !== 'Method') {
    return { edges: 0, evidence: 0, unresolved: 0 };
  }
  const staticPointcut = record.pointcut;
  const parsed = staticPointcut === null ? null : parseSpringAopPointcut(staticPointcut);
  const isAdviceMethod = record.advice !== 'pointcut';
  const adviceOwner = ownerByMethod.get(adviceNode.id);
  const activeAspect = adviceOwner !== undefined && aspectClassIds.has(adviceOwner.id);
  const resolved = parsed !== null && (!isAdviceMethod || activeAspect);
  const evidence = addEvidenceNode(
    ctx,
    adviceNode,
    record.annotation,
    record.line,
    `pointcut:${record.advice}:${record.pointcut ?? '<dynamic>'}`,
    `${record.advice} pointcut ${record.pointcut ?? '<non-static>'}; resolution ${
      resolved ? 'resolved' : 'unknown'
    }`,
  );
  ctx.graph.addRelationship({
    id: generateId('DECLARES', `${adviceNode.id}->${evidence.id}`),
    sourceId: adviceNode.id,
    targetId: evidence.id,
    type: 'DECLARES',
    confidence: 1,
    reason: encodeSpringAopReason(pointcutReason(record, resolved)),
  });

  if (!isAdviceMethod || !resolved || parsed === null || staticPointcut === null) {
    return { edges: 0, evidence: 1, unresolved: resolved ? 0 : 1 };
  }

  let edges = 0;
  for (const candidate of candidateIndex.candidatesFor(parsed)) {
    if (candidate.method.id === adviceNode.id) continue;
    if (aspectClassIds.has(candidate.owner.id)) continue;
    if (
      !springAopPointcutMatches(
        parsed,
        candidate.owner,
        candidate.method,
        methodAnnotations.get(candidate.method.id),
      )
    ) {
      continue;
    }
    ctx.graph.addRelationship({
      id: generateId(
        'ADVISED_BY',
        `${candidate.method.id}->${adviceNode.id}:${record.line}:${record.advice}`,
      ),
      sourceId: candidate.method.id,
      targetId: adviceNode.id,
      type: 'ADVISED_BY',
      confidence: 0.95,
      reason: encodeSpringAopReason({
        kind: 'advice',
        annotation: record.annotation,
        advice: record.advice,
        pointcut: staticPointcut,
        match: 'static',
        activation: 'unknown',
        proxy: 'possible',
      }),
    });
    edges++;
  }
  return { edges, evidence: 1, unresolved: 0 };
}

export const springAopPhase: PipelinePhase<SpringAopOutput> = {
  name: 'springAop',
  deps: ['scopeResolution'],

  async execute(ctx: PipelineContext): Promise<SpringAopOutput> {
    const metadata = getSpringAopGraphMetadata(ctx.graph);
    if (
      metadata.aspects.length === 0 &&
      metadata.behaviors.length === 0 &&
      metadata.advices.length === 0
    ) {
      return { advisedByEdges: 0, evidenceNodes: 0, unresolvedPointcuts: 0 };
    }

    ctx.onProgress({
      phase: 'enriching',
      percent: 97,
      message: 'Resolving Spring proxy and advice edges...',
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
    });

    const classMethods = new Map<string, GraphNode[]>();
    const ownerByMethod = new Map<string, GraphNode>();
    const methodAnnotations = new Map<string, Set<string>>();
    const candidates: SpringAopOwnedMethod[] = [];
    for (const relationship of ctx.graph.iterRelationshipsByType('HAS_METHOD')) {
      const owner = ctx.graph.getNode(relationship.sourceId);
      const method = ctx.graph.getNode(relationship.targetId);
      if (owner === undefined || !eligibleOwner(owner) || method?.label !== 'Method') continue;
      const ownerFilePath = owner.properties.filePath;
      if (typeof ownerFilePath !== 'string' || !metadata.candidateFilePaths.has(ownerFilePath)) {
        continue;
      }
      ownerByMethod.set(method.id, owner);
      if (!eligibleMethod(method, owner, metadata.singletonInstanceClassIds)) continue;
      const methods = classMethods.get(owner.id) ?? [];
      methods.push(method);
      classMethods.set(owner.id, methods);
      candidates.push({ method, owner });
    }

    let advisedByEdges = 0;
    let evidenceNodes = 0;
    let unresolvedPointcuts = 0;
    for (const aspect of metadata.aspects) evidenceNodes += emitAspect(ctx, aspect);
    for (const behavior of metadata.behaviors) {
      // `@annotation` matches annotations declared directly on the method.
      // Class-level behavior is fanned out by emitBehavior, but must not be
      // copied here (that would model @within/@target semantics instead).
      if (behavior.ownerKind === 'callable') {
        const annotations = methodAnnotations.get(behavior.ownerId) ?? new Set<string>();
        annotations.add(behavior.annotation);
        methodAnnotations.set(behavior.ownerId, annotations);
      }
      const emitted = emitBehavior(
        ctx,
        behavior,
        classMethods,
        ownerByMethod,
        metadata.singletonInstanceClassIds,
      );
      advisedByEdges += emitted.edges;
      evidenceNodes += emitted.evidence;
    }
    const candidateIndex = createSpringAopCandidateIndex(candidates, methodAnnotations);
    for (const advice of metadata.advices) {
      const emitted = emitAdvice(
        ctx,
        advice,
        metadata.aspectClassIds,
        ownerByMethod,
        candidateIndex,
        methodAnnotations,
      );
      advisedByEdges += emitted.edges;
      evidenceNodes += emitted.evidence;
      unresolvedPointcuts += emitted.unresolved;
    }

    return { advisedByEdges, evidenceNodes, unresolvedPointcuts };
  },
};
