#!/usr/bin/env tsx
/**
 * Skill File Synchronization — CLI Runner
 *
 * Reads canonical skills from `gitnexus/skills/`, reads per-target manifests,
 * and writes derived `SKILL.md` files into each integration directory.
 *
 * Usage: npx tsx scripts/sync-skills.ts [--dry-run]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSync, type SyncTarget } from '../src/sync-skills.js';

interface Manifest {
  skills: string[];
}

interface TargetConfig {
  name: string;
  dir: string;
  manifestPath: string;
  stripFrontmatter: boolean;
  generatedHeader: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'gitnexus', 'skills');

const TARGET_CONFIGS: TargetConfig[] = [
  {
    name: '.claude',
    dir: path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus'),
    manifestPath: path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus', 'skills.manifest.json'),
    stripFrontmatter: true,
    generatedHeader: true,
  },
  {
    name: 'gitnexus-claude-plugin',
    dir: path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills'),
    manifestPath: path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills', 'skills.manifest.json'),
    stripFrontmatter: true,
    generatedHeader: true,
  },
  {
    name: 'gitnexus-cursor-integration',
    dir: path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills'),
    manifestPath: path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills', 'skills.manifest.json'),
    stripFrontmatter: true,
    generatedHeader: true,
  },
];

async function loadManifest(manifestPath: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (err: any) {
    throw new Error(`Failed to read manifest at "${manifestPath}": ${err.message}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Manifest at "${manifestPath}" is not valid JSON`);
  }

  if (!Array.isArray(parsed.skills)) {
    throw new Error(`Manifest at "${manifestPath}" is missing a "skills" array`);
  }

  return parsed as Manifest;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const targets: SyncTarget[] = [];
  for (const config of TARGET_CONFIGS) {
    const manifest = await loadManifest(config.manifestPath);
    targets.push({
      name: config.name,
      dir: config.dir,
      skills: manifest.skills,
      stripFrontmatter: config.stripFrontmatter,
      generatedHeader: config.generatedHeader,
    });
  }

  const readFile = (p: string) => fs.readFile(p, 'utf-8');
  const listDir = (dir: string) => fs.readdir(dir);

  const operations = await planSync(SOURCE_DIR, targets, readFile, listDir);

  const writes = operations.filter(op => op.action === 'write');
  const skips = operations.filter(op => op.action === 'skip');

  if (dryRun) {
    console.log(`[dry-run] ${writes.length} file(s) would be written, ${skips.length} already up-to-date.`);
    for (const op of writes) {
      console.log(`  WRITE ${path.relative(REPO_ROOT, op.targetPath)}`);
    }
    for (const op of skips) {
      console.log(`  SKIP  ${path.relative(REPO_ROOT, op.targetPath)}`);
    }
  } else {
    for (const op of writes) {
      await fs.mkdir(path.dirname(op.targetPath), { recursive: true });
      await fs.writeFile(op.targetPath, op.content, 'utf-8');
      console.log(`WRITE ${path.relative(REPO_ROOT, op.targetPath)}`);
    }
    if (skips.length > 0) {
      console.log(`${skips.length} file(s) already up-to-date.`);
    }
    if (writes.length === 0) {
      console.log('All skill files are in sync.');
    } else {
      console.log(`\nSynced ${writes.length} file(s).`);
    }
  }
}

main().catch(err => {
  console.error('sync-skills failed:', err.message);
  process.exit(1);
});
