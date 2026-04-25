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
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { parseTree, modify, applyEdits, ParseError, parse as parseJsonc } from 'jsonc-parser';
import { getGlobalDir } from '../storage/repo-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

interface SetupResult {
  configured: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Resolve the absolute path to the `gitnexus` binary if it's installed
 * globally (or via npm -g / yarn global). Returns null when not found.
 */
function resolveGitnexusBin(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const resolved = execFileSync(cmd, ['gitnexus'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')[0]
      .trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/**
 * The MCP server entry for all editors.
 *
 * Prefers the globally-installed `gitnexus` binary (starts in ~1 s) over
 * `npx -y gitnexus@latest` (cold-cache install of native deps can take
 * >60 s, exceeding Claude Code's 30 s MCP connection timeout).
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
      args: ['/c', 'npx', '-y', 'gitnexus@latest', 'mcp'],
    };
  }
  return {
    command: 'npx',
    args: ['-y', 'gitnexus@latest', 'mcp'],
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
    return { type: 'local', command: ['cmd', '/c', 'npx', '-y', 'gitnexus@latest', 'mcp'] };
  }
  return { type: 'local', command: ['npx', '-y', 'gitnexus@latest', 'mcp'] };
}

/**
 * Detect indentation style from file content.
 * Returns formatting options matching the file's existing style.
 */
function detectIndentation(raw: string): { tabSize: number; insertSpaces: boolean } {
  const firstIndented = raw.match(/^( +|\t)/m);
  if (!firstIndented) return { tabSize: 2, insertSpaces: true };
  if (firstIndented[1] === '\t') return { tabSize: 1, insertSpaces: false };
  return { tabSize: firstIndented[1].length, insertSpaces: true };
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

  const mcpPath = path.join(cursorDir, 'mcp.json');
  try {
    const ok = await mergeJsoncFile(mcpPath, ['mcpServers', 'gitnexus'], getMcpEntry());
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
  const mcpPath = path.join(os.homedir(), '.claude.json');
  try {
    const ok = await mergeJsoncFile(mcpPath, ['mcpServers', 'gitnexus'], getMcpEntry());
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

  const skillsDir = path.join(claudeDir, 'skills');
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
function hasGitnexusHook(hooksObj: any, eventName: string): boolean {
  const entries = hooksObj?.[eventName];
  if (!Array.isArray(entries)) return false;
  return entries.some(
    (h: any) =>
      Array.isArray(h.hooks) &&
      h.hooks.some(
        (hh: any) => typeof hh.command === 'string' && hh.command.includes('gitnexus-hook'),
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

/**
 * Install GitNexus hooks to ~/.claude/settings.json for Claude Code.
 * Merges hook config without overwriting existing hooks, preserving
 * comments and formatting in the JSONC file.
 */
async function installClaudeCodeHooks(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const settingsPath = path.join(claudeDir, 'settings.json');

  // Source hooks bundled within the gitnexus package (hooks/claude/)
  const pluginHooksPath = path.join(__dirname, '..', '..', 'hooks', 'claude');

  // Copy unified hook script to ~/.claude/hooks/gitnexus/
  const destHooksDir = path.join(claudeDir, 'hooks', 'gitnexus');

  try {
    await fs.mkdir(destHooksDir, { recursive: true });

    const src = path.join(pluginHooksPath, 'gitnexus-hook.cjs');
    const dest = path.join(destHooksDir, 'gitnexus-hook.cjs');
    try {
      let content = await fs.readFile(src, 'utf-8');
      const resolvedCli = path.join(__dirname, '..', 'cli', 'index.js');
      const normalizedCli = path.resolve(resolvedCli).replace(/\\/g, '/');
      const jsonCli = JSON.stringify(normalizedCli);
      content = content.replace(
        "let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');",
        `let cliPath = ${jsonCli};`,
      );
      await fs.writeFile(dest, content, 'utf-8');
    } catch {
      // Script not found in source — skip
    }

    const hookPath = path.join(destHooksDir, 'gitnexus-hook.cjs').replace(/\\/g, '/');
    const hookCmd = `node "${hookPath.replace(/"/g, '\\"')}"`;

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

    if (!hasGitnexusHook(parsed?.hooks, 'PreToolUse')) {
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
    if (!hasGitnexusHook(parsed?.hooks, 'PostToolUse')) {
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

async function setupOpenCode(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) {
    result.skipped.push('OpenCode (not installed)');
    return;
  }

  const configPath = path.join(opencodeDir, 'opencode.json');
  try {
    const ok = await mergeJsoncFile(configPath, ['mcp', 'gitnexus'], getOpenCodeMcpEntry());
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
  return `[mcp_servers.gitnexus]\ncommand = ${command}\nargs = ${args}\n`;
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

  if (existing.includes('[mcp_servers.gitnexus]')) {
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
    });
    result.configured.push('Codex');
    return;
  } catch {
    // Fallback for environments where `codex` binary isn't on PATH.
  }

  try {
    const configPath = path.join(codexDir, 'config.toml');
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
  const skillsRoot = path.join(__dirname, '..', '..', 'skills');

  let flatFiles: string[] = [];
  let dirSkillFiles: string[] = [];
  try {
    [flatFiles, dirSkillFiles] = await Promise.all([
      glob('*.md', { cwd: skillsRoot }),
      glob('*/SKILL.md', { cwd: skillsRoot }),
    ]);
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

  const skillsDir = path.join(cursorDir, 'skills');
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
 * Install global OpenCode skills to ~/.config/opencode/skill/gitnexus/
 */
async function installOpenCodeSkills(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) return;

  const skillsDir = path.join(opencodeDir, 'skill');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(
        `OpenCode skills (${installed.length} skills → ~/.config/opencode/skill/)`,
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

  const skillsDir = path.join(os.homedir(), '.agents', 'skills');
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

export const setupCommand = async () => {
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
  await setupCursor(result);
  await setupClaudeCode(result);
  await setupOpenCode(result);
  await setupCodex(result);

  // Install global skills for platforms that support them
  await installClaudeCodeSkills(result);
  await installClaudeCodeHooks(result);
  await installCursorSkills(result);
  await installOpenCodeSkills(result);
  await installCodexSkills(result);

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
  console.log('');
  console.log('  Next steps:');
  console.log('    1. cd into any git repo');
  console.log('    2. Run: gitnexus analyze');
  console.log('    3. Open the repo in your editor — MCP is ready!');
  console.log('');
};
