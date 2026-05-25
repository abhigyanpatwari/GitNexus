/**
 * Consolidated scope-resolution parity runner.
 *
 * Replaces the per-language matrix in ci-scope-parity.yml with a single
 * job that runs all migrated languages sequentially in one process. This
 * eliminates 8× redundant checkout + npm ci + build cycles (the old
 * workflow created a separate GitHub Actions job per language).
 *
 * For each language in MIGRATED_LANGUAGES:
 *   1. Run its resolver test with REGISTRY_PRIMARY_<LANG>=0 (legacy DAG)
 *   2. Run its resolver test with REGISTRY_PRIMARY_<LANG>=1 (registry-primary)
 *
 * Both modes must pass. Failures are collected and reported at the end
 * so all regressions are visible in a single CI run (equivalent to the
 * old workflow's fail-fast: false behavior).
 *
 * Vitest output streams to the console in real time (stdio: 'inherit')
 * so CI logs show the actual test output directly. No per-invocation
 * timeout — the CI job-level timeout (30 min) is the outer guard.
 *
 * Usage:
 *   npx tsx scripts/run-parity.ts
 *   npx tsx scripts/run-parity.ts --language python   # single language
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MIGRATED_LANGUAGES } from '../src/core/ingestion/registry-primary-flag.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

interface ParityFailure {
  lang: string;
  mode: 'legacy' | 'registry-primary';
}

function envVarName(slug: string): string {
  return `REGISTRY_PRIMARY_${slug.toUpperCase().replace(/-/g, '_')}`;
}

function testFilePath(slug: string): string {
  return `test/integration/resolvers/${slug}.test.ts`;
}

function runVitest(testFile: string, env: Record<string, string>): boolean {
  try {
    execFileSync('npx', ['vitest', 'run', testFile], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: true,
    });
    return true;
  } catch {
    return false;
  }
}

// Parse CLI args
const args = process.argv.slice(2);
const langFlag = args.indexOf('--language');
const singleLang = langFlag >= 0 ? args[langFlag + 1] : undefined;

if (langFlag >= 0 && singleLang === undefined) {
  console.error('--language requires a value');
  process.exit(1);
}

const languages = singleLang ? [singleLang] : [...MIGRATED_LANGUAGES].map(String);

// Verify test files exist before running
const missingFiles: string[] = [];
for (const lang of languages) {
  const file = path.resolve(ROOT, testFilePath(lang));
  try {
    fs.accessSync(file);
  } catch {
    missingFiles.push(`${testFilePath(lang)} (${lang})`);
  }
}

if (missingFiles.length > 0) {
  console.error('Missing resolver test files:');
  for (const f of missingFiles) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`Scope-resolution parity: ${languages.length} language(s)`);
console.log(`Languages: ${languages.join(', ')}\n`);

const failures: ParityFailure[] = [];

for (const lang of languages) {
  const file = testFilePath(lang);
  const envVar = envVarName(lang);

  console.log(`\n── ${lang} — legacy DAG (${envVar}=0) ──`);
  if (!runVitest(file, { [envVar]: '0' })) {
    failures.push({ lang, mode: 'legacy' });
  }

  console.log(`\n── ${lang} — registry-primary (${envVar}=1) ──`);
  if (!runVitest(file, { [envVar]: '1' })) {
    failures.push({ lang, mode: 'registry-primary' });
  }
}

// Summary
const total = languages.length * 2;
const passed = total - failures.length;

console.log('\n═══════════════════════════════════════');
console.log('PARITY SUMMARY');
console.log('═══════════════════════════════════════');
console.log(`Passed: ${passed}/${total}`);

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) {
    console.log(`  ✗ ${f.lang} [${f.mode}]`);
  }
  process.exit(1);
}

console.log('\nAll parity checks passed.');
