/**
 * Unit coverage for Foundry remapping loaders (foundry.toml regex + remappings.txt).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySolidityRemapping,
  loadSolidityRemappings,
} from '../../src/core/ingestion/languages/solidity/remappings.js';

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-sol-remap-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('loadSolidityRemappings', () => {
  it('loads remappings from a multiline foundry.toml array', async () => {
    const dir = await makeRepo();
    await fs.writeFile(
      path.join(dir, 'foundry.toml'),
      `[profile.default]
src = "src"
remappings = [
  "forge-std/=lib/forge-std/src/",
  'ds-test/=lib/ds-test/src/',
]
`,
      'utf8',
    );

    const config = loadSolidityRemappings(dir);
    expect(config.aliases.get('forge-std/')).toBe('lib/forge-std/src/');
    expect(config.aliases.get('ds-test/')).toBe('lib/ds-test/src/');
    expect(applySolidityRemapping('forge-std/Test.sol', config)).toBe(
      'lib/forge-std/src/Test.sol',
    );
  });

  it('loads remappings from a single-line foundry.toml array', async () => {
    const dir = await makeRepo();
    await fs.writeFile(
      path.join(dir, 'foundry.toml'),
      `remappings = ["@oz/=lib/openzeppelin/contracts/"]\n`,
      'utf8',
    );

    const config = loadSolidityRemappings(dir);
    expect(applySolidityRemapping('@oz/access/Ownable.sol', config)).toBe(
      'lib/openzeppelin/contracts/access/Ownable.sol',
    );
  });

  it('lets remappings.txt override foundry.toml (Foundry convention)', async () => {
    const dir = await makeRepo();
    await fs.writeFile(
      path.join(dir, 'foundry.toml'),
      `remappings = ["forge-std/=lib/old/src/"]\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'remappings.txt'),
      'forge-std/=lib/helper/src/\n',
      'utf8',
    );

    const config = loadSolidityRemappings(dir);
    expect(config.aliases.get('forge-std/')).toBe('lib/helper/src/');
    expect(applySolidityRemapping('forge-std/Helper.sol', config)).toBe(
      'lib/helper/src/Helper.sol',
    );
  });

  it('returns empty aliases when neither config file exists', async () => {
    const dir = await makeRepo();
    const config = loadSolidityRemappings(dir);
    expect(config.aliases.size).toBe(0);
    expect(applySolidityRemapping('forge-std/Test.sol', config)).toBeNull();
  });
});
