/**
 * Build-free throughput + identity benchmark for Java wildcard-static route constants.
 *
 * Arms:
 *   - named: explicit `import static ...ApiPaths.ROUTE_n` control
 *   - wildcard: `import static ...ApiPaths.*` feature path
 *
 * Parsing is prepared outside the timer. The measured path mirrors ingestion:
 * build the constant-key index once, materialize pending wildcard imports, then
 * read the resulting binding. Route folding itself has separate integration
 * coverage and an older per-fold index cost shared by both arms.
 *
 * Usage:
 *   node --import tsx bench/java-wildcard-route-constants/measure.mjs
 *   node --import tsx bench/java-wildcard-route-constants/measure.mjs --check
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  buildJavaConstantIndex,
  expandJavaWildcardStaticImports,
  extractJavaModuleConstants,
} from '../../src/core/ingestion/route-extractors/java-const-resolver.ts';
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
parser.setLanguage(Java);

function constantsSource(i) {
  return `package bench.constants;
public final class ApiPaths${i} {
  public static final String ROUTE = "/api/routes/${i}";
}
`;
}

function controllerSource(i, mode) {
  const fqn = `bench.constants.ApiPaths${i}`;
  const imported = mode === 'wildcard' ? `import static ${fqn}.*;` : `import static ${fqn}.ROUTE;`;
  return `package bench.web;
${imported}
class Controller${i} {}
`;
}

function cloneConstants(mc) {
  return {
    literals: new Map(mc.literals),
    exprs: new Map(mc.exprs),
    imports: new Map(mc.imports),
    wildcardImports: mc.wildcardImports ? [...mc.wildcardImports] : undefined,
  };
}

function prepare(mode, fileCount) {
  const constants = [];
  const controllers = [];
  for (let i = 0; i < fileCount; i++) {
    constants.push({
      key: `bench/constants/ApiPaths${i}.java`,
      constants: extractJavaModuleConstants(parser.parse(constantsSource(i))),
    });
    controllers.push({
      key: `bench/web/Controller${i}.java`,
      route: 'ROUTE',
      constants: extractJavaModuleConstants(parser.parse(controllerSource(i, mode))),
    });
  }
  return { constants, controllers };
}

function instantiate(prepared) {
  const repo = new Map();
  for (const constant of prepared.constants) {
    repo.set(constant.key, cloneConstants(constant.constants));
  }
  const controllers = [];
  for (const controller of prepared.controllers) {
    repo.set(controller.key, cloneConstants(controller.constants));
    controllers.push({ key: controller.key, route: controller.route });
  }
  return { repo, controllers };
}

function runAll(instance) {
  const { repo, controllers } = instance;
  const constantIndex = buildJavaConstantIndex(repo);
  const bindings = [];
  for (const controller of controllers) {
    const mc = repo.get(controller.key);
    expandJavaWildcardStaticImports(mc, controller.key, repo, constantIndex);
    const binding = mc.imports.get(controller.route);
    if (binding) {
      bindings.push(
        `${controller.key}:${controller.route}:${binding.module}:${binding.originalName}`,
      );
    }
  }
  return bindings;
}

function measure(mode, fileCount) {
  const prepared = prepare(mode, fileCount);
  // Expansion mutates each importing file's `imports` map. Give every timed
  // sample a fresh repo, but build those clones outside the timer.
  const { last, ms } = minSampleFresh(() => instantiate(prepared), runAll, WARMUP, REPS);
  return {
    files: fileCount,
    ms,
    bindings: last.length,
    fingerprint: fingerprintIds(last),
  };
}

const report = {
  named_small: measure('named', SMALL),
  named_large: measure('named', LARGE),
  wildcard_small: measure('wildcard', SMALL),
  wildcard_large: measure('wildcard', LARGE),
};
report.scaling_ratio = Number(
  (report.wildcard_large.ms / report.wildcard_small.ms / (LARGE / SMALL)).toFixed(3),
);
report.overhead_us_per_binding = Number(
  (
    ((report.wildcard_large.ms - report.named_large.ms) * 1000) /
    report.wildcard_large.bindings
  ).toFixed(3),
);
report.absolute_ms = report.wildcard_large.ms;
report.fingerprint = report.wildcard_large.fingerprint;

runCountCheck(report, 'bindings', {
  named_large: LARGE,
  wildcard_large: LARGE,
});
runFingerprintParityCheck(report, 'named_large', 'wildcard_large');

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

runBaselineCheck(report, BASELINE_PATH);
