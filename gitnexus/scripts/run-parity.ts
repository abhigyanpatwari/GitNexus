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

function testFilePaths(slug: string): string[] {
  const resolverDir = path.resolve(ROOT, 'test/integration/resolvers');
  const files = fs.readdirSync(resolverDir);
  const direct = `${slug}.test.ts`;
  const prefixed = `${slug}-`;
  return files
    .filter((name) => name === direct || (name.startsWith(prefixed) && name.endsWith('.test.ts')))
    .sort()
    .map((name) => `test/integration/resolvers/${name}`);
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
const filesByLanguage = new Map<string, string[]>();
for (const lang of languages) {
  const files = testFilePaths(lang);
  filesByLanguage.set(lang, files);
  if (files.length === 0) {
    missingFiles.push(`test/integration/resolvers/${lang}*.test.ts (${lang})`);
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
  const files = filesByLanguage.get(lang) ?? [];
  const envVar = envVarName(lang);

  console.log(`\n── ${lang} — legacy DAG (${envVar}=0) ──`);
  for (const file of files) {
    if (!runVitest(file, { [envVar]: '0' })) {
      failures.push({ lang, mode: 'legacy' });
    }
  }

  console.log(`\n── ${lang} — registry-primary (${envVar}=1) ──`);
  for (const file of files) {
    if (!runVitest(file, { [envVar]: '1' })) {
      failures.push({ lang, mode: 'registry-primary' });
    }
  }
}

// Summary
const total = [...filesByLanguage.values()].reduce((sum, files) => sum + files.length * 2, 0);
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
