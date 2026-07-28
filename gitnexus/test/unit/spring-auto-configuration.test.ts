import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  classifySpringAutoConfigurationMetadata,
  parseSpringAutoConfigurationImports,
  parseSpringFactoriesAutoConfigurations,
  springAutoConfigurationPhase,
} from '../../src/core/ingestion/pipeline-phases/spring-auto-configuration.js';
import type {
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { StructureOutput } from '../../src/core/ingestion/pipeline-phases/structure.js';
import { generateId } from '../../src/lib/utils.js';

describe('Spring Boot auto-configuration metadata parsing', () => {
  it('classifies modern imports and legacy spring.factories paths', () => {
    expect(
      classifySpringAutoConfigurationMetadata(
        'src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports',
      ),
    ).toMatchObject({ kind: 'imports' });
    expect(
      classifySpringAutoConfigurationMetadata('src/main/resources/META-INF/spring.factories'),
    ).toMatchObject({ kind: 'spring-factories' });
    expect(
      classifySpringAutoConfigurationMetadata(
        'SRC\\MAIN\\RESOURCES\\meta-inf\\SPRING\\ORG.SPRINGFRAMEWORK.BOOT.AUTOCONFIGURE.AUTOCONFIGURATION.IMPORTS',
      ),
    ).toMatchObject({ kind: 'imports' });
    expect(
      classifySpringAutoConfigurationMetadata(
        'not-meta-inf/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports',
      ),
    ).toBeNull();
    expect(classifySpringAutoConfigurationMetadata('application.properties')).toBeNull();
  });

  it('parses, validates, and de-duplicates AutoConfiguration.imports entries', () => {
    expect(
      parseSpringAutoConfigurationImports(`
# comment
com.example.FirstAutoConfiguration
com.example.SecondAutoConfiguration # trailing comment
not a class
com.example.FirstAutoConfiguration
`),
    ).toEqual([
      { className: 'com.example.FirstAutoConfiguration', line: 3 },
      { className: 'com.example.SecondAutoConfiguration', line: 4 },
    ]);
  });

  it('parses only EnableAutoConfiguration with properties continuations', () => {
    expect(
      parseSpringFactoriesAutoConfigurations(`
org.example.OtherFactory=com.example.Ignored
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\\
  com.example.LegacyOne,\\
  com.example.LegacyTwo
`),
    ).toEqual([
      { className: 'com.example.LegacyOne', line: 3 },
      { className: 'com.example.LegacyTwo', line: 3 },
    ]);
  });

  it('reports duplicate-FQN ambiguity and fails closed without a synthetic third class', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-auto-config-ambiguity-'));
    const relativePath =
      'META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports';
    const metadataPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    const content = 'com.example.DuplicateAutoConfiguration\n';
    fs.writeFileSync(metadataPath, content);

    try {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: generateId('File', relativePath),
        label: 'File',
        properties: { name: path.basename(relativePath), filePath: relativePath },
      });
      for (const moduleName of ['module-a', 'module-b']) {
        const node: GraphNode = {
          id: `Class:${moduleName}:DuplicateAutoConfiguration`,
          label: 'Class',
          properties: {
            name: 'DuplicateAutoConfiguration',
            qualifiedName: 'com.example.DuplicateAutoConfiguration',
            filePath: `${moduleName}/DuplicateAutoConfiguration.java`,
          },
        };
        graph.addNode(node);
      }

      const structure: StructureOutput = {
        scannedFiles: [{ path: relativePath, size: Buffer.byteLength(content) }],
        allPaths: [relativePath],
        allPathSet: new Set([relativePath]),
        totalFiles: 1,
      };
      const deps = new Map<string, PhaseResult<unknown>>([
        [
          'structure',
          {
            phaseName: 'structure',
            output: structure,
            durationMs: 0,
          },
        ],
      ]);
      const output = await springAutoConfigurationPhase.execute(
        {
          repoPath: dir,
          graph,
          onProgress: () => {},
          pipelineStart: performance.now(),
        } as PipelineContext,
        deps,
      );

      expect(output).toEqual({
        metadataFiles: 1,
        autoConfigurations: 0,
        ambiguousAutoConfigurations: 1,
      });
      expect([...graph.iterRelationshipsByType('DECLARES')]).toEqual([]);
      expect(
        [...graph.iterNodes()].filter(
          (node) =>
            node.label === 'Class' &&
            node.properties.qualifiedName === 'com.example.DuplicateAutoConfiguration',
        ),
      ).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
