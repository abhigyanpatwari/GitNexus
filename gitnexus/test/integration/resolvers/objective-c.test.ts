import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  FIXTURES,
  getNodesByLabel,
  getNodesByLabelFull,
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

const objectiveCAvailable = isLanguageAvailable(SupportedLanguages.ObjectiveC);

describe.skipIf(!objectiveCAvailable)('Objective-C scope resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'objective-c-core'), () => {});
  }, 60_000);

  it('emits classes, properties, and complete signed selector identities', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(
      expect.arrayContaining(['BaseStore', 'Store']),
    );
    expect(getNodesByLabel(result, 'Property')).toContain('name');
    expect(getNodesByLabel(result, 'Method')).toEqual(
      expect.arrayContaining(['-save:completion:', '-run']),
    );
  });

  it('resolves self message sends to the owning class method', () => {
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-run',
          target: '-save:completion:',
          targetFilePath: 'Store.m',
        }),
      ]),
    );
  });

  it('falls back to a primary interface declaration when no implementation exists', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) =>
        call.source === '-runWithWorker:required:optional:' && call.target === '-declaredOnlyWork',
    );

    expect(calls).toHaveLength(1);
    expect(result.graph.getNode(calls[0]!.rel.targetId)?.properties.annotations).toEqual(
      expect.arrayContaining(['objc:owner:Worker', 'objc:site:declaration']),
    );
  });

  it('resolves indexed subscripting through the unique selector candidate', () => {
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-run',
          target: '-objectAtIndexedSubscript:',
          targetFilePath: 'Store.m',
        }),
        expect.objectContaining({
          source: '-run',
          target: '-setObject:atIndexedSubscript:',
          targetFilePath: 'Store.m',
        }),
      ]),
    );
  });

  it('resolves a typed receiver subscript through captured selector candidates', () => {
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-runWithBox:',
          target: '-objectAtIndexedSubscript:',
          targetFilePath: 'SemanticDispatch.m',
        }),
      ]),
    );
  });

  it('suppresses subscripting when indexed and keyed selector candidates are ambiguous', () => {
    expect(getRelationships(result, 'CALLS')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-run',
          sourceFilePath: 'AmbiguousBox.m',
          target: expect.stringMatching(/^-object(?:AtIndexed|ForKeyed)Subscript:$/),
        }),
      ]),
    );
  });

  it('emits Objective-C superclass inheritance', () => {
    expect(getRelationships(result, 'EXTENDS')).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'Store', target: 'BaseStore' })]),
    );
  });

  it('keeps declaration, implementation, extension, and category source sites distinct', () => {
    const storeNodes = result.graph.nodes.filter(
      (node) => node.label === 'Class' && node.properties.name === 'Store',
    );
    expect(new Set(storeNodes.map((node) => node.id)).size).toBe(storeNodes.length);
    expect(storeNodes.map((node) => node.properties.sourceRole)).toEqual(
      expect.arrayContaining(['declaration', 'implementation', 'category-host']),
    );

    expect(getRelationships(result, 'DECLARES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'Store',
          target: 'Store',
          sourceFilePath: 'Store.h',
          targetFilePath: 'Store.m',
        }),
        expect.objectContaining({
          source: 'Store',
          target: 'Store(Testing)',
          targetFilePath: 'Store+Testing.m',
        }),
        expect.objectContaining({
          source: 'Store(Testing)',
          target: '-categoryOnly',
          targetFilePath: 'Store+Testing.m',
        }),
      ]),
    );
  });

  it('attaches ivars and synthesized property accessors to the concrete class', () => {
    expect(getRelationships(result, 'HAS_PROPERTY')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'Store', target: '_token', targetLabel: 'Variable' }),
        expect.objectContaining({ source: 'Store', target: '_name', targetLabel: 'Variable' }),
        expect.objectContaining({ source: 'Store', target: '_ready', targetLabel: 'Variable' }),
        expect.objectContaining({
          source: 'Store',
          target: '_aliasStorage',
          targetLabel: 'Variable',
        }),
      ]),
    );
    expect(getRelationships(result, 'HAS_PROPERTY')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'Store', target: '_protocolName' }),
      ]),
    );
    expect(getNodesByLabelFull(result, 'Method')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '-name',
          properties: expect.objectContaining({ sourceRole: 'synthesized' }),
        }),
        expect.objectContaining({
          name: '-isReady',
          properties: expect.objectContaining({ sourceRole: 'synthesized' }),
        }),
        expect.objectContaining({
          name: '-setReady:',
          properties: expect.objectContaining({ sourceRole: 'synthesized' }),
        }),
      ]),
    );
    expect(getNodesByLabel(result, 'Method')).not.toEqual(
      expect.arrayContaining(['-runtimeValue', '-setRuntimeValue:']),
    );
    expect(getNodesByLabelFull(result, 'Property')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'runtimeValue',
          properties: expect.objectContaining({
            annotations: expect.arrayContaining(['objc:property:dynamic']),
          }),
        }),
      ]),
    );
  });

  it('resolves synthesized accessors, class-extension methods, and unique category methods', () => {
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: '-run', target: '-setReady:' }),
        expect.objectContaining({ source: '-run', target: '-isReady' }),
        expect.objectContaining({ source: '-run', target: '-privateThing' }),
        expect.objectContaining({
          source: '-run',
          target: '-categoryOnly',
          targetFilePath: 'Store+Testing.m',
        }),
      ]),
    );
  });

  it('resolves a local Objective-C block invocation through callable value flow', () => {
    const blockNode = getNodesByLabelFull(result, 'Function').find((node) =>
      node.name.startsWith('block@'),
    );

    expect(blockNode).toBeDefined();
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-run',
          target: blockNode?.name,
          targetFilePath: 'Store.m',
        }),
        expect.objectContaining({
          source: blockNode?.name,
          target: '-privateThing',
          targetFilePath: 'Store.m',
        }),
      ]),
    );
  });

  it('resolves imported C declarations through the Objective-C header context', () => {
    const legacyFunction = getNodesByLabelFull(result, 'Function').find(
      (node) => node.name === 'LegacyTouch',
    );

    expect(legacyFunction?.properties.language).toBe(SupportedLanguages.CPlusPlus);
    expect(getRelationships(result, 'IMPORTS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceFilePath: 'Store.m', targetFilePath: 'Legacy.h' }),
        expect.objectContaining({ sourceFilePath: 'Legacy.h', targetFilePath: 'LegacyBase.h' }),
      ]),
    );
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-run',
          target: 'LegacyTouch',
          targetFilePath: 'Legacy.h',
        }),
      ]),
    );
  });

  it('mirrors superclass and protocol heritage onto the implementation site', () => {
    expect(getRelationships(result, 'HAS_METHOD')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'Storable', target: '-optionalRun' }),
      ]),
    );
    expect(getRelationships(result, 'HAS_PROPERTY')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'Storable', target: 'protocolName' }),
      ]),
    );
    expect(getRelationships(result, 'EXTENDS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'Store',
          target: 'BaseStore',
          sourceFilePath: 'Store.m',
        }),
      ]),
    );
    expect(getRelationships(result, 'IMPLEMENTS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'Store',
          target: 'Storable',
          sourceFilePath: 'Store.m',
        }),
      ]),
    );
    expect(getRelationships(result, 'METHOD_IMPLEMENTS')).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: '-run', target: '-run' })]),
    );
    expect(getNodesByLabelFull(result, 'Method')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '-optionalRun',
          properties: expect.objectContaining({
            annotations: expect.arrayContaining(['objc:protocol:optional']),
          }),
        }),
        expect.objectContaining({
          name: '-run',
          properties: expect.objectContaining({
            annotations: expect.arrayContaining(['objc:protocol:required']),
          }),
        }),
      ]),
    );
  });

  it('emits property dot-syntax reads and writes as ACCESSES without accessor CALLS', () => {
    expect(getRelationships(result, 'ACCESSES')).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: '-run', target: 'ready' })]),
    );
  });

  it('resolves concrete and protocol-qualified receivers without dispatch guesses', () => {
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-runWithWorker:required:optional:',
          sourceFilePath: 'SemanticDispatch.m',
          target: '-work',
          targetFilePath: 'SemanticDispatch.m',
        }),
        expect.objectContaining({
          source: '-runWithWorker:required:optional:',
          sourceFilePath: 'SemanticDispatch.m',
          target: '-requiredWork',
          targetFilePath: 'SemanticProtocols.h',
          rel: expect.objectContaining({ confidence: 0.85 }),
        }),
        expect.objectContaining({
          source: '-runWithWorker:required:optional:',
          sourceFilePath: 'SemanticDispatch.m',
          target: '-optionalWork',
          targetFilePath: 'SemanticProtocols.h',
          rel: expect.objectContaining({ confidence: 0.6 }),
        }),
      ]),
    );
  });

  it('resolves class-protocol receivers and suppresses dynamic or ambiguous dispatch', () => {
    const calls = getRelationships(result, 'CALLS');

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-runWithClass:dynamic:ambiguous:',
          sourceFilePath: 'SemanticDispatch.m',
          target: '+classWork',
          targetFilePath: 'SemanticProtocols.h',
          rel: expect.objectContaining({ confidence: 0.85 }),
        }),
        expect.objectContaining({
          source: '-run',
          sourceFilePath: 'SemanticDispatch.m',
          target: '-baseWork',
          targetFilePath: 'SemanticDispatch.m',
          rel: expect.objectContaining({ confidence: 0.85 }),
        }),
      ]),
    );

    expect(calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-runWithClass:dynamic:ambiguous:',
          target: '-work',
        }),
      ]),
    );
  });

  it('resolves inherited and equivalent protocol contracts but suppresses conflicting ones', () => {
    const calls = getRelationships(result, 'CALLS');

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-runProtocolContracts:equivalent:conflicting:',
          target: '-inheritedWork',
          targetFilePath: 'SemanticProtocols.h',
          rel: expect.objectContaining({ confidence: 0.85 }),
        }),
        expect.objectContaining({
          source: '-runProtocolContracts:equivalent:conflicting:',
          target: '-duplicateWork',
          targetFilePath: 'SemanticProtocols.h',
          rel: expect.objectContaining({ confidence: 0.85 }),
        }),
      ]),
    );
    expect(calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-runProtocolContracts:equivalent:conflicting:',
          target: '-conflictingWork',
        }),
      ]),
    );
  });

  it('canonicalizes trivia-only differences in equivalent protocol types', () => {
    const whitespaceCalls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runWhitespace:' && call.target === '-whitespaceTitle',
    );

    expect(whitespaceCalls).toHaveLength(1);
    expect(whitespaceCalls[0]).toMatchObject({
      targetFilePath: 'SemanticProtocols.h',
      rel: expect.objectContaining({
        confidence: 0.85,
        reason: 'objective-c: protocol-dispatch',
      }),
    });
  });

  it('lets a required declaration dominate an equivalent optional protocol contract', () => {
    const requirementCalls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runRequirement:' && call.target === '-requirementTitle',
    );

    expect(requirementCalls).toHaveLength(1);
    expect(requirementCalls[0]!.rel).toMatchObject({
      confidence: 0.85,
      reason: 'objective-c: protocol-dispatch',
    });
    const targetAnnotations = result.graph.getNode(requirementCalls[0]!.rel.targetId)?.properties
      .annotations;
    expect(targetAnnotations).toEqual(
      expect.arrayContaining(['objc:owner:RequiredRequirementWorker', 'objc:protocol:required']),
    );
  });

  it('canonicalizes parameter trivia while preserving pointer depth', () => {
    const calls = getRelationships(result, 'CALLS');
    const parameterCalls = calls.filter(
      (call) => call.source === '-runParameterWhitespace:' && call.target === '-consumeTitle:',
    );
    const pointerDepthCalls = calls.filter(
      (call) => call.source === '-runPointerDepth:' && call.target === '-pointerDepthTitle',
    );

    expect(parameterCalls).toHaveLength(1);
    expect(parameterCalls[0]!.rel).toMatchObject({
      confidence: 0.85,
      reason: 'objective-c: protocol-dispatch',
    });
    expect(pointerDepthCalls).toHaveLength(0);
    const pointerOutcome = getResolutionOutcomes(result).filter(
      (outcome) =>
        outcome.name === 'pointerDepthTitle' && outcome.reason === 'member-lookup-ambiguous',
    );
    expect(pointerOutcome).toHaveLength(1);
    expect(pointerOutcome[0]!.candidateIds).toHaveLength(2);
  });

  it('keeps all-optional contracts weak and inherited required obligations strong', () => {
    const calls = getRelationships(result, 'CALLS');
    const optionalCalls = calls.filter(
      (call) => call.source === '-runAllOptional:' && call.target === '-allOptionalTitle',
    );
    const inheritedCalls = calls.filter(
      (call) =>
        call.source === '-runInheritedRequirement:' && call.target === '-inheritedRequirementTitle',
    );

    expect(optionalCalls).toHaveLength(1);
    expect(optionalCalls[0]!.rel).toMatchObject({
      confidence: 0.6,
      reason: 'objective-c: optional-protocol-dispatch',
    });
    expect(inheritedCalls).toHaveLength(1);
    expect(inheritedCalls[0]!.rel).toMatchObject({
      confidence: 0.85,
      reason: 'objective-c: protocol-dispatch',
    });
    expect(result.graph.getNode(inheritedCalls[0]!.rel.targetId)?.properties.annotations).toEqual(
      expect.arrayContaining(['objc:owner:OptionalRedeclaringWorker', 'objc:protocol:optional']),
    );
  });

  it('detects conflicts across inherited protocol branches while honoring a child redeclaration', () => {
    const calls = getRelationships(result, 'CALLS');

    expect(
      calls.filter(
        (call) => call.source === '-runInheritedConflict:' && call.target === '-branchConflict',
      ),
    ).toHaveLength(0);
    const overrideCalls = calls.filter(
      (call) => call.source === '-runInheritedOverride:' && call.target === '-branchConflict',
    );
    expect(overrideCalls).toHaveLength(1);
    expect(overrideCalls[0]!.rel.confidence).toBe(0.85);
    expect(result.graph.getNode(overrideCalls[0]!.rel.targetId)?.properties.annotations).toContain(
      'objc:owner:CombinedInheritedOverrideWorker',
    );
    const outcomes = getResolutionOutcomes(result).filter(
      (outcome) =>
        outcome.filePath === 'SemanticDispatch.m' &&
        outcome.name === 'branchConflict' &&
        outcome.reason === 'member-lookup-ambiguous',
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: 'suppressed',
      phase: 'receiver-bound-calls',
    });
    expect(outcomes[0]!.candidateIds).toHaveLength(2);
    expect(outcomes[0]!.candidateIds).toEqual([...outcomes[0]!.candidateIds].sort());
  });

  it('keeps declaration frontiers branch-local in diamonds and fails closed on unknown roots', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(
      calls.filter(
        (call) => call.source === '-runDiamondConflict:' && call.target === '-diamondConflictTitle',
      ),
    ).toHaveLength(0);
    expect(
      calls.filter(
        (call) => call.source === '-runUnknownProtocol:' && call.target === '-requiredWork',
      ),
    ).toHaveLength(0);
    expect(
      calls.filter(
        (call) =>
          call.source === '-runUnknownInheritedProtocol:' &&
          call.target === '-inheritedUnknownWork',
      ),
    ).toHaveLength(0);

    const diamondOutcome = getResolutionOutcomes(result).filter(
      (outcome) =>
        outcome.name === 'diamondConflictTitle' && outcome.reason === 'member-lookup-ambiguous',
    );
    expect(diamondOutcome).toHaveLength(1);
    expect(diamondOutcome[0]!.candidateIds).toHaveLength(2);
    expect(getResolutionOutcomes(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'requiredWork',
          kind: 'suppressed',
          reason: 'objective-c: unknown-protocol',
          candidateIds: [],
        }),
        expect.objectContaining({
          name: 'inheritedUnknownWork',
          kind: 'suppressed',
          reason: 'objective-c: invalid-protocol-hierarchy',
          candidateIds: [],
        }),
      ]),
    );
  });

  it('resolves a directly declared protocol method without indexing its SDK parent', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runAppOwnedProtocol:' && call.target === '-appOwnedWork',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.rel).toMatchObject({
      confidence: 0.6,
      reason: 'objective-c: optional-protocol-dispatch',
    });
    expect(result.graph.getNode(calls[0]!.rel.targetId)?.properties.annotations).toEqual(
      expect.arrayContaining(['objc:owner:AppOwnedWorker', 'objc:protocol:optional']),
    );
  });

  it('resolves instancetype call results to the declaring class', () => {
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '-runClassMessage',
          sourceFilePath: 'SemanticDispatch.m',
          target: '+work',
          targetFilePath: 'SemanticDispatch.m',
        }),
        expect.objectContaining({
          source: '-run',
          sourceFilePath: 'SemanticDispatch.m',
          target: '+make',
          targetFilePath: 'SemanticDispatch.m',
        }),
        expect.objectContaining({
          source: '-run',
          sourceFilePath: 'SemanticDispatch.m',
          target: '-finish',
          targetFilePath: 'SemanticDispatch.m',
        }),
        expect.objectContaining({
          source: '-runWithRelated:',
          sourceFilePath: 'SemanticDispatch.m',
          target: '-finish',
          targetFilePath: 'SemanticDispatch.m',
        }),
      ]),
    );
  });

  it('uses the most-derived override and canonicalizes header-only type sites', () => {
    const calls = getRelationships(result, 'CALLS');
    const overrideCall = calls.find(
      (call) =>
        call.source === '-runWithOverride:header:qualified:' && call.target === '-overrideWork',
    );
    const headerCall = calls.find(
      (call) =>
        call.source === '-runWithOverride:header:qualified:' && call.target === '-headerWork',
    );

    expect(overrideCall).toBeDefined();
    expect(result.graph.getNode(overrideCall!.rel.targetId)?.properties.annotations).toContain(
      'objc:owner:OverrideChild',
    );
    expect(headerCall).toBeDefined();
    expect(result.graph.getNode(headerCall!.rel.targetId)?.properties.annotations).toContain(
      'objc:owner:HeaderOnlyWorker',
    );
  });

  it('falls back from Foo<P> to the unique protocol contract', () => {
    const protocolCall = getRelationships(result, 'CALLS').find(
      (call) =>
        call.source === '-runWithOverride:header:qualified:' && call.target === '-protocolOnly',
    );

    expect(protocolCall).toBeDefined();
    expect(protocolCall?.targetFilePath).toBe('SemanticProtocols.h');
    expect(protocolCall?.rel.confidence).toBe(0.85);
  });

  it('folds Objective-C related-result method families across a multi-hop chain', () => {
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: '-runChain', target: '+alloc' }),
        expect.objectContaining({ source: '-runChain', target: '-init' }),
        expect.objectContaining({ source: '-runChain', target: '-finish' }),
      ]),
    );
  });

  it('ignores leading underscores when classifying a related-result method family', () => {
    const targets = getRelationships(result, 'CALLS')
      .filter((call) => call.source === '-runUnderscoredInitChain')
      .map((call) => call.target)
      .sort();

    expect(targets).toEqual(['+alloc', '-_initSpecial', '-finish']);
  });

  it('folds a nullable id result through the new related-result family', () => {
    const targets = getRelationships(result, 'CALLS')
      .filter((call) => call.source === '-runNewChain')
      .map((call) => call.target)
      .sort();

    expect(targets).toEqual(['+new', '-finish']);
  });

  it('folds a nullable id result through the self related-result selector', () => {
    const targets = getRelationships(result, 'CALLS')
      .filter((call) => call.source === '-runSelfChain')
      .map((call) => call.target)
      .sort();

    expect(targets).toEqual(['+alloc', '-finish', '-self']);
  });

  it.each([
    ['-runCopyChain', ['+alloc', '-copy']],
    ['-runMutableCopyChain', ['+alloc', '-mutableCopy']],
  ])('does not inherit receiver type through an id result from %s', (source, expectedTargets) => {
    const targets = getRelationships(result, 'CALLS')
      .filter((call) => call.source === source)
      .map((call) => call.target)
      .sort();

    expect(targets).toEqual(expectedTargets);
  });

  it('folds a protocol factory return type through a receiver chain', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runWithFactory:',
    );

    expect(calls.map((call) => call.target).sort()).toEqual(['-finish', '-product']);
    expect(calls.find((call) => call.target === '-product')?.rel).toMatchObject({
      confidence: 0.85,
      reason: 'objective-c: protocol-dispatch',
    });
  });

  it.each(['-runWithCompositeFactory:', '-runWithConcreteFactory:'])(
    'folds the full declared protocol set through %s',
    (source) => {
      const calls = getRelationships(result, 'CALLS').filter((call) => call.source === source);

      expect(calls.map((call) => call.target).sort()).toEqual(['-finish', '-product']);
      expect(calls.find((call) => call.target === '-product')?.rel).toMatchObject({
        confidence: 0.85,
        reason: 'objective-c: protocol-dispatch',
      });
    },
  );

  it('preserves a protocol TypeRef across a receiver-relative chain hop', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runWithFluentFactory:',
    );

    expect(calls.map((call) => call.target).sort()).toEqual(['-finish', '-next', '-product']);
    expect(calls.find((call) => call.target === '-next')?.rel).toMatchObject({
      confidence: 0.85,
      reason: 'objective-c: protocol-dispatch',
    });
  });

  it('resolves selectors containing empty keyword pieces', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runWithTarget:',
    );

    expect(calls.map((call) => call.target).sort()).toEqual(['-::', '-foo::']);
  });

  it('resolves methods supplied only by indexed SDK category sites', () => {
    const calls = getRelationships(result, 'CALLS');
    const external = calls.filter(
      (call) => call.source === '-runWithExternal:' && call.target === '-appCategoryWork',
    );
    const binaryDeclaration = calls.filter(
      (call) => call.source === '-runWithBinary:' && call.target === '-binaryCategoryWork',
    );

    expect(external).toHaveLength(1);
    expect(result.graph.getNode(external[0]!.rel.targetId)?.properties.annotations).toEqual(
      expect.arrayContaining(['objc:owner:ExternalSDKType', 'objc:site:implementation']),
    );
    expect(binaryDeclaration).toHaveLength(1);
    expect(
      result.graph.getNode(binaryDeclaration[0]!.rel.targetId)?.properties.annotations,
    ).toEqual(expect.arrayContaining(['objc:owner:BinaryCategoryBase', 'objc:site:declaration']));
  });

  it('folds a class-name chain through a category-only declaration', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runBinaryCategoryChain',
    );

    expect(calls.map((call) => call.target).sort()).toEqual(['+binaryCategoryProduct', '-finish']);
    expect(
      result.graph.getNode(
        calls.find((call) => call.target === '+binaryCategoryProduct')!.rel.targetId,
      )?.properties.annotations,
    ).toEqual(expect.arrayContaining(['objc:owner:BinaryCategoryBase', 'objc:site:declaration']));
  });

  it('treats a typed local that shadows a class name as an instance receiver', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runWithShadow:' && call.target.endsWith('work'),
    );

    expect(calls.map((call) => call.target)).toEqual(['-work']);
  });

  it('preserves class and instance self receiver forms while folding message chains', () => {
    const calls = getRelationships(result, 'CALLS');
    const classSelfCalls = calls.filter((call) => call.source === '+runClassSelfChain');
    const instanceSelfCalls = calls.filter((call) => call.source === '-runInstanceSelfChain');

    expect(classSelfCalls.map((call) => call.target).sort()).toEqual(['+make', '-finish']);
    expect(instanceSelfCalls.map((call) => call.target).sort()).toEqual([
      '-finish',
      '-makeSibling',
    ]);
    for (const call of [...classSelfCalls, ...instanceSelfCalls]) {
      expect(result.graph.getNode(call.rel.targetId)?.properties.annotations).toContain(
        'objc:owner:SelfChainDispatch',
      );
    }
    expect(result.graph.getNode(classSelfCalls[0]!.rel.sourceId)?.properties.annotations).toContain(
      'objc:owner:SelfChainDispatch',
    );
  });

  it('preserves receiver form while folding message chains', () => {
    expect(getRelationships(result, 'CALLS')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: '-runWithGuard:', target: '-finish' }),
      ]),
    );
  });

  it('uses an unrelated declared object return instead of forcing method-family ownership', () => {
    const finishCall = getRelationships(result, 'CALLS').find(
      (call) =>
        call.source === '-run' &&
        call.sourceFilePath === 'SemanticDispatch.m' &&
        call.target === '-finish' &&
        result.graph
          .getNode(call.rel.sourceId)
          ?.properties.annotations?.includes('objc:owner:UnrelatedFactoryCaller'),
    );

    expect(finishCall).toBeDefined();
    expect(result.graph.getNode(finishCall!.rel.targetId)?.properties.annotations).toContain(
      'objc:owner:Product',
    );
  });

  it('does not fall back from a class receiver to an instance-only method', () => {
    const wrongCall = getRelationships(result, 'CALLS').find(
      (call) =>
        call.source === '-run' &&
        call.target === '-onlyInstance' &&
        result.graph
          .getNode(call.rel.sourceId)
          ?.properties.annotations?.includes('objc:owner:OnlyInstanceClassCaller'),
    );

    expect(wrongCall).toBeUndefined();
  });

  it('resolves category super from the host class direct superclass', () => {
    expect(getRelationships(result, 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: '-runCategory', target: '-categoryBaseWork' }),
      ]),
    );
  });

  it('keeps the category host as the related-result owner in a nested super chain', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runNestedCategory',
    );

    expect(calls.map((call) => call.target).sort()).toEqual([
      '-categoryFactory',
      '-categoryFinish',
    ]);
    expect(
      result.graph.getNode(calls.find((call) => call.target === '-categoryFactory')!.rel.targetId)
        ?.properties.annotations,
    ).toContain('objc:owner:CategoryBase');
    expect(
      result.graph.getNode(calls.find((call) => call.target === '-categoryFinish')!.rel.targetId)
        ?.properties.annotations,
    ).toContain('objc:owner:CategoryChild');
  });

  it('terminates super dispatch when no ancestor declares the selector', () => {
    expect(getRelationships(result, 'CALLS')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: '-runMissingSuper', target: '-childOnly' }),
      ]),
    );
    expect(getResolutionOutcomes(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '-childOnly',
          reason: 'receiver-unresolved',
          candidateIds: [],
        }),
      ]),
    );
  });

  it('preserves the lexical receiver owner through a nested super related-result chain', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '-runNestedSuper',
    );

    expect(calls.map((call) => call.target).sort()).toEqual(['-finish', '-init']);
    expect(
      result.graph.getNode(calls.find((call) => call.target === '-init')!.rel.targetId)?.properties
        .annotations,
    ).toContain('objc:owner:NestedSuperBase');
    expect(
      result.graph.getNode(calls.find((call) => call.target === '-finish')!.rel.targetId)
        ?.properties.annotations,
    ).toContain('objc:owner:NestedSuperChild');
  });

  it('preserves class dispatch for a nested super base before an instance result', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (call) => call.source === '+runNestedClassSuper',
    );

    expect(calls.map((call) => call.target).sort()).toEqual(['+make', '-finish']);
    expect(
      result.graph.getNode(calls.find((call) => call.target === '+make')!.rel.targetId)?.properties
        .annotations,
    ).toContain('objc:owner:NestedSuperBase');
    expect(
      result.graph.getNode(calls.find((call) => call.target === '-finish')!.rel.targetId)
        ?.properties.annotations,
    ).toContain('objc:owner:NestedSuperChild');
  });

  it('preserves Objective-C suppression reasons and candidate arrays', () => {
    const dynamicOutcome = getResolutionOutcomes(result).find(
      (outcome) => outcome.name === 'work' && outcome.reason === 'objective-c: dynamic-receiver',
    );

    expect(dynamicOutcome).toMatchObject({
      kind: 'suppressed',
      candidateIds: [],
    });
  });
});
