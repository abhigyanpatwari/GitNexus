/**
 * Uninstall Command
 *
 * Fully reverses `gitnexus setup` and `gitnexus analyze`.
 * Removes per-repo artifacts (index, context files, skills) and/or
 * global editor integrations (MCP configs, hooks, skills, ~/.gitnexus).
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { findRepo, unregisterRepo } from '../storage/repo-manager.js';

const GITNEXUS_START_MARKER = '<!-- gitnexus:start -->';
const GITNEXUS_END_MARKER = '<!-- gitnexus:end -->';

const SKILL_NAMES = [
  'gitnexus-exploring',
  'gitnexus-debugging',
  'gitnexus-impact-analysis',
  'gitnexus-refactoring',
  'gitnexus-guide',
  'gitnexus-cli',
];

interface UninstallResult {
  removed: string[];
  skipped: string[];
  errors: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, data: any): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Remove the <!-- gitnexus:start --> ... <!-- gitnexus:end --> section from a file.
 * If the file becomes empty after removal, delete it entirely.
 */
async function removeGitNexusSection(filePath: string): Promise<'removed' | 'deleted' | 'not_found'> {
  if (!(await fileExists(filePath))) return 'not_found';

  const content = await fs.readFile(filePath, 'utf-8');
  const startIdx = content.indexOf(GITNEXUS_START_MARKER);
  const endIdx = content.indexOf(GITNEXUS_END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return 'not_found';

  const before = content.substring(0, startIdx);
  const after = content.substring(endIdx + GITNEXUS_END_MARKER.length);
  const remaining = (before + after).trim();

  if (remaining.length === 0) {
    await fs.rm(filePath);
    return 'deleted';
  }

  await fs.writeFile(filePath, remaining + '\n', 'utf-8');
  return 'removed';
}

// ─── Per-Repo Removal ─────────────────────────────────────────────

async function removeRepoArtifacts(repoPath: string, result: UninstallResult): Promise<void> {
  // 1. Remove .gitnexus/ directory (index, kuzu db, meta.json)
  const gitnexusDir = path.join(repoPath, '.gitnexus');
  if (await dirExists(gitnexusDir)) {
    await fs.rm(gitnexusDir, { recursive: true, force: true });
    result.removed.push('.gitnexus/ (index)');
  }

  // 2-3. Remove GitNexus section from AGENTS.md and CLAUDE.md
  for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
    const sectionResult = await removeGitNexusSection(path.join(repoPath, fileName));
    if (sectionResult === 'deleted') {
      result.removed.push(`${fileName} (deleted — was GitNexus-only)`);
    } else if (sectionResult === 'removed') {
      result.removed.push(`${fileName} (GitNexus section removed)`);
    }
  }

  // 4. Remove .claude/skills/gitnexus/ directory (per-repo skills)
  const repoSkillsDir = path.join(repoPath, '.claude', 'skills', 'gitnexus');
  if (await dirExists(repoSkillsDir)) {
    await fs.rm(repoSkillsDir, { recursive: true, force: true });
    result.removed.push('.claude/skills/gitnexus/ (per-repo skills)');
  }

  // 5. Unregister from global registry
  try {
    await unregisterRepo(repoPath);
    result.removed.push('Registry entry');
  } catch {
    // Registry may not exist or entry already gone
  }
}

// ─── Global Removal ───────────────────────────────────────────────

async function removeGlobalArtifacts(result: UninstallResult): Promise<void> {
  const home = os.homedir();

  await removeCursorMcp(home, result);
  await removeOpenCodeMcp(home, result);
  await removeClaudeCodeMcp(result);
  await removeClaudeCodeHooks(home, result);
  await removeDir(path.join(home, '.claude', 'hooks', 'gitnexus'), '~/.claude/hooks/gitnexus/', result);
  await removeSkillDirs(path.join(home, '.claude', 'skills'), '~/.claude/skills/', result);
  await removeSkillDirs(path.join(home, '.cursor', 'skills'), '~/.cursor/skills/', result);
  await removeSkillDirs(path.join(home, '.config', 'opencode', 'skill'), '~/.config/opencode/skill/', result);
  await removeDir(path.join(home, '.gitnexus'), '~/.gitnexus/', result);
}

async function removeCursorMcp(home: string, result: UninstallResult): Promise<void> {
  const mcpPath = path.join(home, '.cursor', 'mcp.json');
  const config = await readJsonFile(mcpPath);
  if (!config?.mcpServers?.gitnexus) return;

  delete config.mcpServers.gitnexus;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  await writeJsonFile(mcpPath, config);
  result.removed.push('Cursor MCP config (mcpServers.gitnexus)');
}

async function removeOpenCodeMcp(home: string, result: UninstallResult): Promise<void> {
  const configPath = path.join(home, '.config', 'opencode', 'config.json');
  const config = await readJsonFile(configPath);
  if (!config?.mcp?.gitnexus) return;

  delete config.mcp.gitnexus;
  if (Object.keys(config.mcp).length === 0) delete config.mcp;
  await writeJsonFile(configPath, config);
  result.removed.push('OpenCode MCP config (mcp.gitnexus)');
}

async function removeClaudeCodeMcp(result: UninstallResult): Promise<void> {
  const cmd = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(cmd, ['mcp', 'remove', 'gitnexus'], { timeout: 10000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    result.removed.push('Claude Code MCP (claude mcp remove gitnexus)');
  } catch {
    // claude CLI not available or MCP not registered — skip silently
  }
}

async function removeHookEntries(
  filePath: string,
  matchesGitNexus: (entry: any) => boolean,
  label: string,
  result: UninstallResult,
): Promise<void> {
  const config = await readJsonFile(filePath);
  if (!config?.hooks?.PreToolUse || !Array.isArray(config.hooks.PreToolUse)) return;

  const before = config.hooks.PreToolUse.length;
  config.hooks.PreToolUse = config.hooks.PreToolUse.filter((entry: any) => !matchesGitNexus(entry));
  if (config.hooks.PreToolUse.length < before) {
    if (config.hooks.PreToolUse.length === 0) delete config.hooks.PreToolUse;
    if (Object.keys(config.hooks).length === 0) delete config.hooks;
    await writeJsonFile(filePath, config);
    result.removed.push(label);
  }
}

async function removeClaudeCodeHooks(home: string, result: UninstallResult): Promise<void> {
  const hasGitNexusHook = (entry: any): boolean =>
    Array.isArray(entry.hooks) && entry.hooks.some((h: any) => h.command?.includes('gitnexus'));

  const hasGitNexusAugmentHook = (entry: any): boolean =>
    Array.isArray(entry.hooks) && entry.hooks.some((h: any) =>
      h.command?.includes('gitnexus-hook') || h.command?.includes('gitnexus augment'),
    );

  await removeHookEntries(
    path.join(home, '.claude', 'settings.json'),
    hasGitNexusHook, 'Claude Code hooks (settings.json)', result,
  );
  await removeHookEntries(
    path.join(home, '.claude', 'hooks.json'),
    hasGitNexusAugmentHook, 'Claude Code hooks (hooks.json)', result,
  );
}

async function removeSkillDirs(parentDir: string, displayPrefix: string, result: UninstallResult): Promise<void> {
  if (!(await dirExists(parentDir))) return;

  let removedCount = 0;
  for (const skillName of SKILL_NAMES) {
    const skillDir = path.join(parentDir, skillName);
    if (await dirExists(skillDir)) {
      await fs.rm(skillDir, { recursive: true, force: true });
      removedCount++;
    }
  }

  if (removedCount > 0) {
    result.removed.push(`${displayPrefix} (${removedCount} skill${removedCount > 1 ? 's' : ''})`);
  }
}

async function removeDir(dirPath: string, displayName: string, result: UninstallResult): Promise<void> {
  if (await dirExists(dirPath)) {
    await fs.rm(dirPath, { recursive: true, force: true });
    result.removed.push(displayName);
  }
}

// ─── Dry-Run Preview ──────────────────────────────────────────────

async function printPreview(options: { global?: boolean; all?: boolean }): Promise<void> {
  const home = os.homedir();
  let hasAnything = false;

  console.log('');
  console.log('  GitNexus Uninstall Preview');
  console.log('  =========================');

  // Per-repo preview
  if (!options.global) {
    const cwd = process.cwd();
    const repo = await findRepo(cwd);

    if (repo) {
      const repoName = repo.repoPath.split(/[/\\]/).pop() || repo.repoPath;
      console.log('');
      console.log(`  Repository: ${repoName}`);

      if (await dirExists(path.join(repo.repoPath, '.gitnexus'))) {
        console.log('    - .gitnexus/ (index)');
        hasAnything = true;
      }

      for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
        const filePath = path.join(repo.repoPath, fileName);
        if (await fileExists(filePath)) {
          const content = await fs.readFile(filePath, 'utf-8');
          if (content.includes(GITNEXUS_START_MARKER)) {
            console.log(`    - ${fileName} (GitNexus section)`);
            hasAnything = true;
          }
        }
      }

      if (await dirExists(path.join(repo.repoPath, '.claude', 'skills', 'gitnexus'))) {
        console.log('    - .claude/skills/gitnexus/ (per-repo skills)');
        hasAnything = true;
      }

      console.log('    - Registry entry');
      hasAnything = true;
    } else {
      console.log('');
      console.log('  No indexed repository found in this directory.');
    }
  }

  // Global preview
  if (options.global || options.all) {
    console.log('');
    console.log('  Global:');

    const cursorConfig = await readJsonFile(path.join(home, '.cursor', 'mcp.json'));
    if (cursorConfig?.mcpServers?.gitnexus) {
      console.log('    - ~/.cursor/mcp.json (mcpServers.gitnexus)');
      hasAnything = true;
    }

    const opencodeConfig = await readJsonFile(path.join(home, '.config', 'opencode', 'config.json'));
    if (opencodeConfig?.mcp?.gitnexus) {
      console.log('    - ~/.config/opencode/config.json (mcp.gitnexus)');
      hasAnything = true;
    }

    console.log('    - Claude Code MCP (claude mcp remove gitnexus)');
    hasAnything = true;

    const settings = await readJsonFile(path.join(home, '.claude', 'settings.json'));
    if (settings?.hooks?.PreToolUse?.some((e: any) =>
      e.hooks?.some((h: any) => h.command?.includes('gitnexus'))
    )) {
      console.log('    - ~/.claude/settings.json (PreToolUse hooks)');
      hasAnything = true;
    }

    const hooksConfig = await readJsonFile(path.join(home, '.claude', 'hooks.json'));
    if (hooksConfig?.hooks?.PreToolUse?.some((e: any) =>
      e.hooks?.some((h: any) =>
        h.command?.includes('gitnexus-hook') || h.command?.includes('gitnexus augment')
      )
    )) {
      console.log('    - ~/.claude/hooks.json (PreToolUse hooks)');
      hasAnything = true;
    }

    if (await dirExists(path.join(home, '.claude', 'hooks', 'gitnexus'))) {
      console.log('    - ~/.claude/hooks/gitnexus/ (hook scripts)');
      hasAnything = true;
    }

    for (const [dir, label] of [
      [path.join(home, '.claude', 'skills'), '~/.claude/skills/'],
      [path.join(home, '.cursor', 'skills'), '~/.cursor/skills/'],
      [path.join(home, '.config', 'opencode', 'skill'), '~/.config/opencode/skill/'],
    ] as const) {
      if (await dirExists(dir)) {
        let skillCount = 0;
        for (const s of SKILL_NAMES) {
          if (await dirExists(path.join(dir, s))) skillCount++;
        }
        if (skillCount > 0) {
          console.log(`    - ${label} (${skillCount} skill${skillCount > 1 ? 's' : ''})`);
          hasAnything = true;
        }
      }
    }

    if (await dirExists(path.join(home, '.gitnexus'))) {
      console.log('    - ~/.gitnexus/ (global config & registry)');
      hasAnything = true;
    }
  }

  console.log('');
  if (hasAnything) {
    console.log('  Run without --dry-run to remove.');
  } else {
    console.log('  Nothing to remove.');
  }
  console.log('');
}

// ─── Main Command ─────────────────────────────────────────────────

export const uninstallCommand = async (options?: {
  dryRun?: boolean;
  global?: boolean;
  all?: boolean;
}) => {
  if (options?.dryRun) {
    await printPreview({ global: options?.global, all: options?.all });
    return;
  }

  const result: UninstallResult = { removed: [], skipped: [], errors: [] };

  // Per-repo removal (default, or with --all)
  if (!options?.global) {
    const cwd = process.cwd();
    const repo = await findRepo(cwd);

    if (repo) {
      try {
        await removeRepoArtifacts(repo.repoPath, result);
      } catch (err: any) {
        result.errors.push(`Repo cleanup: ${err.message}`);
      }
    } else {
      result.skipped.push('No indexed repository in current directory');
    }
  }

  // Global removal (with --global or --all)
  if (options?.global || options?.all) {
    try {
      await removeGlobalArtifacts(result);
    } catch (err: any) {
      result.errors.push(`Global cleanup: ${err.message}`);
    }
  }

  // Print results
  console.log('');
  console.log('  GitNexus Uninstall');
  console.log('  ==================');

  if (result.removed.length > 0) {
    console.log('');
    console.log('  Removed:');
    for (const name of result.removed) {
      console.log(`    - ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('');
    console.log('  Skipped:');
    for (const name of result.skipped) {
      console.log(`    ~ ${name}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const name of result.errors) {
      console.log(`    ! ${name}`);
    }
  }

  if (result.removed.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
    console.log('');
    console.log('  Nothing to remove.');
  }

  if (!options?.global && !options?.all) {
    console.log('');
    console.log('  Tip: use --all to also remove global editor configs, hooks, and skills.');
  }

  console.log('');
};
