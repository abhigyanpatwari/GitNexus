// CI gate for the nightly impact-PDG mutation oracle (#2227 tri-review, U11).
//
// The oracle (`measure.mjs --mutation --json`) uploads a machine report as a
// nightly artifact, but nothing read it back — a realized-recall regression
// would silently sit in an artifact nobody opens. This gate:
//   1. always writes a recall summary to the GitHub job summary (visible on the
//      run without downloading the artifact), and
//   2. fails the job when the MINIMUM realized recall across scored mutation
//      cases drops below MUTATION_RECALL_FLOOR (tunable env, conservative
//      default) — so a mutant the slicer stops catching surfaces as a red run.
//
// Usage: node bench/impact-pdg/gate-mutation-recall.mjs [report.json]
import fs from 'node:fs';

const reportPath = process.argv[2] ?? 'mutation-report.json';
const floor = Number(process.env.MUTATION_RECALL_FLOOR ?? '0.5');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const checks = Array.isArray(report?.mutation?.checks) ? report.mutation.checks : [];
const scored = checks.filter((c) => typeof c.recall === 'number');
const recalls = scored.map((c) => c.recall);
const min = recalls.length ? Math.min(...recalls) : null;
const mean = recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null;
const below = scored.filter((c) => c.recall < floor);
const fmt = (x) => (x === null ? 'n/a' : x.toFixed(3));

const summary = [
  '## impact-PDG mutation oracle',
  '',
  `- scored cases: ${scored.length} of ${checks.length}`,
  `- min realized recall: ${fmt(min)} (floor ${floor})`,
  `- mean realized recall: ${fmt(mean)}`,
  `- cases below floor: ${below.length}${below.length ? ' — ' + below.map((c) => c.name).join(', ') : ''}`,
  '',
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}
process.stdout.write(summary + '\n');

if (min !== null && min < floor) {
  console.error(`Mutation recall regression: min realized recall ${fmt(min)} < floor ${floor}`);
  process.exit(1);
}
