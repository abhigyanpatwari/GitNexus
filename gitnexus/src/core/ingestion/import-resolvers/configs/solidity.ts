/**
 * Solidity import resolution.
 *
 * Forms:
 *   import "./Foo.sol";
 *   import {Foo} from "./Foo.sol";
 *   import "forge-std/Test.sol";
 *   import "@openzeppelin/contracts/access/Ownable.sol";
 *
 * Phase 2: relative + remappings.txt / foundry.toml prefix rewrite + suffix match.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { resolveStandard } from '../standard.js';
import {
  applySolidityRemapping,
  loadSolidityRemappings,
  type SolidityRemappingConfig,
} from '../../languages/solidity/remappings.js';

function stripQuotes(raw: string): string {
  return raw.replace(/^['"]|['"]$/g, '').trim();
}

/** Relative ./ and ../ imports. */
export const solidityRelativeStrategy: ImportResolverStrategy = (rawImportPath, filePath, ctx) => {
  const stripped = stripQuotes(rawImportPath);
  if (!stripped.startsWith('.')) return null;
  return resolveStandard(stripped, filePath, ctx, SupportedLanguages.Solidity);
};

/**
 * Foundry remapping prefix rewrite when ctx carries remappings (optional).
 * Falls through when no remapping matches.
 */
export const solidityFoundryRemappingStrategy: ImportResolverStrategy = (
  rawImportPath,
  _filePath,
  ctx,
) => {
  const stripped = stripQuotes(rawImportPath);
  if (!stripped || stripped.startsWith('.')) return null;

  const config = (ctx as { solidityRemappings?: SolidityRemappingConfig }).solidityRemappings;
  const remapped = applySolidityRemapping(stripped, config);
  if (!remapped) return null;

  const candidates: string[] = [];
  for (const fp of ctx.allFileList) {
    const norm = fp.replace(/\\/g, '/');
    if (
      norm === remapped ||
      norm.endsWith('/' + remapped) ||
      norm.startsWith(remapped) ||
      remapped.endsWith(norm)
    ) {
      candidates.push(fp);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  return { kind: 'files', files: [candidates[0]!] };
};

/**
 * Bare / remapped paths: match by suffix against the indexed file set.
 */
export const solidityRemappingStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const stripped = stripQuotes(rawImportPath);
  if (!stripped || stripped.startsWith('.')) return null;

  const candidates: string[] = [];
  for (const fp of ctx.allFileList) {
    if (fp === stripped || fp.endsWith('/' + stripped)) {
      candidates.push(fp);
      continue;
    }
    const base = stripped.includes('/') ? stripped.slice(stripped.lastIndexOf('/') + 1) : stripped;
    if (base.endsWith('.sol') && (fp.endsWith('/' + base) || fp === base)) {
      candidates.push(fp);
    }
  }

  if (candidates.length === 0) return { kind: 'files', files: [] };
  candidates.sort((a, b) => b.length - a.length);
  return { kind: 'files', files: [candidates[0]!] };
};

export const solidityImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Solidity,
  strategies: [
    solidityRelativeStrategy,
    solidityFoundryRemappingStrategy,
    solidityRemappingStrategy,
  ],
};

export { loadSolidityRemappings };
