import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { compareCodeUnits, compareReports } from '../compare.mjs';
import { gitNexusCallReport } from '../gitnexus-report.mjs';

const fixturesRoot = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));
const pythonReportScript = fileURLToPath(new URL('./python-report.py', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

function runCPythonReport(dir, entry, names) {
  const stdout = execFileSync(
    process.env.PYTHON_BIN ?? 'python3',
    ['-B', pythonReportScript, dir, entry, ...names],
    { encoding: 'utf8', windowsHide: true },
  );
  return JSON.parse(stdout);
}

const entries = Object.entries(manifest).sort(([a], [b]) => compareCodeUnits(a, b));
const failures = [];
let totalSites = 0;

for (const [name, config] of entries) {
  const dir = path.join(fixturesRoot, name);
  try {
    const expected = runCPythonReport(dir, config.entry, config.names);
    const pipeline = await runPipelineFromRepo(dir, () => {});
    const actual = gitNexusCallReport(pipeline, { names: config.names });
    compareReports(expected, actual);
    totalSites += expected.sites.length;
    console.log(`PASS ${name} (${expected.sites.length} sites, ${expected.edges.length} edges)`);
  } catch (error) {
    failures.push({ name, error: error instanceof Error ? error.message : String(error) });
    console.error(`FAIL ${name}\n${failures[failures.length - 1].error}`);
  }
}

console.log(
  `\nPython conformance: ${entries.length - failures.length}/${entries.length} fixtures passed (${totalSites} sites).`,
);

if (failures.length > 0) {
  process.exitCode = 1;
}
