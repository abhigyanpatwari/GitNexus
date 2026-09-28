import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

describe('Ruby block-taking factory ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ruby-factory-owner-'));
  let result: PipelineResult;

  beforeAll(async () => {
    writeFixtureRepo(root, {
      'app.rb': `
class Outer
  StructType = Struct.new(:value) do
    def struct_method = value
  end

  DataType = Data.define(:value) do
    def data_method = value
  end

  ClassType = Class.new do
    def class_method = 1
  end

  ModuleType = Module.new do
    def module_method = 1
  end

  BraceStructType = Struct.new(:value) {
    def brace_struct_method = value
  }

  BraceDataType = Data.define(:value) {
    def brace_data_method = value
  }

  BraceClassType = Class.new {
    def brace_class_method = 1
  }

  BraceModuleType = Module.new {
    def brace_module_method = 1
  }

  ArbitraryType = Builder.make do
    def arbitrary_method = 1
  end

  module Nested
    ClassType = Class.new do
      def nested_class_method = 1
    end
  end

  First = Class.new do
    Item = Class.new do
      def first_item_method = 1
    end
  end

  Second = Class.new do
    Item = Class.new do
      def second_item_method = 1
    end
  end
end
`,
    });
    result = await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true });
  }, 120_000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['StructType', 'Struct', 'struct_method', 'Outer.StructType'],
    ['DataType', 'Class', 'data_method', 'Outer.DataType'],
    ['ClassType', 'Class', 'class_method', 'Outer.ClassType'],
    ['ModuleType', 'Trait', 'module_method', 'Outer.ModuleType'],
    ['BraceStructType', 'Struct', 'brace_struct_method', 'Outer.BraceStructType'],
    ['BraceDataType', 'Class', 'brace_data_method', 'Outer.BraceDataType'],
    ['BraceClassType', 'Class', 'brace_class_method', 'Outer.BraceClassType'],
    ['BraceModuleType', 'Trait', 'brace_module_method', 'Outer.BraceModuleType'],
  ])(
    'materializes %s as a %s and attributes its factory-block method',
    (owner, ownerLabel, method, qualifiedOwner) => {
      const ownerNode = result.graph.nodes.find(
        (node) =>
          node.label === ownerLabel &&
          node.properties.name === owner &&
          node.id.includes(qualifiedOwner),
      );
      const ownership = getRelationships(result, 'HAS_METHOD').filter(
        (edge) => edge.target === method,
      );

      expect(ownerNode).toBeDefined();
      expect(ownership.map((edge) => edge.rel.sourceId)).toEqual([ownerNode?.id]);
    },
  );

  it('does not treat an arbitrary block-taking call as a class factory', () => {
    const syntheticOwner = result.graph.nodes.find(
      (node) =>
        ['Class', 'Struct', 'Trait'].includes(node.label) &&
        node.properties.name === 'ArbitraryType',
    );
    const ownership = getRelationships(result, 'HAS_METHOD').filter(
      (edge) => edge.target === 'arbitrary_method',
    );

    expect(syntheticOwner).toBeUndefined();
    expect(ownership.map((edge) => edge.source)).toEqual(['Outer']);
  });

  it('keeps same-tail factory constants distinct across nested lexical scopes', () => {
    const owners = result.graph.nodes.filter(
      (node) => node.label === 'Class' && node.properties.name === 'ClassType',
    );
    const ownership = getRelationships(result, 'HAS_METHOD').filter(
      (edge) => edge.target === 'nested_class_method',
    );

    expect(owners).toHaveLength(2);
    expect(new Set(owners.map((node) => node.id)).size).toBe(2);
    const nestedOwner = owners.find((node) => node.id.includes('Outer.Nested.ClassType'));
    expect(nestedOwner).toBeDefined();
    expect(ownership.map((edge) => edge.rel.sourceId)).toEqual([nestedOwner?.id]);
  });

  it('keeps same-tail factories distinct when nested inside factory blocks', () => {
    const owners = result.graph.nodes.filter(
      (node) => node.label === 'Class' && node.properties.name === 'Item',
    );
    const firstOwner = owners.find((node) => node.id.includes('Outer.First.Item'));
    const secondOwner = owners.find((node) => node.id.includes('Outer.Second.Item'));
    const firstOwnership = getRelationships(result, 'HAS_METHOD').filter(
      (edge) => edge.target === 'first_item_method',
    );
    const secondOwnership = getRelationships(result, 'HAS_METHOD').filter(
      (edge) => edge.target === 'second_item_method',
    );

    expect(owners).toHaveLength(2);
    expect(firstOwner).toBeDefined();
    expect(secondOwner).toBeDefined();
    expect(firstOwnership.map((edge) => edge.rel.sourceId)).toEqual([firstOwner?.id]);
    expect(secondOwnership.map((edge) => edge.rel.sourceId)).toEqual([secondOwner?.id]);
  });
});
