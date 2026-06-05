/**
 * Shared scaffolding for AI-context files (AGENTS.md / CLAUDE.md).
 *
 * The volatile count header (e.g. "3473 symbols, 9406 relationships")
 * must only be written as part of initial scaffolding — `gitnexus setup`
 * and the one-shot `gitnexus analyze --skills` convenience flag.
 *
 * `gitnexus analyze` (no flag) must NEVER call this module. It runs on
 * every PostToolUse hook and would otherwise churn `git status` and the
 * tracked files on every commit (#108).
 *
 * The two callers — setup.ts and analyze.ts — share this single function
 * so the behavior stays consistent: both write the same files, using the
 * same source of truth (.gitnexus/meta.json).
 */

import fs from 'fs/promises';
import path from 'path';
import { type GeneratedSkillInfo } from './skill-gen.js';

export interface ScaffoldSummary {
  /** Repo paths whose AI context files were (re)written. */
  configured: string[];
  /** Repo paths that were skipped, with a reason. */
  skipped: string[];
  /** Per-repo errors encountered. */
  errors: string[];
}

/**
 * Walk immediate subdirectories (and the root itself) looking for a
 * `.gitnexus/meta.json`. Bounded depth keeps setup O(few-hundred-ms) for
 * common monorepo shapes.
 */
export async function listIndexedReposUnder(root: string): Promise<string[]> {
  const found = new Set<string>();

  const tryAdd = async (candidate: string) => {
    const meta = path.join(candidate, '.gitnexus', 'meta.json');
    try {
      await fs.access(meta);
      found.add(candidate);
    } catch {
      /* not indexed */
    }
  };

  await tryAdd(root);

  let entries: import('fs').Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return Array.from(found);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // skip .git, .next, etc.
    if (entry.name === 'node_modules') continue;
    await tryAdd(path.join(root, entry.name));
  }
  return Array.from(found);
}

/**
 * Scaffold AGENTS.md / CLAUDE.md (and bundled GitNexus skills) for every
 * indexed repo under `root`. Returns a per-repo summary the caller can
 * surface however it likes.
 *
 * The volatile count header is read from each repo's `.gitnexus/meta.json`,
 * which is the single source of truth (gitignored, never mutated by
 * analyze's hot path).
 *
 * If `generatedSkillsByRepo` is supplied, the matching repo's AGENTS.md /
 * CLAUDE.md will reference those generated skill files (e.g.
 * `.claude/skills/generated/<name>/SKILL.md`). This is the path taken
 * by `gitnexus analyze --skills`, which generates skills in the same
 * call and then bootstraps the context files that point at them.
 */
export async function scaffoldAIContextForIndexedRepos(
  root: string,
  generatedSkillsByRepo?: Map<string, GeneratedSkillInfo[]>,
): Promise<ScaffoldSummary> {
  const candidates = await listIndexedReposUnder(root);
  const summary: ScaffoldSummary = {
    configured: [],
    skipped: [],
    errors: [],
  };

  for (const repoPath of candidates) {
    try {
      const metaPath = path.join(repoPath, '.gitnexus', 'meta.json');
      const raw = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as {
        stats?: { nodes?: number; edges?: number; processes?: number; files?: number; communities?: number; clusters?: number };
      };
      const projectName = path.basename(repoPath);
      const generatedSkills = generatedSkillsByRepo?.get(repoPath);
      const { generateAIContextFiles } = await import('./ai-context.js');
      await generateAIContextFiles(repoPath, path.join(repoPath, '.gitnexus'), projectName, {
        files: meta.stats?.files,
        nodes: meta.stats?.nodes,
        edges: meta.stats?.edges,
        communities: meta.stats?.communities,
        clusters: meta.stats?.clusters,
        processes: meta.stats?.processes,
      }, generatedSkills);
      summary.configured.push(projectName);
    } catch (err: any) {
      summary.errors.push(`${path.basename(repoPath)}: ${err.message}`);
    }
  }

  if (candidates.length === 0) {
    summary.skipped.push('no indexed repos under cwd');
  }

  return summary;
}
