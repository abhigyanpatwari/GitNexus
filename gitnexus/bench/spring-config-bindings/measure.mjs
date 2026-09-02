/**
 * Build-free throughput + identity bench for Kotlin Spring config-consumer
 * capture (#2412).
 *
 * Arms (identical corpora except the import style):
 *   - exact: explicit `import ...annotation.Value` control, which resolves the
 *     annotation from `imports.exact` before any shadow check runs
 *   - wildcard: `import ...annotation.*` feature path, where every simple-name
 *     annotation pays the lexical local-type shadow walk. Each file also
 *     declares a sibling nested type named `Value` that must NOT suppress the
 *     Spring annotation — the file-wide-shadow regression fixed on this branch.
 *
 * Parsing is prepared outside the timer; the measured path is the capture
 * function the Kotlin worker calls on its own AST.
 *
 * Usage:
 *   node --import tsx bench/spring-config-bindings/measure.mjs
 *   node --import tsx bench/spring-config-bindings/measure.mjs --check
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.ts';
import { captureKotlinSpringConfigConsumerFacts } from '../../src/core/ingestion/languages/kotlin/spring-config-bindings.ts';
import { fingerprintIds, minSample, runBaselineCheck } from '../lib/identity-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 250;
const LARGE = 800;
const REPS = 15;
const WARMUP = 5;
/** Two @Value properties plus one @ConfigurationProperties class per file. */
const FACTS_PER_FILE = 3;

function consumerSource(i, mode) {
  const imports =
    mode === 'wildcard'
      ? `import org.springframework.beans.factory.annotation.*
import org.springframework.boot.context.properties.*`
      : `import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.context.properties.ConfigurationProperties`;

  return `package bench.config
${imports}

class Shadowing${i} {
  class Value
}

@ConfigurationProperties(prefix = "svc.${i}")
class Props${i} {
  var endpoint: String? = null
}

class Consumer${i} {
  @Value("\\\${app.key${i}}")
  var timeout: Int = 0

  @Value("\\\${app.other${i}:5}")
  var other: String? = null

  fun decoy() {}
}
`;
}

/** Position-free fact identity, so both arms are directly comparable. */
function factId(fact) {
  const consumer = fact.consumer;
  return consumer.kind === 'value'
    ? `value|${consumer.fieldName}|${[...consumer.keys].sort().join(',')}`
    : `configuration-properties|${consumer.className}|${consumer.prefix}`;
}

function prepare(mode, fileCount) {
  const files = [];
  const lang = getLanguageGrammar(SupportedLanguages.Kotlin);
  for (let i = 0; i < fileCount; i++) {
    const parser = new Parser();
    parser.setLanguage(lang);
    const filePath = `bench/${mode}/Consumer${i}.kt`;
    files.push({ tree: parser.parse(consumerSource(i, mode)), filePath, parser });
  }
  return files;
}

function runAll(files) {
  const ids = [];
  for (const f of files) {
    for (const fact of captureKotlinSpringConfigConsumerFacts(f.tree.rootNode, f.filePath)) {
      ids.push(factId(fact));
    }
  }
  return ids;
}

function measure(mode, fileCount) {
  const files = prepare(mode, fileCount);
  const { last, ms } = minSample(() => runAll(files), WARMUP, REPS);
  return {
    files: fileCount,
    ms,
    facts: last.length,
    fingerprint: fingerprintIds(last),
  };
}

function failIfNeeded(current, errors) {
  if (errors.length === 0) return;
  console.error(JSON.stringify({ report: current, errors }, null, 2));
  process.exit(1);
}

function runFactCountCheck(current, expectedCounts) {
  const errors = [];
  for (const [arm, expected] of Object.entries(expectedCounts)) {
    const actual = current[arm]?.facts;
    if (actual !== expected) errors.push(`${arm}.facts ${String(actual)} != ${expected}`);
  }
  failIfNeeded(current, errors);
}

/**
 * A wildcard import plus a sibling `Value` declaration must capture exactly the
 * facts the explicit-import control captures.
 */
function runFingerprintParityCheck(current, leftArm, rightArm) {
  const left = current[leftArm]?.fingerprint;
  const right = current[rightArm]?.fingerprint;
  failIfNeeded(
    current,
    left === right ? [] : [`${leftArm}.fingerprint ${left} != ${rightArm}.fingerprint ${right}`],
  );
}

const report = {
  exact_small: measure('exact', SMALL),
  exact_large: measure('exact', LARGE),
  wildcard_small: measure('wildcard', SMALL),
  wildcard_large: measure('wildcard', LARGE),
};
report.scaling_ratio = Number(
  (report.wildcard_large.ms / report.wildcard_small.ms / (LARGE / SMALL)).toFixed(3),
);
report.widening_overhead = Number(
  (report.wildcard_large.ms / Math.max(report.exact_large.ms, 0.001)).toFixed(3),
);
report.fingerprint = report.wildcard_large.fingerprint;

runFactCountCheck(report, {
  exact_large: LARGE * FACTS_PER_FILE,
  wildcard_large: LARGE * FACTS_PER_FILE,
});
runFingerprintParityCheck(report, 'exact_large', 'wildcard_large');

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

runBaselineCheck(report, BASELINE_PATH);
