/**
 * Uninstall Command
 *
 * Reverses `gitnexus setup`: removes the GitNexus MCP server entries,
 * skills, and hooks that setup writes into each detected AI editor's
 * global configuration. Mirrors setup.ts target-by-target.
 *
 * Surgical and idempotent: only gitnexus-owned keys/entries/dirs are
 * removed. Unrelated user config (other MCP servers, other hooks, JSONC
 * comments, indentation) is preserved. Files that are absent or that
 * never contained a gitnexus entry are left untouched.
 *
 * Intentionally NOT done here (printed as hints instead, since both are
 * destructive in ways setup never caused):
 *   - per-repo indexes      → `gitnexus clean --all`
 *   - the global npm package → `npm uninstall -g gitnexus`
 *
 * Default is a dry-run preview; pass --force to apply.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import {
  parseTree,
  modify,
  applyEdits,
  findNodeAtLocation,
  parse as parseJsonc,
  type ParseError,
  type JSONPath,
} from 'jsonc-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

interface UninstallResult {
  removed: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Detect indentation style from file content (mirrors setup.ts) so that
 * jsonc edits preserve the file's existing formatting.
 */
function detectIndentation(raw: string): { tabSize: number; insertSpaces: boolean } {
  const firstIndented = raw.match(/^( +|\t)/m);
  if (!firstIndented) return { tabSize: 2, insertSpaces: true };
  if (firstIndented[1] === '\t') return { tabSize: 1, insertSpaces: false };
  return { tabSize: firstIndented[1].length, insertSpaces: true };
}

type RemovalStatus = 'removed' | 'absent' | 'corrupt' | 'missing';

/**
 * Remove a single key (by JSON path) from a JSONC file, preserving the
 * surrounding comments and formatting. Returns:
 *   - 'missing': file does not exist
 *   - 'absent':  file exists but the key isn't there (nothing to do)
 *   - 'corrupt': file isn't valid JSONC — left untouched on purpose
 *   - 'removed': the key was present (and removed unless dryRun)
 */
async function removeJsoncKey(
  filePath: string,
  keyPath: JSONPath,
  dryRun: boolean,
): Promise<RemovalStatus> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return 'missing';
  }

  if (raw.trim().length === 0) return 'absent';

  const parseErrors: ParseError[] = [];
  const tree = parseTree(raw, parseErrors);
  if (!tree || tree.type !== 'object' || parseErrors.length > 0) return 'corrupt';

  if (!findNodeAtLocation(tree, keyPath)) return 'absent';

  if (!dryRun) {
    const formattingOptions = detectIndentation(raw);
    const edits = modify(raw, keyPath, undefined, { formattingOptions });
    await fs.writeFile(filePath, applyEdits(raw, edits), 'utf-8');
  }
  return 'removed';
}

/**
 * Remove every hook entry whose command string contains `commandNeedle`
 * from the given `eventNames` arrays in a JSONC settings file. Mirrors
 * the idempotency probes in setup.ts (hasGitnexusHook /
 * geminiHasGitnexusHook). Returns how many entries matched.
 *
 * Entries are removed highest-index-first within each event so the
 * remaining indices stay valid across edits.
 */
async function removeHookEntries(
  filePath: string,
  eventNames: string[],
  commandNeedle: string,
  dryRun: boolean,
): Promise<{ status: RemovalStatus; count: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { status: 'missing', count: 0 };
  }

  if (raw.trim().length === 0) return { status: 'absent', count: 0 };

  const parseErrors: ParseError[] = [];
  const tree = parseTree(raw, parseErrors);
  if (!tree || tree.type !== 'object' || parseErrors.length > 0) {
    return { status: 'corrupt', count: 0 };
  }

  const parsed = parseJsonc(raw);
  const formattingOptions = detectIndentation(raw);
  let current = raw;
  let total = 0;

  const matches = (entry: any): boolean =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some(
      (hh: any) => typeof hh?.command === 'string' && hh.command.includes(commandNeedle),
    );

  for (const eventName of eventNames) {
    const entries = parsed?.hooks?.[eventName];
    if (!Array.isArray(entries)) continue;

    const indices: number[] = [];
    entries.forEach((entry: any, i: number) => {
      if (matches(entry)) indices.push(i);
    });
    if (indices.length === 0) continue;
    total += indices.length;

    if (dryRun) continue;
    // Highest first: removing a later array element never shifts the
    // index of an earlier one.
    for (const idx of indices.reverse()) {
      const edits = modify(current, ['hooks', eventName, idx], undefined, { formattingOptions });
      current = applyEdits(current, edits);
    }
  }

  if (total === 0) return { status: 'absent', count: 0 };
  if (!dryRun) await fs.writeFile(filePath, current, 'utf-8');
  return { status: 'removed', count: total };
}

/**
 * Remove a directory tree if it exists. Returns true when something was
 * (or would be) removed.
 */
async function removeDir(dirPath: string, dryRun: boolean): Promise<boolean> {
  try {
    await fs.access(dirPath);
  } catch {
    return false;
  }
  if (!dryRun) await fs.rm(dirPath, { recursive: true, force: true });
  return true;
}

/**
 * The exact set of skill directory names setup installs, derived from the
 * bundled `skills/` source the same way installSkillsTo does (flat
 * `{name}.md` and `{name}/SKILL.md` layouts). Deriving the set — rather
 * than globbing `gitnexus-*` — ensures we never delete a user's own
 * similarly-named skill folder.
 */
async function listGitnexusSkillNames(): Promise<string[]> {
  const skillsRoot =
    process.env.GITNEXUS_TEST_SKILLS_ROOT ?? path.join(__dirname, '..', '..', 'skills');

  const names = new Set<string>();
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        names.add(path.basename(entry.name, '.md'));
      } else if (entry.isDirectory()) {
        try {
          await fs.access(path.join(skillsRoot, entry.name, 'SKILL.md'));
          names.add(entry.name);
        } catch {
          // Not a skill directory — skip.
        }
      }
    }
  } catch {
    return [];
  }
  return [...names];
}

/**
 * Remove the gitnexus skill directories from a target skills folder.
 * Returns the count removed (or that would be removed in dryRun).
 */
async function removeSkillsFrom(
  targetDir: string,
  skillNames: string[],
  dryRun: boolean,
): Promise<number> {
  let removed = 0;
  for (const name of skillNames) {
    if (await removeDir(path.join(targetDir, name), dryRun)) removed++;
  }
  return removed;
}

/**
 * Remove the `[mcp_servers.gitnexus]` table from Codex's config.toml,
 * deleting the header line and everything up to the next top-level table
 * header (or EOF). Returns the removal status.
 */
function stripTomlSection(raw: string, sectionName: string): string {
  const header = `[${sectionName}]`;
  const out: string[] = [];
  let skipping = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!skipping && trimmed === header) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // A new table header ends the gitnexus section.
      if (/^\[\[?.+\]\]?$/.test(trimmed)) {
        skipping = false;
      } else {
        continue;
      }
    }
    out.push(line);
  }

  // Collapse the blank-line gap setup left before the appended section.
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .trimEnd() + '\n'
  );
}

async function uninstallCodex(result: UninstallResult, dryRun: boolean): Promise<void> {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    result.skipped.push('Codex MCP (not configured)');
    return;
  }

  if (!raw.includes('[mcp_servers.gitnexus]')) {
    result.skipped.push('Codex MCP (not configured)');
    return;
  }

  if (dryRun) {
    result.removed.push('Codex MCP server');
    return;
  }

  // Prefer the official CLI (mirrors setup's `codex mcp add`); fall back
  // to editing config.toml directly when the binary isn't on PATH.
  try {
    await execFileAsync('codex', ['mcp', 'remove', 'gitnexus'], {
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    result.removed.push('Codex MCP server');
    return;
  } catch {
    // Fall through to manual edit.
  }

  try {
    await fs.writeFile(configPath, stripTomlSection(raw, 'mcp_servers.gitnexus'), 'utf-8');
    result.removed.push('Codex MCP server (~/.codex/config.toml)');
  } catch (err: any) {
    result.errors.push(`Codex: ${err.message}`);
  }
}

// ─── Main command ──────────────────────────────────────────────────

export const uninstallCommand = async (options?: { force?: boolean }) => {
  const dryRun = !options?.force;
  const home = os.homedir();

  console.log('');
  console.log('  GitNexus Uninstall');
  console.log('  ==================');
  console.log('');
  if (dryRun) {
    console.log('  Dry run — nothing will be changed. Re-run with --force to apply.');
    console.log('');
  }

  const result: UninstallResult = { removed: [], skipped: [], errors: [] };

  // ─── MCP server entries (JSONC editors) ──────────────────────────
  const mcpTargets: Array<{ label: string; file: string; keyPath: JSONPath }> = [
    {
      label: 'Cursor',
      file: path.join(home, '.cursor', 'mcp.json'),
      keyPath: ['mcpServers', 'gitnexus'],
    },
    {
      label: 'Claude Code',
      file: path.join(home, '.claude.json'),
      keyPath: ['mcpServers', 'gitnexus'],
    },
    {
      label: 'Antigravity',
      file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      keyPath: ['mcpServers', 'gitnexus'],
    },
    {
      label: 'OpenCode',
      file: path.join(home, '.config', 'opencode', 'opencode.json'),
      keyPath: ['mcp', 'gitnexus'],
    },
  ];

  for (const target of mcpTargets) {
    try {
      const status = await removeJsoncKey(target.file, target.keyPath, dryRun);
      if (status === 'removed') result.removed.push(`${target.label} MCP server`);
      else if (status === 'corrupt')
        result.errors.push(
          `${target.label}: ${path.basename(target.file)} is corrupt — left untouched`,
        );
      else result.skipped.push(`${target.label} MCP (not configured)`);
    } catch (err: any) {
      result.errors.push(`${target.label}: ${err.message}`);
    }
  }

  await uninstallCodex(result, dryRun);

  // ─── Hooks ───────────────────────────────────────────────────────
  // Claude Code: PreToolUse/PostToolUse entries + bundled hook scripts.
  try {
    const { status, count } = await removeHookEntries(
      path.join(home, '.claude', 'settings.json'),
      ['PreToolUse', 'PostToolUse'],
      'gitnexus-hook',
      dryRun,
    );
    if (status === 'removed') result.removed.push(`Claude Code hooks (${count})`);
    else if (status === 'corrupt')
      result.errors.push('Claude Code hooks: settings.json is corrupt — left untouched');
    if (await removeDir(path.join(home, '.claude', 'hooks', 'gitnexus'), dryRun))
      result.removed.push('Claude Code hook scripts (~/.claude/hooks/gitnexus/)');
  } catch (err: any) {
    result.errors.push(`Claude Code hooks: ${err.message}`);
  }

  // Antigravity / Gemini CLI: AfterTool entry + bundled adapter scripts.
  try {
    const { status, count } = await removeHookEntries(
      path.join(home, '.gemini', 'settings.json'),
      ['AfterTool'],
      'gitnexus-antigravity-hook',
      dryRun,
    );
    if (status === 'removed') result.removed.push(`Antigravity hooks (${count})`);
    else if (status === 'corrupt')
      result.errors.push('Antigravity hooks: settings.json is corrupt — left untouched');
    if (await removeDir(path.join(home, '.gemini', 'config', 'hooks', 'gitnexus'), dryRun))
      result.removed.push('Antigravity hook scripts (~/.gemini/config/hooks/gitnexus/)');
  } catch (err: any) {
    result.errors.push(`Antigravity hooks: ${err.message}`);
  }

  // ─── Skills ──────────────────────────────────────────────────────
  const skillNames = await listGitnexusSkillNames();
  const skillTargets: Array<{ label: string; dir: string }> = [
    { label: 'Claude Code', dir: path.join(home, '.claude', 'skills') },
    { label: 'Antigravity', dir: path.join(home, '.gemini', 'antigravity', 'skills') },
    { label: 'Cursor', dir: path.join(home, '.cursor', 'skills') },
    { label: 'OpenCode', dir: path.join(home, '.config', 'opencode', 'skills') },
    { label: 'Codex', dir: path.join(home, '.agents', 'skills') },
  ];
  for (const target of skillTargets) {
    try {
      const count = await removeSkillsFrom(target.dir, skillNames, dryRun);
      if (count > 0) result.removed.push(`${target.label} skills (${count})`);
    } catch (err: any) {
      result.errors.push(`${target.label} skills: ${err.message}`);
    }
  }

  // ─── Report ──────────────────────────────────────────────────────
  const verb = dryRun ? 'Would remove' : 'Removed';
  if (result.removed.length > 0) {
    console.log(`  ${verb}:`);
    for (const name of result.removed) console.log(`    - ${name}`);
  } else {
    console.log('  Nothing to remove — GitNexus is not configured in any detected editor.');
  }

  if (result.skipped.length > 0) {
    console.log('');
    console.log('  Skipped:');
    for (const name of result.skipped) console.log(`    - ${name}`);
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const err of result.errors) console.log(`    ! ${err}`);
  }

  console.log('');
  console.log('  Not removed automatically:');
  console.log('    - Per-repo indexes — run: gitnexus clean --all');
  console.log('    - The global npm package — run: npm uninstall -g gitnexus');

  if (dryRun && result.removed.length > 0) {
    console.log('');
    console.log('  Re-run with --force to apply the changes above.');
  }
  console.log('');
};
