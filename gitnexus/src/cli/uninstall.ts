/**
 * Uninstall Command
 *
 * Reverses `gitnexus setup`: removes the GitNexus MCP server entries,
 * skills, and hooks that setup writes into each detected AI editor's
 * global configuration. The set of targets (paths, key paths, hook events,
 * needles, script dirs) is shared with setup.ts via editor-targets.ts, so the
 * two stay in lock-step.
 *
 * Surgical and idempotent: only gitnexus-owned keys/entries/dirs are
 * removed. Unrelated user config (other MCP servers, other hooks, JSONC
 * comments, indentation) is preserved. Files that are absent or that
 * never contained a gitnexus entry are left untouched.
 *
 * Ownership is by name: skill directories are matched by the bundled gitnexus
 * skill names, MCP entries by the `gitnexus` key, hooks by the gitnexus command
 * needle. There is no per-install provenance marker yet (a user dir that
 * happens to share a bundled skill name, or files a user added inside an
 * installed skill dir, are matched purely by name) — which is why uninstall is
 * a dry-run preview by default and prints the exact paths it will remove.
 * Richer provenance tracking is a tracked follow-up.
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
import { getEditorTargets, detectIndentation, isEnoent } from './editor-targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

interface UninstallResult {
  removed: string[];
  skipped: string[];
  errors: string[];
  /**
   * A corrupt LEGACY chain file was seen. It is reported informationally
   * (skipped, no exit code), but it makes "not configured" unknowable, so the
   * final report must not claim it. Kept as a first-class flag — the report
   * must never re-derive this by sniffing skipped-entry message text.
   */
  corruptLegacy: boolean;
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
  } catch (err) {
    // ENOENT = genuinely not configured. Any other read failure (EACCES,
    // locks) must not report 'missing' — the file may hold a real gitnexus
    // entry the dry-run would then deny exists. Rethrow into the caller's
    // per-file catch.
    if (!isEnoent(err)) throw err;
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
  } catch (err) {
    // Masking a non-ENOENT read failure as 'missing' would also let the
    // caller delete the hook scriptDir while the unreadable settings file
    // still references it. Rethrow into the hook uninstaller's catch.
    if (!isEnoent(err)) throw err;
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
 * Remove the gitnexus skill directories from a target skills folder. Returns
 * the absolute paths that were removed (or would be removed in dryRun) so the
 * caller can show the user exactly what is affected.
 */
async function removeSkillsFrom(
  targetDir: string,
  skillNames: string[],
  dryRun: boolean,
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of skillNames) {
    // Defense in depth: an empty/relative/absolute name would resolve back to
    // targetDir (or escape it) and wipe unrelated content. Only act on a
    // plain child directory name.
    if (
      !name ||
      name.includes('/') ||
      name.includes('\\') ||
      name === '.' ||
      name === '..' ||
      path.isAbsolute(name)
    ) {
      continue;
    }
    const dir = path.join(targetDir, name);
    if (await removeDir(dir, dryRun)) removed.push(dir);
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
  // Capture group 1 is the bracket token only, so a trailing inline comment
  // (`[mcp_servers.gitnexus] # note`) is stripped before classification —
  // otherwise an exact `=== header` check fails and the section is left behind.
  const headerRe = /^(\[\[?[^[\]]+\]\]?)\s*(#.*)?$/;

  const isSectionHeader = (token: string): boolean =>
    token === header || token.startsWith(childTable) || token.startsWith(childArray);

  // Return the multiline-string delimiter still OPEN at the end of `line`,
  // given the state at its start (null = outside any multiline string). Scans
  // left→right so the delimiter that actually opens first wins — a line with an
  // odd count of BOTH `"""` and `'''` (e.g. `x = '''has """ inside`) no longer
  // mis-picks the wrong delimiter and desyncs the scanner.
  const multilineStateAfter = (line: string, startState: string | null): string | null => {
    let state = startState;
    let i = 0;
    while (i < line.length) {
      if (state) {
        const close = line.indexOf(state, i);
        if (close === -1) return state; // still open at end of line
        i = close + state.length;
        state = null;
      } else {
        const a = line.indexOf('"""', i);
        const b = line.indexOf("'''", i);
        if (a === -1 && b === -1) return null;
        const useA = b === -1 || (a !== -1 && a < b);
        state = useA ? '"""' : "'''";
        i = (useA ? a : b) + 3;
      }
    }
    return state;
  };

  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  let mlDelim: string | null = null;

  for (const line of lines) {
    if (mlDelim) {
      // Inside a multiline string: brackets here are data, not headers.
      mlDelim = multilineStateAfter(line, mlDelim);
      if (!skipping) out.push(line);
      continue;
    }

    const trimmed = line.trim();
    const headerMatch = trimmed.match(headerRe);
    if (headerMatch) {
      if (isSectionHeader(headerMatch[1])) {
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
    mlDelim = multilineStateAfter(line, null);

    if (!skipping) out.push(line);
  }

  // Preserve the file's line endings: a CRLF (Windows) config.toml should not
  // be silently rewritten to LF. Rejoin with the dominant EOL of the input.
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let result = out.join(eol);
  if (!result.endsWith(eol)) result += eol;
  return result;
}

async function uninstallCodex(
  result: UninstallResult,
  dryRun: boolean,
  configPath: string,
  tomlSection: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch (err) {
    // Catch locally: this call site has no surrounding try, so a rethrow
    // would abort the hooks/skills cleanup that runs after Codex.
    if (isEnoent(err)) {
      result.skipped.push('Codex MCP (not configured)');
    } else {
      result.errors.push(`Codex: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (!raw.includes(`[${tomlSection}]`)) {
    result.skipped.push('Codex MCP (not configured)');
    return;
  }

  if (dryRun) {
    result.removed.push(`Codex MCP server — [${tomlSection}] in ${configPath}`);
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
    result.removed.push("Codex MCP server — via 'codex mcp remove gitnexus'");
    return;
  } catch {
    // Fall through to manual edit.
  }

  try {
    await fs.writeFile(configPath, stripTomlSection(raw, tomlSection), 'utf-8');
    result.removed.push(`Codex MCP server — [${tomlSection}] in ${configPath}`);
  } catch (err: any) {
    result.errors.push(`Codex: ${err.message}`);
  }
}

// ─── Main command ──────────────────────────────────────────────────

export const uninstallCommand = async (options?: { force?: boolean }) => {
  const dryRun = !options?.force;
  const targets = getEditorTargets();

  console.log('');
  console.log('  GitNexus Uninstall');
  console.log('  ==================');
  console.log('');
  if (dryRun) {
    console.log('  Dry run — nothing will be changed. Re-run with --force to apply.');
    console.log('');
  }

  const result: UninstallResult = { removed: [], skipped: [], errors: [], corruptLegacy: false };

  // ─── MCP server entries (JSONC editors) ──────────────────────────
  // Sweep legacyFiles too: setup writes into the first existing file of the
  // editor's priority chain, so the gitnexus entry may live in a deprecated
  // location (e.g. CodeBuddy's ~/.codebuddy/mcp.json).
  for (const target of targets.mcpJsonc) {
    let removedAny = false;
    let erroredAny = false;
    let corruptLegacyAny = false;
    for (const file of [target.file, ...(target.legacyFiles ?? [])]) {
      try {
        const status = await removeJsoncKey(file, target.keyPath, dryRun);
        if (status === 'removed') {
          removedAny = true;
          result.removed.push(
            `${target.label} MCP server — ${target.keyPath.join('.')} in ${file}`,
          );
        } else if (status === 'corrupt') {
          if (file === target.file) {
            // The primary path is where gitnexus itself writes — corruption
            // there is an error worth failing the command over.
            erroredAny = true;
            result.errors.push(
              `${target.label}: ${path.basename(file)} is corrupt — left untouched`,
            );
          } else {
            // Legacy chain files are vendor locations gitnexus may never have
            // touched (e.g. a corrupt ~/.codebuddy.json from an old install).
            // Report informationally without failing uninstall. Deliberate
            // asymmetry: an UNREADABLE (non-ENOENT) legacy file still errors —
            // that's an environmental problem worth surfacing, while corrupt-
            // but-readable proves there is no removable gitnexus entry.
            corruptLegacyAny = true;
            result.corruptLegacy = true;
            result.skipped.push(
              `${target.label} MCP (legacy ${path.basename(file)} is corrupt — left untouched)`,
            );
          }
        }
      } catch (err) {
        erroredAny = true;
        result.errors.push(`${target.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A corrupt legacy file makes "not configured" unknowable — suppress it.
    if (!removedAny && !erroredAny && !corruptLegacyAny) {
      result.skipped.push(`${target.label} MCP (not configured)`);
    }
  }

  await uninstallCodex(result, dryRun, targets.codex.configFile, targets.codex.tomlSection);

  // ─── Hooks ───────────────────────────────────────────────────────
  for (const hook of targets.hooks) {
    try {
      const { status, count } = await removeHookEntries(
        hook.settingsFile,
        hook.events,
        hook.needle,
        dryRun,
      );
      if (status === 'removed')
        result.removed.push(`${hook.label} hooks (${count}) — ${hook.settingsFile}`);
      else if (status === 'corrupt')
        result.errors.push(
          `${hook.label} hooks: ${path.basename(hook.settingsFile)} is corrupt — left untouched`,
        );
      // Don't delete the hook script while a registered entry may still point
      // at it (corrupt = we couldn't parse/remove the entry) — that would
      // leave the editor invoking a missing script on every matched tool call.
      if (status !== 'corrupt' && (await removeDir(hook.scriptDir, dryRun)))
        result.removed.push(`${hook.label} hook scripts — ${hook.scriptDir}`);
    } catch (err: any) {
      result.errors.push(`${hook.label} hooks: ${err.message}`);
    }
  }

  // ─── Skills ──────────────────────────────────────────────────────
  // Skill directories are identified by the bundled gitnexus skill names; the
  // exact paths are listed below so the user can see what will be removed.
  const skillNames = await listGitnexusSkillNames();
  for (const target of targets.skills) {
    try {
      const removedDirs = await removeSkillsFrom(target.dir, skillNames, dryRun);
      for (const dir of removedDirs) result.removed.push(`${target.label} skill — ${dir}`);
    } catch (err: any) {
      result.errors.push(`${target.label} skills: ${err.message}`);
    }
  }

  // ─── Report ──────────────────────────────────────────────────────
  const verb = dryRun ? 'Would remove' : 'Removed';
  if (result.removed.length > 0) {
    console.log(`  ${verb}:`);
    for (const name of result.removed) console.log(`    - ${name}`);
  } else if (result.errors.length > 0 || result.corruptLegacy) {
    // Errors (corrupt primary files, unreadable configs) or corrupt legacy
    // configs make "not configured" unknowable — claiming it right above an
    // Errors block would be a contradiction users learn to distrust.
    console.log('  Nothing removed.');
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
  console.log('  Note: skill directories are matched by bundled gitnexus skill name. If you');
  console.log('  customized files inside an installed skill dir, back them up before --force.');

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
