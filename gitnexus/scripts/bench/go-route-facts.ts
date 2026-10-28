/**
 * Compare Go route collection in two compiled builds, with exact output parity.
 * Run after building both checkouts:
 * node --expose-gc --import tsx scripts/bench/go-route-facts.ts /baseline/gitnexus/dist
 *
 * Parsing and module startup are excluded. Nine batches alternate build order;
 * serialized bytes measure the worker payload, not heap or whole-index memory.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import type { ParsedFile } from 'gitnexus-shared';
import type { LanguageProvider } from '../../src/core/ingestion/language-provider.js';

const baseline = process.argv[2];
assert(baseline, 'Pass the baseline build directory (gitnexus/dist)');
const builds = [path.resolve(baseline), fileURLToPath(new URL('../../dist', import.meta.url))];
const providers: LanguageProvider[] = await Promise.all(
  builds.map(
    async (dir) =>
      (await import(pathToFileURL(path.join(dir, 'core/ingestion/languages/go.js')).href))
        .goProvider,
  ),
);
const parser = new Parser();
parser.setLanguage(Go);
const parsedFile: ParsedFile = {
  filePath: 'routes.go',
  moduleScope: 'bench' as ParsedFile['moduleScope'],
  scopes: [],
  parsedImports: [],
  localDefs: [],
  referenceSites: [],
};
const config = {
  routeFrameworkAliases: [
    { importPath: 'example.com/infra/pkg', type: 'Engine', framework: 'gin' },
  ],
  routeHandlerWrappers: ['common.Wrapper'],
};
// The baseline used flat hook options; the current build receives one object.
const context = { resolveImportTargets: () => [], ...config, routeHookConfig: config };
const lines = (count: number, line: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => line(i)).join('\n');
const workloads = {
  noRoutes: `package routes\nimport "fmt"\n${lines(100, (i) => `func F${i}(x int) int { fmt.Println(x); return x + 1 }`)}`,
  direct: `package routes\nimport "github.com/gin-gonic/gin"\nfunc R(r *gin.Engine) {\n${lines(100, (i) => `r.GET("/${i}", Middleware, Handler)`)}\n}`,
  wrapped: `package routes\nimport core "example.com/infra/pkg"\nimport "example.com/app/common"\nfunc R(r *core.Engine) {\n${lines(100, (i) => `r.GET("/${i}", Middleware, common.Wrapper(Handler))`)}\n}`,
  mixed: `package routes\nimport "github.com/gin-gonic/gin"\nimport core "example.com/infra/pkg"\nfunc R(r *gin.Engine, s *core.Engine) {\n${lines(100, (i) => `${i % 2 ? 'r' : 's'}.GET("/${i}", Middleware, Handler)`)}\n}`,
  manyParameters: `package routes\nimport core "example.com/infra/pkg"\nfunc R(r *core.Engine, ${Array.from({ length: 30 }, (_, i) => `x${i} *core.T${i}`).join(', ')}) {\n${lines(100, (i) => `r.GET("/${i}", Middleware, Handler)`)}\n}`,
};

const results = [];
for (const [name, source] of Object.entries(workloads)) {
  const tree = parser.parse(source);
  const collect = (provider: LanguageProvider) => ({
    direct: provider.extractDecoratorRoutes?.(tree, parsedFile.filePath, 0) ?? [],
    facts: provider.extractRouteFacts?.(tree, parsedFile, 0),
  });
  const outputs = providers.map((provider) => {
    const { direct, facts } = collect(provider);
    return [
      ...provider.resolveRouteFacts!([{ filePath: parsedFile.filePath, facts }], context),
      ...direct,
    ];
  });
  assert.deepEqual(outputs[1], outputs[0], `${name}: route/handler/order parity`);
  assert.equal(outputs[0].length, name === 'noRoutes' ? 0 : 100);
  for (const provider of providers) for (let i = 0; i < 20; i++) collect(provider);
  const samples: number[][] = [[], []];
  const iterations = name === 'manyParameters' ? 30 : 75;
  for (let round = 0; round < 9; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      global.gc?.();
      const start = performance.now();
      for (let i = 0; i < iterations; i++) collect(providers[index]);
      samples[index].push((performance.now() - start) / iterations);
    }
  }
  results.push({
    name,
    routes: outputs[0].length,
    iterations,
    sampleMs: samples,
    medianMs: samples.map((sample) => [...sample].sort((a, b) => a - b)[4]),
    serializedFactsBytes: providers.map((provider) =>
      Buffer.byteLength(JSON.stringify(collect(provider))),
    ),
  });
}
console.log(JSON.stringify({ node: process.version, builds, results }, null, 2));
