import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vueProvider } from '../../../../src/core/ingestion/languages/vue.js';
import { getTsParser } from '../../../../src/core/ingestion/languages/typescript/query.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { extractVueScript } from '../../../../src/core/ingestion/vue-sfc-extractor.js';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from '../../../integration/resolvers/helpers.js';

const sources = Object.fromEntries(
  ['jsx', 'tsx', 'ts'].map((lang) => [
    lang,
    `<script setup lang="${lang}">
import { Widget } from './target';
function setupCaller() { const ns = require('./target'); return ns.run(); }
${lang === 'ts' ? '' : `function render(value${lang === 'tsx' ? ': number' : ''}) { return <Widget value={value} />; }`}
</script>
<template>
  <div />
</template>
<script lang="${lang}">
function normalCaller() { const ns = require('./target'); return ns.run(); }
</script>`,
  ]),
);

describe('Vue embedded script grammar and source positions', () => {
  let repo: string;
  let result: PipelineResult;
  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-vue-embedded-'));
    writeFixtureRepo(repo, {
      'target.ts':
        'export function run() { return 1; }\nexport function Widget(value) { return value; }',
      ...Object.fromEntries(
        Object.entries(sources).map(([lang, source]) => [`${lang}.vue`, source]),
      ),
    });
    result = await runPipelineFromRepo(repo, () => {}, {
      workerPoolSize: 1,
      skipGraphPhases: true,
      pdg: true,
    });
  }, 120_000);
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it.each(['jsx', 'tsx', 'ts'])(
    'maps reordered %s script declarations to original source rows in both paths',
    (lang) => {
      const source = sources[lang];
      const extracted = extractVueScript(source)!;
      expect(extracted.lang).toBe(lang);
      expect(extracted.sourceLineMap).toHaveLength(extracted.scriptContent.split('\n').length);
      const full = extractParsedFile(vueProvider, source, `${lang}.vue`)!;
      const worker = extractParsedFile(
        vueProvider,
        extracted.scriptContent,
        `${lang}.vue`,
        undefined,
        undefined,
        'pre-extracted-script',
        undefined,
        extracted.lineOffset,
        extracted.lang,
        extracted.sourceLineMap,
      )!;
      expect(worker.localDefs).toEqual(full.localDefs);
      for (const name of ['setupCaller', 'normalCaller']) {
        const originalRow = source
          .split('\n')
          .findIndex((line) => line.startsWith(`function ${name}`));
        const definition = full.localDefs.find((def) => def.qualifiedName === name)!;
        expect(definition.graphPosition).toEqual({ startLine: originalRow + 1, startCol: 0 });
        const graphNode = result.graph.getNode(`Function:${lang}.vue:${name}`)!;
        expect(graphNode.properties.startLine).toBe(originalRow);
        const blocks = [...result.graph.iterNodes()].filter(
          (node) =>
            node.label === 'BasicBlock' &&
            node.properties.filePath === `${lang}.vue` &&
            node.properties.text?.includes('ns.run()'),
        );
        expect(blocks.some((block) => block.properties.startLine === originalRow + 1)).toBe(true);
        expect(
          getRelationships(result, 'CALLS')
            .filter(
              (edge) =>
                edge.sourceFilePath === `${lang}.vue` &&
                edge.source === name &&
                edge.target === 'run',
            )
            .map((edge) => edge.rel.targetId),
        ).toEqual(['Function:target.ts:run']);
      }
    },
  );

  it.each(['jsx', 'tsx'])(
    'retains %s component calls through direct extraction and real workers',
    (lang) => {
      const parsed = extractParsedFile(vueProvider, sources[lang], `${lang}.vue`)!;
      expect(
        parsed.referenceSites.some((site) => site.name === 'Widget' && site.kind === 'call'),
      ).toBe(true);
      expect(
        getRelationships(result, 'CALLS')
          .filter(
            (edge) =>
              edge.sourceFilePath === `${lang}.vue` &&
              edge.source === 'render' &&
              edge.target === 'Widget',
          )
          .map((edge) => edge.rel.targetId),
      ).toEqual(['Function:target.ts:Widget']);
    },
  );

  it('reparses a cached TypeScript tree for a TSX embedded script', () => {
    const extracted = extractVueScript(sources.tsx)!;
    const wrongTree = getTsParser('wrong.ts').parse(extracted.scriptContent);
    const parsed = extractParsedFile(
      vueProvider,
      extracted.scriptContent,
      'tsx.vue',
      undefined,
      wrongTree,
      'pre-extracted-script',
      undefined,
      extracted.lineOffset,
      extracted.lang,
      extracted.sourceLineMap,
    )!;
    expect(
      parsed.referenceSites.some((site) => site.name === 'Widget' && site.kind === 'call'),
    ).toBe(true);
  });

  it('selects TSX when TypeScript and JSX blocks are combined', () => {
    expect(
      extractVueScript(
        '<script lang="ts">const n: number = 1;</script><script setup lang="jsx">const node = <Widget />;</script>',
      )!.lang,
    ).toBe('tsx');
  });

  it('rejects a native TypeScript tree when extracting JSX scope captures', () => {
    const extracted = extractVueScript(sources.jsx)!;
    const wrongTree = getTsParser('wrong.ts').parse(extracted.scriptContent);
    const parsed = extractParsedFile(vueProvider, sources.jsx, 'jsx.vue', undefined, wrongTree)!;
    expect(
      parsed.referenceSites.some((site) => site.name === 'Widget' && site.kind === 'call'),
    ).toBe(true);
  });
});
