/**
 * ci-setup Command
 *
 * Detects the current environment and generates all artifacts needed to run
 * GitNexus as a shared, CI/CD-maintained MCP server for a team:
 *   - GitHub Actions / Azure DevOps workflow
 *   - Docker Compose service (with optional Caddy auth proxy)
 *   - Azure Container App deploy script
 *   - MCP config snippet for the shared server
 *   - GITNEXUS.md onboarding doc
 */

import fs from 'fs/promises';
import path from 'path';
import { detectEnvironment } from './ci-setup/detect.js';
import { resolveOptions } from './ci-setup/prompts.js';
import { generateFiles } from './ci-setup/templates.js';
import type { CiSetupOptions, CiSetupResult, GeneratedFile } from './ci-setup/types.js';
import type { CiSystem, DeployTarget, AuthMode, BranchStrategy } from './ci-setup/types.js';

export const ciSetupCommand = async (options?: {
  ci?: string;
  deploy?: string;
  port?: string;
  auth?: string;
  branchStrategy?: string;
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
  outputDir?: string;
}) => {
  const cwd = process.cwd();

  console.log('\n🔍 Detecting environment...');
  const detect = await detectEnvironment(cwd);

  if (!detect.gitRoot) {
    console.error(
      '✗ Not a git repository. Run `gitnexus ci-setup` from inside a git repo root.',
    );
    process.exit(1);
  }

  console.log(`   ✓ Git repo: ${path.basename(detect.gitRoot)}`);
  console.log(`   ✓ Primary language: ${detect.primaryLanguage}`);
  if (detect.detectedCi) {
    console.log(`   ✓ CI/CD detected: ${detect.detectedCi}`);
  } else {
    console.log('   - CI/CD: none detected');
  }
  if (detect.hasDocker) {
    console.log('   ✓ Docker: docker-compose or Dockerfile found');
  }
  console.log(`   ${detect.portAvailable ? '✓' : '⚠'} Port 4747: ${detect.portAvailable ? 'available' : 'in use (serve may already be running)'}`);
  console.log('   ⚠ License: PolyForm-Noncommercial — confirm non-commercial use\n');

  // Parse and validate options from commander flags
  const partial: Partial<CiSetupOptions> = {};
  if (options?.ci) partial.ci = options.ci as CiSystem;
  if (options?.deploy) partial.deploy = options.deploy as DeployTarget;
  if (options?.port) partial.port = parseInt(options.port, 10);
  if (options?.auth) partial.auth = options.auth as AuthMode;
  if (options?.branchStrategy) partial.branchStrategy = options.branchStrategy as BranchStrategy;
  if (options?.dryRun !== undefined) partial.dryRun = options.dryRun;
  if (options?.apply !== undefined) partial.apply = options.apply;
  if (options?.yes !== undefined) partial.yes = options.yes;
  if (options?.outputDir) partial.outputDir = options.outputDir;

  // Default: dry-run when neither --dry-run nor --apply is given
  if (!partial.dryRun && !partial.apply) {
    partial.dryRun = true;
  }

  const resolved = await resolveOptions(detect, partial);
  const files = generateFiles(resolved, detect);

  const result: CiSetupResult = { generated: [], skipped: [], errors: [] };

  if (resolved.dryRun) {
    await previewFiles(files, resolved.outputDir);
    console.log('\n──────────────────────────────────────────────');
    console.log(`${files.length} file(s) would be written. Run with --apply to write them.`);
    return;
  }

  await applyFiles(files, resolved, result);
  printResult(result, resolved);
};

async function previewFiles(files: GeneratedFile[], outputDir: string): Promise<void> {
  for (const file of files) {
    const fullPath = path.join(outputDir, file.relativePath);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`→ ${fullPath}`);
    console.log('─'.repeat(60));
    console.log(file.content);
  }
}

async function applyFiles(
  files: GeneratedFile[],
  opts: CiSetupOptions,
  result: CiSetupResult,
): Promise<void> {
  for (const file of files) {
    const fullPath = path.join(opts.outputDir, file.relativePath);

    try {
      let existingContent: string | null = null;
      try {
        existingContent = await fs.readFile(fullPath, 'utf-8');
      } catch {
        // file does not exist — will be created
      }

      if (existingContent !== null && existingContent === file.content) {
        result.skipped.push(`${file.relativePath} (exists, identical)`);
        continue;
      }

      if (existingContent !== null && !opts.yes) {
        console.log(`\n⚠ ${file.relativePath} already exists and differs.`);
        if (!opts.yes) {
          const { confirm } = await import('@inquirer/prompts');
          const ok = await confirm({ message: `Overwrite ${file.relativePath}?`, default: false });
          if (!ok) {
            result.skipped.push(`${file.relativePath} (skipped by user)`);
            continue;
          }
        }
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, file.content, 'utf-8');
      result.generated.push(file.relativePath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${file.relativePath}: ${message}`);
    }
  }
}

function printResult(result: CiSetupResult, opts: CiSetupOptions): void {
  console.log('\n══════════════════════════════════════');
  console.log('  GitNexus CI Setup');
  console.log('══════════════════════════════════════\n');

  for (const f of result.generated) {
    console.log(`  + ${f}`);
  }
  for (const f of result.skipped) {
    console.log(`  - ${f}`);
  }
  for (const f of result.errors) {
    console.log(`  ! ${f}`);
  }

  if (result.errors.length > 0) {
    console.log('\nSome files could not be written. See errors above.');
    return;
  }

  console.log('\nNext steps:');
  let step = 1;

  if (opts.auth === 'token' && (opts.deploy === 'docker' || opts.deploy === 'both')) {
    console.log(`  ${step++}. Set GITNEXUS_TOKEN in your shell or .env file.`);
    console.log(`  ${step++}. docker compose -f docker-compose.gitnexus.yml up -d`);
  } else if (opts.deploy === 'docker' || opts.deploy === 'both') {
    console.log(`  ${step++}. docker compose -f docker-compose.gitnexus.yml up -d`);
  }

  if (opts.deploy === 'azure-container-app' || opts.deploy === 'both') {
    console.log(`  ${step++}. Review and run: bash gitnexus-aca-deploy.sh`);
  }

  if (opts.ci === 'github-actions' || opts.ci === 'both') {
    console.log(`  ${step++}. Commit .github/workflows/gitnexus-ci.yml and push to trigger the first index.`);
  }
  if (opts.ci === 'azure-devops' || opts.ci === 'both') {
    console.log(`  ${step++}. Import azure-pipelines-gitnexus.yml into Azure DevOps and run it.`);
  }

  console.log(`  ${step++}. Follow GITNEXUS.md to connect Claude Code / Cursor to the shared server.`);
  console.log('');
}
