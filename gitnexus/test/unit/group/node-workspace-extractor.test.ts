import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractNodeWorkspaceLinks } from '../../../src/core/group/extractors/node-workspace-extractor.js';

describe('NodeWorkspaceExtractor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-node-ws-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(relPath: string, content: string) {
    const absPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
  }

  it('handles CommonJS destructured require', async () => {
    await writeFile('lib/package.json', JSON.stringify({ name: 'auth-lib', version: '1.0.0' }));
    await writeFile('lib/src/index.js', 'module.exports = { Authenticator: class {} };\n');

    await writeFile(
      'svc/package.json',
      JSON.stringify({
        name: 'api-svc',
        version: '1.0.0',
        dependencies: { 'auth-lib': 'workspace:*' },
      }),
    );
    await writeFile('svc/src/handler.js', "const { Authenticator } = require('auth-lib');\n");

    const repos = { lib: 'auth-lib', svc: 'api-svc' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['svc', path.join(tmpDir, 'svc')],
    ]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('auth-lib::Authenticator');
  });

  it('skips repos without package.json', async () => {
    await writeFile('rust-app/Cargo.toml', '[package]\nname = "rapp"\nversion = "0.1.0"\n');
    await writeFile('rust-app/src/main.rs', 'fn main() {}\n');

    const repos = { app: 'rapp' };
    const repoPaths = new Map([['app', path.join(tmpDir, 'rust-app')]]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(0);
    expect(result.discoveredPackages.size).toBe(0);
  });
});
