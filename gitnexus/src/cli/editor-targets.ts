/**
 * Editor targets — the single source of truth for *where* GitNexus writes its
 * per-editor configuration and *how* its entries are identified.
 *
 * `setup` (writes these) and `uninstall` (removes them) both consume this
 * module so the two stay structurally in lock-step: add or change a target
 * here and both sides follow. This is declarative metadata only — file
 * locations, JSON key paths, hook event names, command needles, and script
 * directories, plus the shared `detectIndentation` formatting helper. The
 * format-specific read/write logic (JSONC merge, TOML upsert, OpenCode's flat
 * command array, Gemini's hook schema) deliberately stays in setup.ts /
 * uninstall.ts.
 *
 * The `setup → uninstall` round-trip integration test verifies the two
 * implementations remain behaviourally symmetrical on top of this shared
 * structure.
 */

import os from 'os';
import path from 'path';

export type EditorId =
  | 'cursor'
  | 'claude'
  | 'antigravity'
  | 'opencode'
  | 'codebuddy'
  | 'qoder'
  | 'codex';

/** An editor whose MCP config is a JSONC document (server keyed by name). */
export interface McpJsoncTarget {
  id: EditorId;
  label: string;
  /** Absolute path to the editor's MCP config file. */
  file: string;
  /**
   * JSON path of the gitnexus server entry within that file. Typed as
   * `string[]` (all our keys are object keys) so it satisfies both setup's
   * `mergeJsoncFile(string[])` and uninstall's `removeJsoncKey(JSONPath)`
   * without either side needing a cast.
   */
  keyPath: string[];
  /**
   * Older config locations the editor still reads when `file` is absent
   * (CodeBuddy reads only the FIRST existing file in its priority chain).
   * Setup writes into the first existing candidate of [file, ...legacyFiles]
   * so it never shadows a user's servers living in a deprecated file;
   * uninstall sweeps all of them.
   */
  legacyFiles?: string[];
}

/** Codex stores MCP config as a TOML table, not JSONC. */
export interface CodexMcpTarget {
  id: 'codex';
  label: string;
  /** Absolute path to ~/.codex/config.toml. */
  configFile: string;
  /** The TOML table header (without brackets) setup writes / uninstall strips. */
  tomlSection: string;
}

export interface SkillTarget {
  id: EditorId;
  label: string;
  /** Absolute path to the editor's skills directory. */
  dir: string;
}

export interface HookTarget {
  id: EditorId;
  label: string;
  /** Absolute path to the editor's settings file (JSONC). */
  settingsFile: string;
  /** Hook event arrays that may hold a gitnexus entry. */
  events: string[];
  /** Substring identifying the gitnexus command within a hook entry. */
  needle: string;
  /** Absolute path to the bundled hook-script directory setup writes. */
  scriptDir: string;
}

export interface EditorTargets {
  /** JSONC-format MCP entries: Cursor, Claude Code, Antigravity, OpenCode, CodeBuddy, Qoder. */
  mcpJsonc: McpJsoncTarget[];
  /** Codex MCP (TOML). */
  codex: CodexMcpTarget;
  /** Skill install directories, one per editor that supports skills. */
  skills: SkillTarget[];
  /** Hook registrations + their bundled script directories. */
  hooks: HookTarget[];
}

/**
 * Resolve all editor targets for the given home directory. Defaults to
 * `os.homedir()`; call sites pass it through so tests can point HOME at a temp
 * dir. Paths are computed at call time (not module load) so a test setting
 * `process.env.HOME` before invoking sees the right locations.
 */
export function getEditorTargets(home: string = os.homedir()): EditorTargets {
  const mcpJsonc: McpJsoncTarget[] = [
    {
      id: 'cursor',
      label: 'Cursor',
      file: path.join(home, '.cursor', 'mcp.json'),
      keyPath: ['mcpServers', 'gitnexus'],
    },
    {
      id: 'claude',
      label: 'Claude Code',
      file: path.join(home, '.claude.json'),
      keyPath: ['mcpServers', 'gitnexus'],
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      keyPath: ['mcpServers', 'gitnexus'],
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      file: path.join(home, '.config', 'opencode', 'opencode.json'),
      // OpenCode nests servers under `mcp`, not `mcpServers`.
      keyPath: ['mcp', 'gitnexus'],
    },
    {
      id: 'codebuddy',
      label: 'CodeBuddy',
      // Recommended user-scope path per https://www.codebuddy.ai/docs/cli/mcp;
      // CodeBuddy reads only the first existing file in this priority chain.
      file: path.join(home, '.codebuddy', '.mcp.json'),
      legacyFiles: [
        path.join(home, '.codebuddy', 'mcp.json'), // deprecated
        path.join(home, '.codebuddy.json'), // legacy
      ],
      keyPath: ['mcpServers', 'gitnexus'],
    },
    {
      id: 'qoder',
      label: 'Qoder',
      // Qoder's documented user-scope MCP config (https://docs.qoder.com/cli/using-cli);
      // the IDE manages MCP via its Settings UI with no documented file path.
      file: path.join(home, '.qoder.json'),
      keyPath: ['mcpServers', 'gitnexus'],
    },
  ];

  const codex: CodexMcpTarget = {
    id: 'codex',
    label: 'Codex',
    configFile: path.join(home, '.codex', 'config.toml'),
    tomlSection: 'mcp_servers.gitnexus',
  };

  const skills: SkillTarget[] = [
    { id: 'claude', label: 'Claude Code', dir: path.join(home, '.claude', 'skills') },
    {
      id: 'antigravity',
      label: 'Antigravity',
      dir: path.join(home, '.gemini', 'antigravity', 'skills'),
    },
    { id: 'cursor', label: 'Cursor', dir: path.join(home, '.cursor', 'skills') },
    { id: 'opencode', label: 'OpenCode', dir: path.join(home, '.config', 'opencode', 'skills') },
    { id: 'codebuddy', label: 'CodeBuddy', dir: path.join(home, '.codebuddy', 'skills') },
    // Qoder skills live at ~/.qoder/skills/{name}/SKILL.md
    // (https://docs.qoder.com/extensions/skills).
    { id: 'qoder', label: 'Qoder', dir: path.join(home, '.qoder', 'skills') },
    // Codex reads skills from ~/.agents/skills (not ~/.codex).
    { id: 'codex', label: 'Codex', dir: path.join(home, '.agents', 'skills') },
  ];

  const hooks: HookTarget[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      settingsFile: path.join(home, '.claude', 'settings.json'),
      events: ['PreToolUse', 'PostToolUse'],
      needle: 'gitnexus-hook',
      scriptDir: path.join(home, '.claude', 'hooks', 'gitnexus'),
    },
    {
      id: 'codex',
      label: 'Codex',
      // Codex hooks use Claude Code's exact {hooks: {Event: [...]}} JSON shape
      // and hookSpecificOutput response contract, in a dedicated hooks.json
      // (https://developers.openai.com/codex/hooks).
      settingsFile: path.join(home, '.codex', 'hooks.json'),
      events: ['PreToolUse', 'PostToolUse'],
      needle: 'gitnexus-hook',
      scriptDir: path.join(home, '.codex', 'hooks', 'gitnexus'),
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      settingsFile: path.join(home, '.gemini', 'settings.json'),
      events: ['AfterTool'],
      needle: 'gitnexus-antigravity-hook',
      scriptDir: path.join(home, '.gemini', 'config', 'hooks', 'gitnexus'),
    },
  ];

  return { mcpJsonc, codex, skills, hooks };
}

/** Look up a single JSONC MCP target by editor id (throws if unknown). */
export function mcpTarget(id: EditorId, home?: string): McpJsoncTarget {
  const t = getEditorTargets(home).mcpJsonc.find((m) => m.id === id);
  if (!t) throw new Error(`No JSONC MCP target for editor "${id}"`);
  return t;
}

/** Look up a single skill target by editor id (throws if unknown). */
export function skillTarget(id: EditorId, home?: string): SkillTarget {
  const t = getEditorTargets(home).skills.find((s) => s.id === id);
  if (!t) throw new Error(`No skill target for editor "${id}"`);
  return t;
}

/** Look up a single hook target by editor id (throws if unknown). */
export function hookTarget(id: EditorId, home?: string): HookTarget {
  const t = getEditorTargets(home).hooks.find((h) => h.id === id);
  if (!t) throw new Error(`No hook target for editor "${id}"`);
  return t;
}

/**
 * True when err is a Node fs error with code ENOENT (file/dir absent).
 * Shared by setup and uninstall: both must swallow ONLY absence when reading
 * editor configs — any other read/stat failure (EACCES, EIO) is surfaced so an
 * unreadable config is never treated as empty and rewritten gitnexus-only.
 */
export function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Detect indentation style from file content so JSONC edits preserve the file's
 * existing formatting. Shared by setup (writes) and uninstall (removes).
 */
export function detectIndentation(raw: string): { tabSize: number; insertSpaces: boolean } {
  const firstIndented = raw.match(/^( +|\t)/m);
  if (!firstIndented) return { tabSize: 2, insertSpaces: true };
  if (firstIndented[1] === '\t') return { tabSize: 1, insertSpaces: false };
  return { tabSize: firstIndented[1].length, insertSpaces: true };
}
