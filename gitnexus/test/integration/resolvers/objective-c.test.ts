import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import {
  FIXTURES,
  getNodesByLabel,
  getNodesByLabelFull,
  getRelationships,
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
    expect(getNodesByLabel(result, 'Class')).toEqual(expect.arrayContaining(['BaseStore', 'Store']));
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
      expect.arrayContaining([
        expect.objectContaining({ source: 'Store', target: 'BaseStore' }),
      ]),
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
      expect.arrayContaining([
        expect.objectContaining({ source: '-run', target: '-run' }),
      ]),
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
      expect.arrayContaining([
        expect.objectContaining({ source: '-run', target: 'ready' }),
      ]),
    );
  });
});
