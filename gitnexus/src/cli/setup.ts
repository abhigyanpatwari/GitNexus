/**
 * Setup Command
 *
 * One-time global MCP configuration writer.
 * Detects installed AI editors and writes the appropriate MCP config
 * so the GitNexus MCP server is available in all projects.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile, execFileSync } from 'child_process';
import { createRequire } from 'module';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { parseTree, modify, applyEdits, ParseError, parse as parseJsonc } from 'jsonc-parser';
import { getGlobalDir } from '../storage/repo-manager.js';
import {
  getEditorTargets,
  mcpTarget,
  skillTarget,
  hookTarget,
  detectIndentation,
  type EditorId,
} from './editor-targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

// Pin the npx fallback to the installed version. Reason: setup.ts writes
// a config that persists in the user's editor and is invoked on every MCP
// connect. Pinning to the installed version means subsequent invocations
// skip the npm-registry metadata roundtrip (and stay reproducible until
// the user upgrades). Static configs and READMEs intentionally use
// `gitnexus@latest` since they're quickstart docs, not persisted state.
const _require = createRequire(import.meta.url);
const _pkg = _require('../../package.json') as { version?: unknown };
if (typeof _pkg.version !== 'string' || !_pkg.version) {
  throw new Error(
    'gitnexus/package.json#version is missing or not a string — cannot generate MCP fallback config.',
  );
}
// Version-pinned ref for the persisted MCP entry — deliberately distinct from
// the cjs's exported `gitnexus@latest` hint ref (resolve-analyze-cmd.cjs); the
// two are not unified (see the comment above and that file's MCP_PINNED_REF).
const MCP_PINNED_REF = `gitnexus@${_pkg.version}`;

/**
 * Build the `command` string written into an editor's hook settings, which the
 * editor shell-evaluates. `hookPath` is already forward-slash-normalized.
 *
 * On POSIX, single-quote the path: a single-quoted shell string expands nothing,
 * so spaces and metacharacters ($, backtick, ;, |, &, newline, parens) in the
 * install path cannot run as commands. The only character needing escaping
 * inside single quotes is the single quote, via the standard `'\''` idiom
 * (close, literal-quote, reopen). The previous double-quoted `node "..."` form
 * left $/backtick live — a code-execution risk for an adversarial $HOME.
 *
 * On Windows, filenames cannot contain these POSIX metacharacters and the path
 * is forward-slashed, so keep the double-quoted form with backslash-then-quote
 * escaping (CodeQL js/incomplete-sanitization safe ordering).
 */
export function formatHookCommand(
  hookPath: string,
  isWindows = process.platform === 'win32',
): string {
  if (isWindows) {
    const escaped = hookPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `node "${escaped}"`;
  }
  return `node '${hookPath.replace(/'/g, "'\\''")}'`;
}

// The exact source line each hook adapter ships, rewritten at install time to
// point cliPath at the installed CLI. Kept as a named constant so the install
// patch and its drift guard reference one string — if the adapter source ever
// changes this literal, the guard records an actionable error instead of
// silently shipping a hook with an unresolved relative cliPath.
const CLI_PATH_SOURCE_LITERAL =
  "let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');";

interface SetupResult {
  configured: string[];
  skipped: string[];
  errors: string[];
}

const CODING_AGENT_IDS = {
  cursor: 'cursor',
  claude: 'claude',
  antigravity: 'antigravity',
  opencode: 'opencode',
  codex: 'codex',
} as const satisfies Record<EditorId, EditorId>;
const SUPPORTED_CODING_AGENTS = Object.values(CODING_AGENT_IDS);

function selectedCodingAgents(values: string[] | string | undefined): Set<EditorId> | null {
  if (values == null) return new Set(SUPPORTED_CODING_AGENTS);
  const rawValues = Array.isArray(values) ? values : [values];
  const requested = rawValues
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = requested.filter(
    (value): value is string => !SUPPORTED_CODING_AGENTS.includes(value as EditorId),
  );
  if (requested.length === 0 || invalid.length > 0) {
    const detail =
      requested.length === 0
        ? 'No coding agents were provided.'
        : `Unknown: ${invalid.join(', ')}.`;
    process.stderr.write(`${detail} Valid values: ${SUPPORTED_CODING_AGENTS.join(', ')}.\n`);
    process.exitCode = 1;
    return null;
  }
  return new Set(requested as EditorId[]);
}

/**
 * Resolve the absolute path to the `gitnexus` binary if it's installed
 * globally (or via npm -g / yarn global). Returns null when not found.
 */
function resolveGitnexusBin(): string | null {
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where' : 'which';
    const output = execFileSync(cmd, ['gitnexus'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const lines = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (isWin) {
      // On Windows, npm global installs can surface multiple launchers for the
      // same package (e.g. a POSIX shell shim plus .cmd/.bat wrappers). Claude
      // and the other MCP hosts need a directly spawnable command path, so only
      // accept the Windows wrapper. If it is missing, fall back to the slower
      // npx entry instead of persisting a non-spawnable shim path.
      const cmdLine = lines.find((l) => /\.(cmd|bat)$/i.test(l));
      return cmdLine || null;
    }

    return lines[0] || null;
  } catch {
    return null;
  }
}

/**
 * The MCP server entry for all editors.
 *
 * Prefers the globally-installed `gitnexus` binary (starts in ~1 s) over
 * `npx -y gitnexus@<version>` (cold-cache install of native deps can take
 * >60 s, exceeding Claude Code's 30 s MCP connection timeout). The fallback
 * version is read from gitnexus/package.json#version at module load so the
 * persisted user config matches the installed package.
 *
 * Falls back to npx when the binary isn't on PATH — e.g. first-time
 * users who ran `npx gitnexus analyze` but haven't done `npm i -g`.
 */
function getMcpEntry() {
  const bin = resolveGitnexusBin();

  if (bin) {
    return { command: bin, args: ['mcp'] };
  }

  // Fallback: npx (works without a global install, but slow cold-start)
  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', MCP_PINNED_REF, 'mcp'],
    };
  }
  return {
    command: 'npx',
    args: ['-y', MCP_PINNED_REF, 'mcp'],
  };
}

/**
 * OpenCode uses a different MCP format: { type: "local", command: [...] }
 * where command is a flat array (command + args combined).
 */
function getOpenCodeMcpEntry() {
  const bin = resolveGitnexusBin();

  if (bin) {
    return { type: 'local', command: [bin, 'mcp'] };
  }

  if (process.platform === 'win32') {
    return { type: 'local', command: ['cmd', '/c', 'npx', '-y', MCP_PINNED_REF, 'mcp'] };
  }
  return { type: 'local', command: ['npx', '-y', MCP_PINNED_REF, 'mcp'] };
}

/**
 * Merge a key/value pair into a JSONC config file, preserving comments and formatting.
 * If the file is genuinely corrupt (not valid JSONC), leaves it untouched.
 */
async function mergeJsoncFile(
  filePath: string,
  keyPath: string[],
  value: unknown,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    raw = '';
  }

  if (raw.trim().length === 0) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const formattingOptions = { tabSize: 2, insertSpaces: true };
    const edits = modify('{}', keyPath, value, { formattingOptions });
    const result = applyEdits('{}', edits);
    await fs.writeFile(filePath, result, 'utf-8');
    return true;
  }

  const parseErrors: ParseError[] = [];
  const tree = parseTree(raw, parseErrors);

  if (tree && tree.type === 'object' && parseErrors.length === 0) {
    const formattingOptions = detectIndentation(raw);
    const edits = modify(raw, keyPath, value, { formattingOptions });
    const result = applyEdits(raw, edits);
    await fs.writeFile(filePath, result, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Check if a directory exists
 */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ─── Editor-specific setup ─────────────────────────────────────────

async function setupCursor(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) {
    result.skipped.push('Cursor (not installed)');
    return;
  }

  const { file: mcpPath, keyPath } = mcpTarget('cursor');
  try {
    const ok = await mergeJsoncFile(mcpPath, keyPath, getMcpEntry());
    if (ok) {
      result.configured.push('Cursor');
    } else {
      result.errors.push('Cursor: mcp.json is corrupt — skipping to preserve existing content');
    }
  } catch (err: any) {
    result.errors.push(`Cursor: ${err.message}`);
  }
}

async function setupClaudeCode(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) {
    result.skipped.push('Claude Code (not installed)');
    return;
  }

  // Claude Code stores MCP config in ~/.claude.json
  const { file: mcpPath, keyPath } = mcpTarget('claude');
  try {
    const ok = await mergeJsoncFile(mcpPath, keyPath, getMcpEntry());
    if (ok) {
      result.configured.push('Claude Code');
    } else {
      result.errors.push(
        'Claude Code: .claude.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`Claude Code: ${err.message}`);
  }
}

/**
 * Install GitNexus skills to ~/.claude/skills/ for Claude Code.
 */
async function installClaudeCodeSkills(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const skillsDir = skillTarget('claude').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Claude Code skills (${installed.length} skills → ~/.claude/skills/)`);
    }
  } catch (err: any) {
    result.errors.push(`Claude Code skills: ${err.message}`);
  }
}

/**
 * Check whether an event array already contains a gitnexus-hook entry.
 */
function hasGitnexusHook(
  hooksObj: any,
  eventName: string,
  commandFragment = 'gitnexus-hook',
): boolean {
  const entries = hooksObj?.[eventName];
  if (!Array.isArray(entries)) return false;
  return entries.some(
    (h: any) =>
      Array.isArray(h.hooks) &&
      h.hooks.some(
        (hh: any) => typeof hh.command === 'string' && hh.command.includes(commandFragment),
      ),
  );
}

/**
 * Merge hook entries into a JSONC settings file, preserving comments and formatting.
 * Uses chained modify()+applyEdits() calls to append to arrays without a full
 * JSON.stringify roundtrip that would strip comments.
 */
async function mergeHooksJsonc(
  filePath: string,
  entries: Array<{ eventName: string; value: unknown }>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    raw = '';
  }

  if (raw.trim().length === 0) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const hooks: any = {};
    for (const { eventName, value } of entries) {
      hooks[eventName] = [value];
    }
    const formattingOptions = { tabSize: 2, insertSpaces: true };
    const edits = modify('{}', ['hooks'], hooks, { formattingOptions });
    await fs.writeFile(filePath, applyEdits('{}', edits), 'utf-8');
    return true;
  }

  const parseErrors: ParseError[] = [];
  const tree = parseTree(raw, parseErrors);

  if (!tree || tree.type !== 'object' || parseErrors.length > 0) {
    return false;
  }

  const formattingOptions = detectIndentation(raw);
  let current = raw;

  for (const { eventName, value } of entries) {
    // Re-parse after each edit to get a fresh insertion index.
    const currentTree = parseTree(current, []);
    const hooksNode = currentTree?.children?.find(
      (c) => c.type === 'property' && c.children?.[0]?.value === 'hooks',
    );
    const eventNode = hooksNode?.children?.[1]?.children?.find(
      (c: any) => c.type === 'property' && c.children?.[0]?.value === eventName,
    );

    let insertIndex: number;
    if (eventNode?.children?.[1] && Array.isArray(eventNode.children[1].children)) {
      insertIndex = eventNode.children[1].children.length;
    } else {
      insertIndex = 0;
    }

    const edits = modify(current, ['hooks', eventName, insertIndex], value, {
      formattingOptions,
    });
    current = applyEdits(current, edits);
  }

  await fs.writeFile(filePath, current, 'utf-8');
  return true;
}

const HOOK_HELPERS = [
  'hook-lock.cjs',
  'hook-db-lock-probe.cjs',
  'win-rm-list-json.ps1',
  'resolve-analyze-cmd.cjs',
] as const;

// win-rm-list-json.ps1 is best-effort: it is read (not require()'d) by
// hook-db-lock-probe.cjs only on Windows, and that probe fails open when the
// script is absent. Every other helper is top-level require()'d by the adapters,
// so its absence crashes the installed hook — those are the ones a failed copy
// must gate hook registration on (see copyHookHelpers' return value).
const BEST_EFFORT_HOOK_HELPERS = new Set<string>(['win-rm-list-json.ps1']);

/**
 * Copy the shared hook helpers from `srcDir` into `destDir`. The adapters
 * top-level `require()` the `.cjs` helpers, so a missing required helper makes
 * the installed hook crash with MODULE_NOT_FOUND. A failed copy is recorded as a
 * setup error, and the names of any failed REQUIRED helpers are returned so the
 * caller can fail closed (skip hook registration) instead of registering a hook
 * that crashes at runtime. `win-rm-list-json.ps1` is best-effort — its absence is
 * recorded but does not gate registration. Both the Claude and Antigravity
 * install paths copy this same list from hooks/claude/ (the canonical source).
 */
export async function copyHookHelpers(
  srcDir: string,
  destDir: string,
  label: string,
  result: SetupResult,
): Promise<string[]> {
  const failedRequired: string[] = [];
  for (const helper of HOOK_HELPERS) {
    try {
      await fs.copyFile(path.join(srcDir, helper), path.join(destDir, helper));
    } catch {
      result.errors.push(`${label}: failed to copy ${helper} — hook may crash at runtime`);
      if (!BEST_EFFORT_HOOK_HELPERS.has(helper)) failedRequired.push(helper);
    }
  }
  return failedRequired;
}

/**
 * Install GitNexus hooks to ~/.claude/settings.json for Claude Code.
 * Merges hook config without overwriting existing hooks, preserving
 * comments and formatting in the JSONC file.
 */
async function installClaudeCodeHooks(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const claudeHook = hookTarget('claude');
  const settingsPath = claudeHook.settingsFile;

  // Source hooks bundled within the gitnexus package (hooks/claude/)
  const pluginHooksPath = path.join(__dirname, '..', '..', 'hooks', 'claude');

  // Copy unified hook script to ~/.claude/hooks/gitnexus/
  const destHooksDir = claudeHook.scriptDir;

  try {
    await fs.mkdir(destHooksDir, { recursive: true });

    const src = path.join(pluginHooksPath, 'gitnexus-hook.cjs');
    const dest = path.join(destHooksDir, 'gitnexus-hook.cjs');
    try {
      let content = await fs.readFile(src, 'utf-8');
      const resolvedCli = path.join(__dirname, '..', 'cli', 'index.js');
      const normalizedCli = path.resolve(resolvedCli).replace(/\\/g, '/');
      const jsonCli = JSON.stringify(normalizedCli);
      if (!content.includes(CLI_PATH_SOURCE_LITERAL)) {
        result.errors.push(
          'Claude Code hooks: gitnexus-hook.cjs no longer contains the cliPath literal to patch — the installed hook may fail to resolve the CLI. Update CLI_PATH_SOURCE_LITERAL in setup.ts.',
        );
      }
      content = content.replace(CLI_PATH_SOURCE_LITERAL, `let cliPath = ${jsonCli};`);
      await fs.writeFile(dest, content, 'utf-8');
    } catch {
      // Script not found in source — skip
    }

    // Fail closed: registering the hook without its adapter would crash on every
    // tool invocation. Mirrors the Antigravity adapter guard below (this path
    // previously registered regardless of whether the adapter wrote).
    try {
      await fs.access(dest);
    } catch {
      result.errors.push(
        'Claude Code hooks: adapter script was not installed — skipping hook registration',
      );
      return;
    }

    const failedRequired = await copyHookHelpers(
      pluginHooksPath,
      destHooksDir,
      'Claude Code hooks',
      result,
    );
    if (failedRequired.length > 0) {
      result.errors.push(
        `Claude Code hooks: required helper(s) ${failedRequired.join(', ')} failed to copy — skipping hook registration`,
      );
      return;
    }

    const hookPath = path.join(destHooksDir, 'gitnexus-hook.cjs').replace(/\\/g, '/');
    const hookCmd = formatHookCommand(hookPath);

    // Check which hook events need entries (idempotent: skip if already registered)
    const parsed = await (async () => {
      try {
        const r = await fs.readFile(settingsPath, 'utf-8');
        return parseJsonc(r);
      } catch {
        return null;
      }
    })();

    const hookEntries: Array<{ eventName: string; value: unknown }> = [];

    // NOTE: SessionStart hooks are broken on Windows (Claude Code bug #23576).
    // Session context is delivered via CLAUDE.md / skills instead.

    if (!hasGitnexusHook(parsed?.hooks, 'PreToolUse', claudeHook.needle)) {
      hookEntries.push({
        eventName: 'PreToolUse',
        value: {
          matcher: 'Grep|Glob|Bash',
          hooks: [
            {
              type: 'command',
              command: hookCmd,
              timeout: 10,
              statusMessage: 'Enriching with GitNexus graph context...',
            },
          ],
        },
      });
    }
    if (!hasGitnexusHook(parsed?.hooks, 'PostToolUse', claudeHook.needle)) {
      hookEntries.push({
        eventName: 'PostToolUse',
        value: {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: hookCmd,
              timeout: 10,
              statusMessage: 'Checking GitNexus index freshness...',
            },
          ],
        },
      });
    }

    if (hookEntries.length === 0) {
      result.configured.push('Claude Code hooks (already configured)');
      return;
    }

    const ok = await mergeHooksJsonc(settingsPath, hookEntries);
    if (ok) {
      result.configured.push('Claude Code hooks (PreToolUse, PostToolUse)');
    } else {
      result.errors.push(
        'Claude Code hooks: settings.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`Claude Code hooks: ${err.message}`);
  }
}

// ─── Antigravity (Google) ──────────────────────────────────────────
//
// Antigravity stores its MCP config under ~/.gemini/antigravity/mcp_config.json
// and inherits Gemini CLI's hooks contract
// (https://geminicli.com/docs/hooks/reference/), which lives at
// ~/.gemini/settings.json under the canonical `hooks.<EventName>` array layout.
//
// We register a single AfterTool entry matching Gemini's built-in search/shell
// tools (search_file_content|glob|run_shell_command). BeforeTool is not used:
// the Gemini contract provides no documented context-injection channel for it,
// so augmentation runs in AfterTool where `hookSpecificOutput.additionalContext`
// is appended to the tool result the agent reads. See the antigravity hook
// adapter for the stdin/stdout contract details.

async function setupAntigravity(result: SetupResult): Promise<void> {
  const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
  if (!(await dirExists(antigravityDir))) {
    result.skipped.push('Antigravity (not installed)');
    return;
  }

  const { file: mcpPath, keyPath } = mcpTarget('antigravity');
  try {
    const ok = await mergeJsoncFile(mcpPath, keyPath, getMcpEntry());
    if (ok) {
      result.configured.push('Antigravity');
    } else {
      result.errors.push(
        'Antigravity: mcp_config.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`Antigravity: ${err.message}`);
  }
}

/**
 * Install GitNexus skills to ~/.gemini/antigravity/skills/ (global scope,
 * per https://codelabs.developers.google.com/getting-started-with-antigravity-skills).
 * Each skill is laid out as {skillName}/SKILL.md just like the other editors.
 */
async function installAntigravitySkills(result: SetupResult): Promise<void> {
  const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
  if (!(await dirExists(antigravityDir))) return;

  const skillsDir = skillTarget('antigravity').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(
        `Antigravity skills (${installed.length} skills → ~/.gemini/antigravity/skills/)`,
      );
    }
  } catch (err: any) {
    result.errors.push(`Antigravity skills: ${err.message}`);
  }
}

/**
 * Install the Antigravity/Gemini-CLI hook adapter to
 * ~/.gemini/config/hooks/gitnexus/ and register an AfterTool entry in
 * ~/.gemini/settings.json under `hooks.AfterTool`.
 *
 * Why AfterTool (and not BeforeTool): the Gemini hooks reference
 * (https://geminicli.com/docs/hooks/reference/) does not provide a context-
 * injection channel for BeforeTool. AfterTool's
 * `hookSpecificOutput.additionalContext` is the only documented way to
 * append text the agent will read.
 */
async function installAntigravityHooks(result: SetupResult): Promise<void> {
  const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
  if (!(await dirExists(antigravityDir))) return;

  const antigravityHook = hookTarget('antigravity');
  const settingsPath = antigravityHook.settingsFile;
  const destHooksDir = antigravityHook.scriptDir;

  // The antigravity adapter shares its lock/probe helpers with the claude
  // adapter — same DB, same concurrency rules — so we reuse those CJS files
  // from gitnexus/hooks/claude/ rather than duplicating them.
  const pluginAntigravityDir = path.join(__dirname, '..', '..', 'hooks', 'antigravity');
  const pluginClaudeDir = path.join(__dirname, '..', '..', 'hooks', 'claude');

  try {
    await fs.mkdir(destHooksDir, { recursive: true });

    // Adapter script: rewrite the dist path baked into the file so it resolves
    // to the installed gitnexus CLI rather than the cwd-relative dev path.
    const adapterSrc = path.join(pluginAntigravityDir, 'gitnexus-antigravity-hook.cjs');
    const adapterDest = path.join(destHooksDir, 'gitnexus-antigravity-hook.cjs');
    try {
      let content = await fs.readFile(adapterSrc, 'utf-8');
      const resolvedCli = path.join(__dirname, '..', 'cli', 'index.js');
      const normalizedCli = path.resolve(resolvedCli).replace(/\\/g, '/');
      const jsonCli = JSON.stringify(normalizedCli);
      if (!content.includes(CLI_PATH_SOURCE_LITERAL)) {
        result.errors.push(
          'Antigravity hooks: gitnexus-antigravity-hook.cjs no longer contains the cliPath literal to patch — the installed hook may fail to resolve the CLI. Update CLI_PATH_SOURCE_LITERAL in setup.ts.',
        );
      }
      content = content.replace(CLI_PATH_SOURCE_LITERAL, `let cliPath = ${jsonCli};`);
      await fs.writeFile(adapterDest, content, 'utf-8');
    } catch {
      // Adapter not found in source — skip
    }

    // Bail out if the adapter was not written — registering the hook entry
    // without the script would crash on every tool invocation (top-level
    // require() of sibling helpers fails with MODULE_NOT_FOUND).
    try {
      await fs.access(adapterDest);
    } catch {
      result.errors.push(
        'Antigravity hooks: adapter script was not installed — skipping hook registration',
      );
      return;
    }

    // Shared helpers (copied from hooks/claude/). win-rm-list-json.ps1 is
    // required by hook-db-lock-probe.cjs on Windows — without it, the MCP
    // server ownership probe silently fails open and the hook may contend
    // with the MCP server on the LadybugDB.
    const failedRequired = await copyHookHelpers(
      pluginClaudeDir,
      destHooksDir,
      'Antigravity hooks',
      result,
    );
    if (failedRequired.length > 0) {
      result.errors.push(
        `Antigravity hooks: required helper(s) ${failedRequired.join(', ')} failed to copy — skipping hook registration`,
      );
      return;
    }

    const hookPath = path.join(destHooksDir, 'gitnexus-antigravity-hook.cjs').replace(/\\/g, '/');
    const hookCmd = formatHookCommand(hookPath);

    const parsed = await (async () => {
      try {
        const r = await fs.readFile(settingsPath, 'utf-8');
        return parseJsonc(r);
      } catch {
        return null;
      }
    })();

    const hookEntries: Array<{ eventName: string; value: unknown }> = [];

    if (!hasGitnexusHook(parsed?.hooks, 'AfterTool', antigravityHook.needle)) {
      // Matcher follows the Gemini CLI built-in tool naming (snake_case).
      // search_file_content / glob cover content + filename search; run_shell_command
      // catches rg/grep invocations and the git commit family for stale-index hints.
      hookEntries.push({
        eventName: 'AfterTool',
        value: {
          matcher: 'search_file_content|glob|run_shell_command',
          hooks: [
            {
              type: 'command',
              command: hookCmd,
              name: 'gitnexus',
              // ms — Gemini CLI uses milliseconds (default 60000); Claude Code
              // uses seconds. 10000 ms = 10 s.
              timeout: 10000,
              description: 'GitNexus graph context + stale-index hints',
            },
          ],
        },
      });
    }

    if (hookEntries.length === 0) {
      result.configured.push('Antigravity hooks (already configured)');
      return;
    }

    const ok = await mergeHooksJsonc(settingsPath, hookEntries);
    if (ok) {
      result.configured.push('Antigravity hooks (AfterTool)');
    } else {
      result.errors.push(
        'Antigravity hooks: settings.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`Antigravity hooks: ${err.message}`);
  }
}

async function setupOpenCode(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) {
    result.skipped.push('OpenCode (not installed)');
    return;
  }

  const { file: configPath, keyPath } = mcpTarget('opencode');
  try {
    const ok = await mergeJsoncFile(configPath, keyPath, getOpenCodeMcpEntry());
    if (ok) {
      result.configured.push('OpenCode');
    } else {
      result.errors.push(
        'OpenCode: opencode.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`OpenCode: ${err.message}`);
  }
}

/**
 * Build a TOML section for Codex MCP config (~/.codex/config.toml).
 */
function getCodexMcpTomlSection(): string {
  const entry = getMcpEntry();
  const command = JSON.stringify(entry.command);
  const args = `[${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`;
  return `[${getEditorTargets().codex.tomlSection}]\ncommand = ${command}\nargs = ${args}\n`;
}

/**
 * Append GitNexus MCP server config to Codex's config.toml if missing.
 */
async function upsertCodexConfigToml(configPath: string): Promise<void> {
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch {
    existing = '';
  }

  if (existing.includes(`[${getEditorTargets().codex.tomlSection}]`)) {
    return;
  }

  const section = getCodexMcpTomlSection();
  const nextContent = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${section}` : section;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${nextContent.trimEnd()}\n`, 'utf-8');
}

async function setupCodex(result: SetupResult): Promise<void> {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!(await dirExists(codexDir))) {
    result.skipped.push('Codex (not installed)');
    return;
  }

  try {
    const entry = getMcpEntry();
    await execFileAsync('codex', ['mcp', 'add', 'gitnexus', '--', entry.command, ...entry.args], {
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    result.configured.push('Codex');
    return;
  } catch {
    // Fallback for environments where `codex` binary isn't on PATH.
  }

  try {
    const configPath = getEditorTargets().codex.configFile;
    await upsertCodexConfigToml(configPath);
    result.configured.push('Codex (MCP added to ~/.codex/config.toml)');
  } catch (err: any) {
    result.errors.push(`Codex: ${err.message}`);
  }
}

// ─── Skill Installation ───────────────────────────────────────────

/**
 * Install GitNexus skills to a target directory.
 * Each skill is installed as {targetDir}/gitnexus-{skillName}/SKILL.md
 * following the Agent Skills standard (Cursor, Claude Code, and Codex).
 *
 * Supports two source layouts:
 *   - Flat file:  skills/{name}.md           → copied as SKILL.md
 *   - Directory:  skills/{name}/SKILL.md     → copied recursively (includes references/, etc.)
 */
async function installSkillsTo(targetDir: string): Promise<string[]> {
  const installed: string[] = [];
  // GITNEXUS_TEST_SKILLS_ROOT lets tests stage a fixture skills tree without
  // depending on __dirname resolution under Vitest.
  const skillsRoot =
    process.env.GITNEXUS_TEST_SKILLS_ROOT ?? path.join(__dirname, '..', '..', 'skills');

  // Was glob('*.md') + glob('*/SKILL.md'); replaced with fs.readdir because
  // glob v13's cwd handling did not match the fixture path on Windows runners
  // (absolute temp paths containing the 8.3 short-name `RUNNER~1` returned
  // zero matches). fs.readdir has no such path quirks.
  let flatFiles: string[] = [];
  let dirSkillFiles: string[] = [];
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    flatFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
    const subdirSkillFiles = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          try {
            await fs.access(path.join(skillsRoot, e.name, 'SKILL.md'));
            return path.join(e.name, 'SKILL.md');
          } catch {
            return null;
          }
        }),
    );
    dirSkillFiles = subdirSkillFiles.filter((p): p is string => p !== null);
  } catch {
    return [];
  }

  const skillSources = new Map<string, { isDirectory: boolean }>();

  for (const relPath of dirSkillFiles) {
    skillSources.set(path.dirname(relPath), { isDirectory: true });
  }
  for (const relPath of flatFiles) {
    const skillName = path.basename(relPath, '.md');
    if (!skillSources.has(skillName)) {
      skillSources.set(skillName, { isDirectory: false });
    }
  }

  for (const [skillName, source] of skillSources) {
    const skillDir = path.join(targetDir, skillName);

    try {
      if (source.isDirectory) {
        const dirSource = path.join(skillsRoot, skillName);
        await copyDirRecursive(dirSource, skillDir);
        installed.push(skillName);
      } else {
        const flatSource = path.join(skillsRoot, `${skillName}.md`);
        const content = await fs.readFile(flatSource, 'utf-8');
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
        installed.push(skillName);
      }
    } catch {
      // Source skill not found — skip
    }
  }

  return installed;
}

/**
 * Recursively copy a directory tree.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Install global Cursor skills to ~/.cursor/skills/gitnexus/
 */
async function installCursorSkills(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) return;

  const skillsDir = skillTarget('cursor').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Cursor skills (${installed.length} skills → ~/.cursor/skills/)`);
    }
  } catch (err: any) {
    result.errors.push(`Cursor skills: ${err.message}`);
  }
}

/**
 * Install global OpenCode skills to ~/.config/opencode/skills/gitnexus/
 */
async function installOpenCodeSkills(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) return;

  const skillsDir = skillTarget('opencode').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(
        `OpenCode skills (${installed.length} skills → ~/.config/opencode/skills/)`,
      );
    }
  } catch (err: any) {
    result.errors.push(`OpenCode skills: ${err.message}`);
  }
}

/**
 * Install global Codex skills to ~/.agents/skills/gitnexus/
 */
async function installCodexSkills(result: SetupResult): Promise<void> {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!(await dirExists(codexDir))) return;

  const skillsDir = skillTarget('codex').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Codex skills (${installed.length} skills → ~/.agents/skills/)`);
    }
  } catch (err: any) {
    result.errors.push(`Codex skills: ${err.message}`);
  }
}

// ─── Main command ──────────────────────────────────────────────────

export const setupCommand = async (options?: { codingAgent?: string[] | string }) => {
  const explicitSelection = options?.codingAgent != null;
  const selected = selectedCodingAgents(options?.codingAgent);
  if (!selected) return;

  console.log('');
  console.log('  GitNexus Setup');
  console.log('  ==============');
  console.log('');

  // Ensure global directory exists
  const globalDir = getGlobalDir();
  await fs.mkdir(globalDir, { recursive: true });

  const result: SetupResult = {
    configured: [],
    skipped: [],
    errors: [],
  };

  // Detect and configure each editor's MCP
  if (selected.has('cursor')) await setupCursor(result);
  if (selected.has('claude')) await setupClaudeCode(result);
  if (selected.has('antigravity')) await setupAntigravity(result);
  if (selected.has('opencode')) await setupOpenCode(result);
  if (selected.has('codex')) await setupCodex(result);

  // Install global skills for platforms that support them
  if (selected.has('claude')) {
    await installClaudeCodeSkills(result);
    await installClaudeCodeHooks(result);
  }
  if (selected.has('antigravity')) {
    await installAntigravitySkills(result);
    await installAntigravityHooks(result);
  }
  if (selected.has('cursor')) await installCursorSkills(result);
  if (selected.has('opencode')) await installOpenCodeSkills(result);
  if (selected.has('codex')) await installCodexSkills(result);

  // Print results
  if (result.configured.length > 0) {
    console.log('  Configured:');
    for (const name of result.configured) {
      console.log(`    + ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('');
    console.log('  Skipped:');
    for (const name of result.skipped) {
      console.log(`    - ${name}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const err of result.errors) {
      console.log(`    ! ${err}`);
    }
  }

  console.log('');
  console.log('  Summary:');
  console.log(
    `    MCP configured for: ${result.configured.filter((c) => !c.includes('skills')).join(', ') || 'none'}`,
  );
  console.log(
    `    Skills installed to: ${result.configured.filter((c) => c.includes('skills')).length > 0 ? result.configured.filter((c) => c.includes('skills')).join(', ') : 'none'}`,
  );
  const configurationSucceeded = result.configured.length > 0;
  if (explicitSelection && !configurationSucceeded) {
    process.stderr.write('None of the explicitly selected coding agents were configured.\n');
    process.exitCode = 1;
  }
  console.log('');
  if (configurationSucceeded) {
    console.log('  Next steps:');
    console.log('    1. cd into any git repo');
    console.log('    2. Run: gitnexus analyze');
    console.log('    3. Open the repo in your editor — MCP is ready!');
  }
  console.log('');
};
