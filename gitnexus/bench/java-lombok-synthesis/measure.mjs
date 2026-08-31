/**
 * Build-free throughput + identity bench for Java Lombok accessor synthesis.
 *
 * Arms:
 *   - no_lombok: hand-written getters/setters (control) — synthesizer no-ops
 *   - lombok_heavy: @Data classes (feature path)
 *
 * Times synthesizeLombokAccessors over N separate files (not one giant buffer).
 *
 * Usage:
 *   node --import tsx bench/java-lombok-synthesis/measure.mjs
 *   node --import tsx bench/java-lombok-synthesis/measure.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { synthesizeLombokAccessors } from '../../src/core/ingestion/languages/java/lombok-synthesizer.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 250;
const LARGE = 800;
const REPS = 15;
const WARMUP = 5;

function entitySource(i, mode) {
  if (mode === 'lombok') {
    return `import lombok.Data;
@Data
public class Entity${i} {
  private String id;
  private String name;
  private boolean active;
  private Long amount;
}
`;
  }
  return `public class Entity${i} {
  private String id;
  private String name;
  private boolean active;
  private Long amount;
  public String getId() { return id; }
  public void setId(String id) { this.id = id; }
  public String getName() { return name; }
  public void setName(String name) { this.name = name; }
  public boolean isActive() { return active; }
  public void setActive(boolean active) { this.active = active; }
  public Long getAmount() { return amount; }
  public void setAmount(Long amount) { this.amount = amount; }
}
`;
}

function ownerMap(tree, filePath) {
  const map = new Map();
  const walk = (node) => {
    if (node.type === 'class_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) map.set(node.id, `Class:${filePath}:${name}`);
    }
    for (const c of node.children) walk(c);
  };
  walk(tree.rootNode);
  return map;
}

function prepare(mode, fileCount) {
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const parser = new Parser();
    parser.setLanguage(Java);
    const filePath = `bench/${mode}/Entity${i}.java`;
    const tree = parser.parse(entitySource(i, mode));
    files.push({ tree, filePath, owners: ownerMap(tree, filePath), parser });
  }
  return files;
}

function runAll(files) {
  const nodes = [];
  for (const f of files) {
    const result = synthesizeLombokAccessors(f.tree, f.filePath, f.owners);
    for (const n of result.nodes) nodes.push(n.id);
  }
  return nodes;
}

function fingerprint(ids) {
  return crypto
    .createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

function measure(mode, fileCount) {
  const files = prepare(mode, fileCount);
  const run = () => runAll(files);
  for (let w = 0; w < WARMUP; w++) run();
  const samples = [];
  let last;
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    last = run();
    samples.push(performance.now() - t0);
  }
  return {
    files: fileCount,
    ms: Math.min(...samples),
    methods: last.length,
    fingerprint: fingerprint(last),
  };
}

const report = {
  no_lombok_small: measure('hand', SMALL),
  no_lombok_large: measure('hand', LARGE),
  lombok_small: measure('lombok', SMALL),
  lombok_large: measure('lombok', LARGE),
};
report.scaling_ratio = Number(
  (report.lombok_large.ms / report.lombok_small.ms / (LARGE / SMALL)).toFixed(3),
);
report.widening_overhead = Number(
  (report.lombok_large.ms / Math.max(report.no_lombok_large.ms, 0.001)).toFixed(3),
);
report.fingerprint = report.lombok_large.fingerprint;

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
const errors = [];
if (report.fingerprint !== baseline.fingerprint) {
  errors.push(`fingerprint drift: ${report.fingerprint} != ${baseline.fingerprint}`);
}
if (report.scaling_ratio > baseline.scaling_budget) {
  errors.push(`scaling_ratio ${report.scaling_ratio} > ${baseline.scaling_budget}`);
}
if (report.widening_overhead > baseline.widening_overhead_budget) {
  errors.push(
    `widening_overhead ${report.widening_overhead} > ${baseline.widening_overhead_budget}`,
  );
}
if (errors.length) {
  console.error(JSON.stringify({ report, errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, report }, null, 2));
