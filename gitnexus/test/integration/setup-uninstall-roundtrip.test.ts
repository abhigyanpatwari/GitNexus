import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { getEditorTargets } from '../../src/cli/editor-targets.js';

// Force the Codex path through the TOML fallback (no `codex` binary) so the
// round-trip is observable on config.toml, and make `which/where gitnexus`
// miss so getMcpEntry uses the npx form. Mirrors the unit-test mocks.
const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') callback(new Error('not available'), '', '');
});
const execFileSyncMock = vi.fn(() => {
  throw new Error('not found');
});
vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

/** Read a value at a JSON key path, or undefined if any segment is missing. */
function valueAtPath(obj: any, keyPath: string[]): unknown {
  return keyPath.reduce((o: any, k) => (o == null ? undefined : o[k]), obj);
}

/** Does any of `events` hold a hook entry whose command contains `needle`? */
function hasHookNeedle(settings: any, events: string[], needle: string): boolean {
  return events.some(
    (ev) =>
      Array.isArray(settings?.hooks?.[ev]) &&
      settings.hooks[ev].some(
        (entry: any) =>
          Array.isArray(entry?.hooks) &&
          entry.hooks.some(
            (h: any) => typeof h?.command === 'string' && h.command.includes(needle),
          ),
      ),
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonc(p: string): Promise<any> {
  return parseJsonc(await fs.readFile(p, 'utf-8'));
}

/**
 * setup → uninstall round-trip. This is the drift tripwire for #2062: it
 * iterates over getEditorTargets() (the shared source of truth that both
 * setup.ts and uninstall.ts consume), so if one side gains/loses/relocates a
 * target without the other following, this fails in CI — in both directions.
 */
describe('setup → uninstall round-trip', () => {
  let tempHome: string;
  let skillsRoot: string;
  const saved: Record<string, string | undefined> = {};
  let savedExitCode: typeof process.exitCode;

  // Two fixture skills exercise both source layouts (flat + directory).
  const flatSkill = 'gitnexus-roundtrip-flat';
  const dirSkill = 'gitnexus-roundtrip-dir';
  const skillNames = [flatSkill, dirSkill];

  beforeEach(async () => {
    vi.clearAllMocks();
    saved.HOME = process.env.HOME;
    saved.USERPROFILE = process.env.USERPROFILE;
    saved.SKILLS = process.env.GITNEXUS_TEST_SKILLS_ROOT;
    savedExitCode = process.exitCode;

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-roundtrip-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // Mark every editor as "installed" so setup configures all of them.
    for (const dir of ['.cursor', '.claude', '.codex', '.codebuddy', '.qoder']) {
      await fs.mkdir(path.join(tempHome, dir), { recursive: true });
    }
    await fs.mkdir(path.join(tempHome, '.gemini', 'antigravity'), { recursive: true });
    await fs.mkdir(path.join(tempHome, '.config', 'opencode'), { recursive: true });

    // Fixture skills consumed by both setup (install) and uninstall (derive).
    skillsRoot = path.join(tempHome, 'pkg-skills');
    await fs.mkdir(path.join(skillsRoot, dirSkill), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, `${flatSkill}.md`),
      `---\nname: ${flatSkill}\ndescription: flat\n---\n\n# Flat`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(skillsRoot, dirSkill, 'SKILL.md'),
      `---\nname: ${dirSkill}\ndescription: dir\n---\n\n# Dir`,
      'utf-8',
    );
    process.env.GITNEXUS_TEST_SKILLS_ROOT = skillsRoot;

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.SKILLS === undefined) delete process.env.GITNEXUS_TEST_SKILLS_ROOT;
    else process.env.GITNEXUS_TEST_SKILLS_ROOT = saved.SKILLS;
    process.exitCode = savedExitCode;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('setup writes every target and uninstall removes all of them', async () => {
    const targets = getEditorTargets(tempHome);

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    // ── After setup: every target artifact is present ──
    for (const t of targets.mcpJsonc) {
      const cfg = await readJsonc(t.file);
      expect(valueAtPath(cfg, t.keyPath), `setup should write ${t.label} MCP`).toBeDefined();
    }
    expect(await fs.readFile(targets.codex.configFile, 'utf-8')).toContain(
      `[${targets.codex.tomlSection}]`,
    );
    for (const t of targets.skills) {
      for (const name of skillNames) {
        expect(
          await exists(path.join(t.dir, name, 'SKILL.md')),
          `setup should install ${name} into ${t.label}`,
        ).toBe(true);
      }
    }
    for (const h of targets.hooks) {
      const settings = await readJsonc(h.settingsFile);
      expect(
        hasHookNeedle(settings, h.events, h.needle),
        `setup should register ${h.label} hook`,
      ).toBe(true);
      expect(await exists(h.scriptDir), `setup should install ${h.label} hook scripts`).toBe(true);
    }

    // ── Round-trip: uninstall removes everything setup wrote ──
    const { uninstallCommand } = await import('../../src/cli/uninstall.js');
    await uninstallCommand({ force: true });

    for (const t of targets.mcpJsonc) {
      const cfg = await readJsonc(t.file);
      expect(valueAtPath(cfg, t.keyPath), `uninstall should remove ${t.label} MCP`).toBeUndefined();
    }
    expect(await fs.readFile(targets.codex.configFile, 'utf-8')).not.toContain(
      `[${targets.codex.tomlSection}]`,
    );
    for (const t of targets.skills) {
      for (const name of skillNames) {
        expect(
          await exists(path.join(t.dir, name)),
          `uninstall should remove ${name} from ${t.label}`,
        ).toBe(false);
      }
    }
    for (const h of targets.hooks) {
      const settings = await readJsonc(h.settingsFile);
      expect(
        hasHookNeedle(settings, h.events, h.needle),
        `uninstall should remove ${h.label} hook`,
      ).toBe(false);
      expect(await exists(h.scriptDir), `uninstall should remove ${h.label} hook scripts`).toBe(
        false,
      );
    }
  });

  it('round-trips a CodeBuddy entry living in the home-level legacy ~/.codebuddy.json (chain position 3)', async () => {
    const targets = getEditorTargets(tempHome);
    const codebuddy = targets.mcpJsonc.find((t) => t.id === 'codebuddy')!;
    const legacyHomeFile = codebuddy.legacyFiles![1];

    await fs.writeFile(
      legacyHomeFile,
      JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const cfg = await readJsonc(legacyHomeFile);
    expect(valueAtPath(cfg, codebuddy.keyPath)).toBeDefined();
    expect(await exists(codebuddy.file)).toBe(false);

    const { uninstallCommand } = await import('../../src/cli/uninstall.js');
    await uninstallCommand({ force: true });

    const after = await readJsonc(legacyHomeFile);
    expect(valueAtPath(after, codebuddy.keyPath)).toBeUndefined();
    expect(after.mcpServers.mine).toEqual({ command: 'mine' });
  });

  it('round-trips a CodeBuddy entry living in the deprecated mcp.json (legacyFiles sweep)', async () => {
    const targets = getEditorTargets(tempHome);
    const codebuddy = targets.mcpJsonc.find((t) => t.id === 'codebuddy')!;
    const deprecatedFile = codebuddy.legacyFiles![0];

    // A populated deprecated config makes setup write there (CodeBuddy reads
    // only the first existing file in its chain), not the recommended path.
    await fs.writeFile(
      deprecatedFile,
      JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const cfg = await readJsonc(deprecatedFile);
    expect(valueAtPath(cfg, codebuddy.keyPath)).toBeDefined();
    expect(await exists(codebuddy.file)).toBe(false);

    const { uninstallCommand } = await import('../../src/cli/uninstall.js');
    await uninstallCommand({ force: true });

    const after = await readJsonc(deprecatedFile);
    expect(valueAtPath(after, codebuddy.keyPath)).toBeUndefined();
    expect(after.mcpServers.mine).toEqual({ command: 'mine' });
  });

  it('uninstall preserves a co-located user MCP server and hook', async () => {
    const targets = getEditorTargets(tempHome);
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    // Add a user-owned MCP server alongside gitnexus in Cursor's config, and a
    // user hook alongside gitnexus in Claude's PreToolUse.
    const cursor = targets.mcpJsonc.find((t) => t.id === 'cursor')!;
    const cursorCfg = await readJsonc(cursor.file);
    cursorCfg.mcpServers.mine = { command: 'mine' };
    await fs.writeFile(cursor.file, JSON.stringify(cursorCfg, null, 2), 'utf-8');

    const claudeHook = targets.hooks.find((h) => h.id === 'claude')!;
    const settings = await readJsonc(claudeHook.settingsFile);
    settings.hooks.PreToolUse.push({
      matcher: 'Read',
      hooks: [{ type: 'command', command: 'my-own-hook' }],
    });
    await fs.writeFile(claudeHook.settingsFile, JSON.stringify(settings, null, 2), 'utf-8');

    const { uninstallCommand } = await import('../../src/cli/uninstall.js');
    await uninstallCommand({ force: true });

    const afterCursor = await readJsonc(cursor.file);
    expect(afterCursor.mcpServers.gitnexus).toBeUndefined();
    expect(afterCursor.mcpServers.mine).toEqual({ command: 'mine' });

    const afterSettings = await readJsonc(claudeHook.settingsFile);
    const userHookSurvives = afterSettings.hooks.PreToolUse.some((e: any) =>
      e.hooks?.some((h: any) => h.command === 'my-own-hook'),
    );
    expect(userHookSurvives).toBe(true);
    expect(hasHookNeedle(afterSettings, claudeHook.events, claudeHook.needle)).toBe(false);
  });
});
