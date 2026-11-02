/**
 * One-line identity printed before every CLI action:
 * `GitNexus Analyzer (1.6.10)`. Goes to stderr so stdout stays
 * pipe/JSON-safe (`gitnexus query … | jq`, `status --json`).
 */

import type { Command } from 'commander';
import { packageVersion } from '../core/package-version.js';

const SKIP_COMMAND_BANNER = new Set(['__update-check', 'help']);

const SPECIAL_TITLES: Record<string, string> = {
  analyze: 'Analyzer',
  mcp: 'MCP',
};

export function installedCliVersion(): string {
  return packageVersion();
}

export function commandDisplayName(name: string): string {
  return (
    SPECIAL_TITLES[name] ??
    name
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

export function commandBannerTitle(command: Command): string {
  const names: string[] = [];
  for (
    let current: Command | null | undefined = command;
    current?.parent;
    current = current.parent
  ) {
    names.unshift(current.name());
  }
  return names.map(commandDisplayName).join(' ');
}

export function formatCommandBanner(
  title: string,
  version: string = installedCliVersion(),
): string {
  if (!title) return '';
  return version ? `\n  GitNexus ${title} (${version})\n` : `\n  GitNexus ${title}\n`;
}

export interface WriteCommandBannerDependencies {
  write?: (text: string) => void;
  version?: string;
}

export function writeCommandBanner(
  command: Command,
  deps: WriteCommandBannerDependencies = {},
): void {
  if (SKIP_COMMAND_BANNER.has(command.name())) return;
  const text = formatCommandBanner(
    commandBannerTitle(command),
    deps.version ?? installedCliVersion(),
  );
  if (!text) return;
  (deps.write ?? ((line) => process.stderr.write(line)))(text);
}
