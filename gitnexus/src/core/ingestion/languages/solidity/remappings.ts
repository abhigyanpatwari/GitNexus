/**
 * Load Foundry-style import remappings from remappings.txt / foundry.toml.
 * Never executes Foundry — parse-only hints for import resolution.
 */

import fs from 'node:fs';
import path from 'node:path';

export type SolidityRemappingConfig = {
  /** Longest-prefix-first aliases: `forge-std/` → `lib/forge-std/src/` */
  readonly aliases: ReadonlyMap<string, string>;
};

function parseRemappingLine(line: string): { prefix: string; target: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const prefix = trimmed.slice(0, eq).trim();
  const target = trimmed.slice(eq + 1).trim();
  if (!prefix || !target) return null;
  return { prefix, target };
}

function loadRemappingsTxt(repoPath: string, into: Map<string, string>): void {
  const file = path.join(repoPath, 'remappings.txt');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseRemappingLine(line);
    if (parsed) into.set(parsed.prefix, parsed.target.replace(/\\/g, '/'));
  }
}

/**
 * Minimal foundry.toml remappings extractor — no TOML dependency.
 * Matches `remappings = ["a/=b/", 'c/=d/']` (single-line or multiline arrays).
 */
function loadFoundryTomlRemappings(repoPath: string, into: Map<string, string>): void {
  const file = path.join(repoPath, 'foundry.toml');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const block = text.match(/remappings\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return;
  const body = block[1] ?? '';
  for (const m of body.matchAll(/["']([^"']+)["']/g)) {
    const parsed = parseRemappingLine(m[1] ?? '');
    if (parsed) into.set(parsed.prefix, parsed.target.replace(/\\/g, '/'));
  }
}

export function loadSolidityRemappings(repoPath: string): SolidityRemappingConfig {
  const aliases = new Map<string, string>();
  // foundry.toml first, remappings.txt overrides (common Foundry convention).
  try {
    loadFoundryTomlRemappings(repoPath, aliases);
  } catch {
    // ignore unreadable config
  }
  try {
    loadRemappingsTxt(repoPath, aliases);
  } catch {
    // ignore
  }
  return { aliases };
}

/** Apply longest-prefix remapping; return rewritten path or null if no match. */
export function applySolidityRemapping(
  importPath: string,
  config: SolidityRemappingConfig | undefined,
): string | null {
  if (!config || config.aliases.size === 0) return null;
  const stripped = importPath.replace(/^['"]|['"]$/g, '').trim();
  if (!stripped || stripped.startsWith('.')) return null;

  let bestPrefix = '';
  let bestTarget = '';
  for (const [prefix, target] of config.aliases) {
    if (stripped.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestTarget = target;
    }
  }
  if (!bestPrefix) return null;
  return bestTarget + stripped.slice(bestPrefix.length);
}
