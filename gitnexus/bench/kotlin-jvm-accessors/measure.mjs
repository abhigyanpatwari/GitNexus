/**
 * Build-free throughput + identity bench for Kotlin JVM accessor synthesis.
 *
 * Arms:
 *   - no_props: classes with no val/var properties (control)
 *   - data_class: data class constructor properties (feature path)
 *
 * Usage:
 *   node --import tsx bench/kotlin-jvm-accessors/measure.mjs
 *   node --import tsx bench/kotlin-jvm-accessors/measure.mjs --check
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.ts';
import { synthesizeKotlinJvmAccessors } from '../../src/core/ingestion/languages/kotlin/jvm-accessors.ts';
import { fingerprintIds, minSample, runBaselineCheck } from '../lib/identity-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 250;
const LARGE = 800;
const REPS = 15;
const WARMUP = 5;

function entitySource(i, mode) {
  if (mode === 'data') {
    return `data class Entity${i}(var id: String, var name: String, var active: Boolean, var amount: Long)
`;
  }
  // Custom accessors so the synthesizer no-ops; AST size stays comparable
  // to the data-class arm (same 4 properties).
  return `class Entity${i} {
  var id: String = ""
    get() = field
    set(v) { field = v }
  var name: String = ""
    get() = field
    set(v) { field = v }
  var active: Boolean = false
    get() = field
    set(v) { field = v }
  var amount: Long = 0
    get() = field
    set(v) { field = v }
}
`;
}

function ownerMap(tree, filePath) {
  const map = new Map();
  const walk = (node) => {
    if (node.type === 'class_declaration' || node.type === 'object_declaration') {
      const name =
        node.childForFieldName('name')?.text ??
        node.namedChildren.find((c) => c.type === 'type_identifier')?.text;
      if (name) map.set(node.id, `Class:${filePath}:${name}`);
    }
    for (const c of node.children) walk(c);
  };
  walk(tree.rootNode);
  return map;
}

function prepare(mode, fileCount) {
  const files = [];
  const lang = getLanguageGrammar(SupportedLanguages.Kotlin);
  for (let i = 0; i < fileCount; i++) {
    const parser = new Parser();
    parser.setLanguage(lang);
    const filePath = `bench/${mode}/Entity${i}.kt`;
    const tree = parser.parse(entitySource(i, mode));
    files.push({ tree, filePath, owners: ownerMap(tree, filePath), parser });
  }
  return files;
}

function runAll(files) {
  const nodes = [];
  for (const f of files) {
    const result = synthesizeKotlinJvmAccessors(f.tree, f.filePath, f.owners);
    for (const n of result.nodes) nodes.push(n.id);
  }
  return nodes;
}

function measure(mode, fileCount) {
  const files = prepare(mode, fileCount);
  const { last, ms } = minSample(() => runAll(files), WARMUP, REPS);
  return {
    files: fileCount,
    ms,
    methods: last.length,
    fingerprint: fingerprintIds(last),
  };
}

const report = {
  no_props_small: measure('hand', SMALL),
  no_props_large: measure('hand', LARGE),
  data_small: measure('data', SMALL),
  data_large: measure('data', LARGE),
};
report.scaling_ratio = Number(
  (report.data_large.ms / report.data_small.ms / (LARGE / SMALL)).toFixed(3),
);
report.widening_overhead = Number(
  (report.data_large.ms / Math.max(report.no_props_large.ms, 0.001)).toFixed(3),
);
report.fingerprint = report.data_large.fingerprint;

if (report.no_props_large.methods !== 0) {
  console.error(`no_props_large must emit 0 methods, got ${report.no_props_large.methods}`);
  process.exit(1);
}
if (report.data_large.methods !== 6400) {
  console.error(
    `data_large must emit 6400 methods (800 files × 4 vars × 2 accessors), got ${report.data_large.methods}`,
  );
  process.exit(1);
}

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

runBaselineCheck(report, BASELINE_PATH);
