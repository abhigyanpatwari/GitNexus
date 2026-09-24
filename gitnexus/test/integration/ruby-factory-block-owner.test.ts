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

  BraceType = Class.new {
    def brace_method = 1
  }

  ArbitraryType = Builder.make do
    def arbitrary_method = 1
  end

  module Nested
    ClassType = Class.new do
      def nested_class_method = 1
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
    ['StructType', 'Struct', 'struct_method'],
    ['DataType', 'Class', 'data_method'],
    ['ClassType', 'Class', 'class_method'],
    ['ModuleType', 'Trait', 'module_method'],
    ['BraceType', 'Class', 'brace_method'],
  ])(
    'materializes %s as a %s and attributes its factory-block method',
    (owner, ownerLabel, method) => {
      const ownerNode = result.graph.nodes.find(
        (node) => node.label === ownerLabel && node.properties.name === owner,
      );
      const ownership = getRelationships(result, 'HAS_METHOD').filter(
        (edge) => edge.target === method,
      );

      expect(ownerNode).toBeDefined();
      expect(ownership.map((edge) => edge.source)).toEqual([owner]);
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
});
