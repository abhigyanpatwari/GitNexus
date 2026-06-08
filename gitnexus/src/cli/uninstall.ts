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
 * Remove the gitnexus hook command(s) — those whose command string contains
 * `commandNeedle` — from the given `eventNames` arrays in a JSONC settings
 * file. Mirrors the idempotency probes in setup.ts (hasGitnexusHook /
 * geminiHasGitnexusHook). Returns how many event entries contained a gitnexus
 * command.
 *
 * Removal is element-granular to honor the "other hooks are preserved"
 * contract: only the matching command object inside an entry's `hooks[]` is
 * deleted. The surrounding matcher entry is removed only when it becomes
 * empty (i.e. it held nothing but gitnexus commands — which is exactly what
 * setup creates). A user who hand-added their own command alongside ours
 * keeps it. Edits are applied highest-index-first so earlier indices stay
 * valid across edits.
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

  const isGitnexusHook = (hh: any): boolean =>
    typeof hh?.command === 'string' && hh.command.includes(commandNeedle);

  for (const eventName of eventNames) {
    const entries = parsed?.hooks?.[eventName];
    if (!Array.isArray(entries)) continue;

    // Walk entries high → low so removing a later one never shifts the
    // index of an earlier one.
    for (let entryIdx = entries.length - 1; entryIdx >= 0; entryIdx--) {
      const entry = entries[entryIdx];
      if (!Array.isArray(entry?.hooks)) continue;

      const hookIdxs: number[] = [];
      entry.hooks.forEach((hh: any, hi: number) => {
        if (isGitnexusHook(hh)) hookIdxs.push(hi);
      });
      if (hookIdxs.length === 0) continue;

      total += 1;
      if (dryRun) continue;

      if (hookIdxs.length === entry.hooks.length) {
        // The entry held only gitnexus command(s) — drop the whole entry.
        const edits = modify(current, ['hooks', eventName, entryIdx], undefined, {
          formattingOptions,
        });
        current = applyEdits(current, edits);
      } else {
        // The entry also holds user command(s) — delete only ours, keep
        // the rest. Highest hook index first to keep lower indices valid.
        for (const hi of hookIdxs.reverse()) {
          const edits = modify(current, ['hooks', eventName, entryIdx, 'hooks', hi], undefined, {
            formattingOptions,
          });
          current = applyEdits(current, edits);
        }
      }
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
        // Guard against a bare `.md` file: basename('.md', '.md') === '',
        // which would later resolve to the skills dir itself and wipe it.
        const base = path.basename(entry.name, '.md');
        if (base) names.add(base);
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
    // Defense in depth: an empty/relative name would resolve back to
    // targetDir (or escape it) and wipe unrelated content. Only act on a
    // plain child directory name.
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      continue;
    }
    if (await removeDir(path.join(targetDir, name), dryRun)) removed++;
  }
  return removed;
}

/**
 * Remove the `[mcp_servers.gitnexus]` table — and any of its descendant
 * sub-tables (`[mcp_servers.gitnexus.env]`, `[[mcp_servers.gitnexus.x]]`) —
 * from Codex's config.toml. Used only as a fallback when the `codex` binary
 * isn't on PATH; the CLI's `codex mcp remove` is preferred.
 *
 * Hand-rolled (no TOML dependency), but careful about the cases a naive
 * line-scan gets wrong:
 *   - descendant sub-tables of the section are also removed (else they'd be
 *     left dangling, referencing a server that no longer exists);
 *   - `[...]`-shaped lines inside a multiline string (`"""`/`'''`) are NOT
 *     treated as table headers;
 *   - unrelated whitespace/formatting elsewhere in the file is left intact
 *     (no global blank-line reflow). Only a single blank separator line
 *     directly above the removed section is dropped.
 */
function stripTomlSection(raw: string, sectionName: string): string {
  const header = `[${sectionName}]`;
  const childTable = `[${sectionName}.`;
  const childArray = `[[${sectionName}.`;
  const headerRe = /^\[\[?[^[\]]+\]\]?\s*(#.*)?$/;

  const isSectionHeader = (t: string): boolean =>
    t === header || t.startsWith(childTable) || t.startsWith(childArray);

  // Count non-overlapping occurrences of a delimiter on a line.
  const countDelim = (s: string, d: string): number => {
    let n = 0;
    for (let i = s.indexOf(d); i !== -1; i = s.indexOf(d, i + d.length)) n++;
    return n;
  };
  // A line opens (or closes) a multiline string when it contains an odd
  // number of one of the multiline delimiters.
  const openingDelim = (s: string): string | null => {
    if (countDelim(s, '"""') % 2 === 1) return '"""';
    if (countDelim(s, "'''") % 2 === 1) return "'''";
    return null;
  };

  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  let mlDelim: string | null = null;

  for (const line of lines) {
    if (mlDelim) {
      // Inside a multiline string: brackets here are data, not headers.
      if (countDelim(line, mlDelim) % 2 === 1) mlDelim = null;
      if (!skipping) out.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (headerRe.test(trimmed)) {
      if (isSectionHeader(trimmed)) {
        // Drop a single blank separator line immediately above the section.
        if (!skipping && out.length > 0 && out[out.length - 1].trim() === '') out.pop();
        skipping = true;
        continue;
      }
      // A non-descendant header ends the section.
      skipping = false;
      out.push(line);
      continue;
    }

    // Track whether this (non-header) line opens a multiline string so a
    // bracketed line inside it isn't mistaken for a header.
    mlDelim = openingDelim(line);

    if (!skipping) out.push(line);
  }

  let result = out.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  return result;
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
      timeout: 10000,
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
    // Don't delete the hook script while a registered entry may still point
    // at it (corrupt = we couldn't parse/remove the entry) — that would
    // leave the editor invoking a missing script on every matched tool call.
    if (
      status !== 'corrupt' &&
      (await removeDir(path.join(home, '.claude', 'hooks', 'gitnexus'), dryRun))
    )
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
    // See the Claude block above: don't orphan a still-registered hook.
    if (
      status !== 'corrupt' &&
      (await removeDir(path.join(home, '.gemini', 'config', 'hooks', 'gitnexus'), dryRun))
    )
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
    // Signal partial failure to callers/CI without aborting the remaining
    // cleanup (which has already run by this point).
    process.exitCode = 1;
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
