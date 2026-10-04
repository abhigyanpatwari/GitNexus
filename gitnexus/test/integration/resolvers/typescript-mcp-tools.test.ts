import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';
import {
  FIXTURES,
  findDanglingEdges,
  getNodesByLabel,
  getNodesByLabelFull,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('JavaScript and TypeScript SDK tool registrations', () => {
  let result: PipelineResult;
  const unresolved = [
    'inline_callback',
    'imported_callback',
    'parameter_callback',
    'mutable_callback',
    'reassigned_callback',
    'shadowed_callback',
    'alias_callback',
    'first_block_callback',
    'second_block_callback',
  ];

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-mcp-tools'), () => {});
  }, 60000);

  it.each(['ts', 'js'])(
    'does not emit tools for a destructured method replacement in %s',
    async (extension) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-tool-write-'));
      try {
        fs.writeFileSync(
          path.join(repo, `server.${extension}`),
          `
        import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
        const replaced = new McpServer({ name: 'replaced', version: '1' });
        ({ registerTool: replaced.registerTool } = { registerTool: () => undefined });
        replaced.registerTool('fake', {}, () => ({ content: [] }));
        const actual = new McpServer({ name: 'actual', version: '1' });
        actual.registerTool('real', {}, () => ({ content: [] }));
      `,
        );
        const pipeline = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
        expect(getNodesByLabel(pipeline, 'Tool')).toEqual(['real']);
        expect(findDanglingEdges(pipeline, ['HANDLES_TOOL', 'ENTRY_POINT_OF'])).toEqual([]);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.each(['ts', 'js'])(
    'preserves namespace registrations through cold/warm %s parsing',
    async (extension) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-namespace-'));
      const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-namespace-cache-'));
      try {
        fs.writeFileSync(
          path.join(repo, `server.${extension}`),
          `
        import * as SDK from '@modelcontextprotocol/sdk/server/mcp.js';
        const server = new SDK.McpServer({});
        function handleNamespace() { return { content: [] }; }
        server.registerTool('namespace', { description: 'Namespace tool' }, handleNamespace);
        const replaced = new SDK.McpServer({});
        ({ method: replaced.registerTool } = other);
        replaced.registerTool('fake', {}, handleNamespace);
        ${extension === 'ts' ? "function install(typed: SDK.McpServer) { typed.tool('typed_namespace', handleNamespace); }" : ''}
      `,
        );
        const cache: ParseCache = {
          version: PARSE_CACHE_VERSION,
          entries: new Map(),
          usedKeys: new Set(),
          storagePath: storageDir,
          onDiskKeys: new Set(),
        };
        const cold = await runPipelineFromRepo(repo, () => {}, {
          parseCache: cache,
          workerPoolSize: 1,
        });
        expect(cold.usedWorkerPool).toBe(true);
        pruneCache(cache, cache.usedKeys);
        const keys = await saveParseCache(storageDir, cache);
        await pruneAndSaveDurableParsedFileStore(
          getDurableParsedFileDir(storageDir),
          PARSE_CACHE_VERSION,
          new Set(keys),
        );
        const warmCache = await loadParseCache(storageDir);
        expect(warmCache).not.toBeNull();
        const warm = await runPipelineFromRepo(repo, () => {}, {
          parseCache: warmCache!,
          workerPoolSize: 1,
        });
        expect(warm.usedWorkerPool).toBe(false);
        for (const pipeline of [cold, warm]) {
          expect(getNodesByLabel(pipeline, 'Tool')).toEqual(
            extension === 'ts' ? ['namespace', 'typed_namespace'] : ['namespace'],
          );
          expect(
            getNodesByLabelFull(pipeline, 'Tool').find((tool) => tool.name === 'namespace')
              ?.properties.description,
          ).toBe('Namespace tool');
          expect(
            getRelationships(pipeline, 'HANDLES_TOOL').filter(
              (edge) => edge.target === 'namespace',
            ),
          ).toMatchObject([{ source: 'handleNamespace', sourceLabel: 'Function' }]);
          expect(findDanglingEdges(pipeline, ['HANDLES_TOOL', 'ENTRY_POINT_OF'])).toEqual([]);
        }
        expect(getNodesByLabelFull(warm, 'Tool')).toEqual(getNodesByLabelFull(cold, 'Tool'));
        expect(getRelationships(warm, 'HANDLES_TOOL')).toEqual(
          getRelationships(cold, 'HANDLES_TOOL'),
        );
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it('discovers ordinary server files alongside deduplicated object manifests', () => {
    expect(getNodesByLabel(result, 'Tool')).toEqual(
      [
        ...unresolved,
        'search-files',
        'read_file',
        'function_expression_tool',
        'js_ping',
        'manifest_tool',
      ].sort(),
    );
    const tools = new Map(
      getNodesByLabelFull(result, 'Tool').map((tool) => [tool.name, tool.properties]),
    );
    expect(tools.get('search-files')).toMatchObject({
      filePath: 'src/server.ts',
      description: 'Search files',
    });
    expect(tools.get('read_file')).toMatchObject({
      filePath: 'src/server.ts',
      description: 'Read a file',
    });
    expect(tools.get('js_ping')).toMatchObject({
      filePath: 'src/server.js',
      description: 'Ping JavaScript',
    });
    expect(tools.get('manifest_tool')).toMatchObject({
      filePath: 'src/tools.ts',
      description: 'Existing object manifest',
    });
    expect(tools.get('inline_callback')?.description).toBe('');
  });

  it('uses actual emitted callable nodes for supported local handlers', () => {
    const edges = getRelationships(result, 'HANDLES_TOOL');
    for (const [tool, handler] of [
      ['search-files', 'searchFiles'],
      ['read_file', 'readFile'],
      ['function_expression_tool', 'expressionHandler'],
      ['js_ping', 'jsPing'],
    ]) {
      expect(edges.filter((edge) => edge.target === tool)).toMatchObject([
        { source: handler, sourceLabel: 'Function' },
      ]);
    }
    expect(findDanglingEdges(result, ['HANDLES_TOOL', 'ENTRY_POINT_OF'])).toEqual([]);
  });

  it('links each same-file named handler only to its own execution flow', () => {
    const edges = getRelationships(result, 'ENTRY_POINT_OF').filter(
      (edge) => edge.sourceLabel === 'Tool',
    );
    for (const [tool, handler] of [
      ['search-files', 'searchFiles'],
      ['read_file', 'readFile'],
    ]) {
      const flows = edges.filter((edge) => edge.source === tool);
      expect(flows).toHaveLength(1);
      const process = result.graph.getNode(flows[0].rel.targetId)!;
      const entry = result.graph.getNode(process.properties.entryPointId as string)!;
      expect(entry.properties.name).toBe(handler);
    }
  });

  it('keeps unresolved callbacks at file attribution without unrelated same-file flows', () => {
    const handles = getRelationships(result, 'HANDLES_TOOL');
    const flows = getRelationships(result, 'ENTRY_POINT_OF');
    expect(
      getNodesByLabelFull(result, 'Process').some((process) => {
        const entry = result.graph.getNode(process.properties.entryPointId as string);
        return entry?.properties.name === 'unrelatedEntry';
      }),
    ).toBe(true);
    for (const name of unresolved) {
      expect(handles.filter((edge) => edge.target === name)).toMatchObject([
        { sourceLabel: 'File', sourceFilePath: 'src/server.ts' },
      ]);
      expect(flows.filter((edge) => edge.sourceLabel === 'Tool' && edge.source === name)).toEqual(
        [],
      );
    }
  });

  it('preserves tool metadata, handler identities, and flow attribution on warm replay', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-tools-cache-'));
    try {
      const cold: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storageDir,
        onDiskKeys: new Set(),
      };
      const fixture = path.join(FIXTURES, 'typescript-mcp-tools');
      const initial = await runPipelineFromRepo(fixture, () => {}, {
        parseCache: cold,
        workerPoolSize: 1,
      });
      expect(initial.usedWorkerPool).toBe(true);
      pruneCache(cold, cold.usedKeys);
      const savedKeys = await saveParseCache(storageDir, cold);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storageDir),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );
      const warm = await loadParseCache(storageDir);
      expect(warm).not.toBeNull();
      const replay = await runPipelineFromRepo(fixture, () => {}, {
        parseCache: warm!,
        workerPoolSize: 1,
      });
      expect(replay.usedWorkerPool).toBe(false);

      const project = (pipeline: PipelineResult) => ({
        tools: getNodesByLabelFull(pipeline, 'Tool'),
        edges: [
          ...getRelationships(pipeline, 'HANDLES_TOOL'),
          ...getRelationships(pipeline, 'ENTRY_POINT_OF').filter(
            (edge) => edge.sourceLabel === 'Tool',
          ),
        ]
          .map(({ rel, source }) => ({
            type: rel.type,
            source,
            sourceId: rel.sourceId,
            targetId: rel.targetId,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      });
      const expected = project(initial);
      expect(expected.tools).toHaveLength(unresolved.length + 5);
      expect(project(replay)).toEqual(expected);
      for (const name of unresolved) {
        expect(
          expected.edges.filter((edge) => edge.type === 'ENTRY_POINT_OF' && edge.source === name),
        ).toEqual([]);
      }
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  }, 120_000);
});
