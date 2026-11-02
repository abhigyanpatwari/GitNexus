/**
 * Build-free throughput + identity benchmark for Kotlin package-star route constants.
 *
 * Arms:
 *   - named: explicit `import bench.constants.ROUTE_n` control
 *   - star: `import bench.constants.*` feature path
 *
 * Parsing is prepared outside the timer. The measured path mirrors the Kotlin
 * group plugin: overlay one importing controller on the prepared constant
 * index, then fold its route.
 *
 * Usage:
 *   node --import tsx bench/kotlin-star-route-constants/measure.mjs
 *   node --import tsx bench/kotlin-star-route-constants/measure.mjs --check
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.ts';
import {
  buildKotlinConstantIndex,
  extractKotlinModuleConstants,
  foldKotlinOperands,
  overlayKotlinConstantIndex,
} from '../../src/core/ingestion/route-extractors/kotlin-const-resolver.ts';
import {
  fingerprintIds,
  minSampleFresh,
  runBaselineCheck,
  runCountCheck,
  runFingerprintParityCheck,
} from '../lib/route-constant-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');
const SMALL = 250;
const LARGE = 800;
const REPS = 15;
const WARMUP = 5;

const parser = new Parser();
parser.setLanguage(requireVendoredGrammar('tree-sitter-kotlin'));

function constantsSource(i) {
  return `package bench.constants
const val ROUTE_${i} = "/api/routes/${i}"
`;
}

function controllerSource(i, mode) {
  const route = `ROUTE_${i}`;
  const imported = mode === 'star' ? 'import bench.constants.*' : `import bench.constants.${route}`;
  return `package bench.web
${imported}
class Controller${i}
`;
}

function cloneConstants(mc) {
  return {
    literals: new Map(mc.literals),
    exprs: new Map(mc.exprs),
    imports: new Map(mc.imports),
    wildcardImports: mc.wildcardImports ? [...mc.wildcardImports] : undefined,
    packageName: mc.packageName,
    unfoldableDeclarations: new Set(mc.unfoldableDeclarations),
    topLevelDeclarations: new Set(mc.topLevelDeclarations),
  };
}

function prepare(mode, fileCount) {
  const constants = [];
  const controllers = [];
  for (let i = 0; i < fileCount; i++) {
    constants.push({
      key: `bench/constants/ApiPaths${i}.kt`,
      constants: extractKotlinModuleConstants(parser.parse(constantsSource(i))),
    });
    controllers.push({
      key: `bench/web/Controller${i}.kt`,
      route: `ROUTE_${i}`,
      constants: extractKotlinModuleConstants(parser.parse(controllerSource(i, mode))),
    });
  }
  return { constants, controllers };
}

function instantiate(prepared) {
  const baseRepo = new Map();
  for (const constant of prepared.constants) {
    baseRepo.set(constant.key, cloneConstants(constant.constants));
  }
  const controllers = prepared.controllers.map((controller) => ({
    key: controller.key,
    route: controller.route,
    constants: cloneConstants(controller.constants),
  }));
  return { baseRepo, controllers };
}

function runAll(instance) {
  const { baseRepo, controllers } = instance;
  const baseIndex = buildKotlinConstantIndex(baseRepo);
  const routes = [];
  for (const controller of controllers) {
    const index = overlayKotlinConstantIndex(baseIndex, controller.key, controller.constants);
    const route = foldKotlinOperands(
      controller.key,
      [{ kind: 'ref', name: controller.route }],
      index.repo,
      [],
      index,
    );
    if (route !== null) routes.push(`${controller.key}:${route}`);
  }
  return routes;
}

function measure(mode, fileCount) {
  const prepared = prepare(mode, fileCount);
  const { last, ms } = minSampleFresh(() => instantiate(prepared), runAll, WARMUP, REPS);
  return {
    files: fileCount,
    ms,
    routes: last.length,
    fingerprint: fingerprintIds(last),
  };
}

const report = {
  named_small: measure('named', SMALL),
  named_large: measure('named', LARGE),
  star_small: measure('star', SMALL),
  star_large: measure('star', LARGE),
};
report.scaling_ratio = Number(
  (report.star_large.ms / report.star_small.ms / (LARGE / SMALL)).toFixed(3),
);
report.widening_overhead = Number(
  (report.star_large.ms / Math.max(report.named_large.ms, 0.001)).toFixed(3),
);
report.absolute_ms = report.star_large.ms;
report.fingerprint = report.star_large.fingerprint;

runCountCheck(report, 'routes', {
  named_large: LARGE,
  star_large: LARGE,
});
runFingerprintParityCheck(report, 'named_large', 'star_large');

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

runBaselineCheck(report, BASELINE_PATH);
