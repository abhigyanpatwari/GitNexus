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

  it('discovers cross-package ES imports', async () => {
    await writeFile(
      'pkg-a/package.json',
      JSON.stringify({ name: '@myorg/shared', version: '1.0.0' }),
    );
    await writeFile('pkg-a/src/index.ts', 'export class Config {}\nexport class Logger {}\n');

    await writeFile(
      'pkg-b/package.json',
      JSON.stringify({
        name: '@myorg/api',
        version: '1.0.0',
        dependencies: { '@myorg/shared': 'workspace:*' },
      }),
    );
    await writeFile(
      'pkg-b/src/server.ts',
      "import { Config } from '@myorg/shared';\nconst c = new Config();\n",
    );

    const repos = {
      'libs/shared': '@myorg/shared',
      'services/api': '@myorg/api',
    };
    const repoPaths = new Map([
      ['libs/shared', path.join(tmpDir, 'pkg-a')],
      ['services/api', path.join(tmpDir, 'pkg-b')],
    ]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toEqual({
      from: 'libs/shared',
      to: 'services/api',
      type: 'custom',
      contract: '@myorg/shared::Config',
      role: 'provider',
    });
  });

  it('handles default imports (PascalCase)', async () => {
    await writeFile(
      'ui-lib/package.json',
      JSON.stringify({ name: 'ui-components', version: '1.0.0' }),
    );
    await writeFile('ui-lib/src/index.ts', 'export default class Button {}\n');

    await writeFile(
      'app/package.json',
      JSON.stringify({
        name: 'web-app',
        version: '1.0.0',
        dependencies: { 'ui-components': '^1.0.0' },
      }),
    );
    await writeFile(
      'app/src/page.tsx',
      "import Button from 'ui-components';\nexport default function Page() { return <Button />; }\n",
    );

    const repos = { 'libs/ui': 'ui-components', 'apps/web': 'web-app' };
    const repoPaths = new Map([
      ['libs/ui', path.join(tmpDir, 'ui-lib')],
      ['apps/web', path.join(tmpDir, 'app')],
    ]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('ui-components::Button');
  });

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

  it('handles scoped package imports with subpaths', async () => {
    await writeFile('core/package.json', JSON.stringify({ name: '@acme/core', version: '2.0.0' }));
    await writeFile('core/src/models.ts', 'export class User {}\n');

    await writeFile(
      'web/package.json',
      JSON.stringify({
        name: '@acme/web',
        version: '1.0.0',
        dependencies: { '@acme/core': 'workspace:*' },
      }),
    );
    await writeFile('web/src/routes.ts', "import { User } from '@acme/core/models';\n");

    const repos = { core: '@acme/core', web: '@acme/web' };
    const repoPaths = new Map([
      ['core', path.join(tmpDir, 'core')],
      ['web', path.join(tmpDir, 'web')],
    ]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('@acme/core::User');
  });

  it('ignores camelCase/snake_case imports (non-type exports)', async () => {
    await writeFile('lib/package.json', JSON.stringify({ name: 'utils', version: '1.0.0' }));
    await writeFile('lib/src/index.ts', 'export function helper() {}\nexport class Formatter {}\n');

    await writeFile(
      'app/package.json',
      JSON.stringify({
        name: 'myapp',
        version: '1.0.0',
        dependencies: { utils: 'workspace:*' },
      }),
    );
    await writeFile('app/src/main.ts', "import { helper, Formatter } from 'utils';\n");

    const repos = { lib: 'utils', app: 'myapp' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('utils::Formatter');
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

  it('deduplicates identical imports from multiple files', async () => {
    await writeFile('lib/package.json', JSON.stringify({ name: 'shared', version: '1.0.0' }));
    await writeFile('lib/src/index.ts', 'export class Config {}\n');

    await writeFile(
      'app/package.json',
      JSON.stringify({
        name: 'myapp',
        version: '1.0.0',
        dependencies: { shared: 'workspace:*' },
      }),
    );
    await writeFile('app/src/a.ts', "import { Config } from 'shared';\n");
    await writeFile('app/src/b.ts', "import { Config } from 'shared';\n");

    const repos = { lib: 'shared', app: 'myapp' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
  });

  it('handles aliased imports (import { Foo as Bar })', async () => {
    await writeFile('lib/package.json', JSON.stringify({ name: 'models', version: '1.0.0' }));
    await writeFile('lib/src/index.ts', 'export class Entity {}\n');

    await writeFile(
      'app/package.json',
      JSON.stringify({
        name: 'myapp',
        version: '1.0.0',
        dependencies: { models: 'workspace:*' },
      }),
    );
    await writeFile('app/src/main.ts', "import { Entity as BaseEntity } from 'models';\n");

    const repos = { lib: 'models', app: 'myapp' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('models::Entity');
  });

  it('handles multiple packages importing from the same provider', async () => {
    await writeFile(
      'shared/package.json',
      JSON.stringify({ name: '@org/shared', version: '1.0.0' }),
    );
    await writeFile('shared/src/index.ts', 'export class Schema {}\n');

    await writeFile(
      'api/package.json',
      JSON.stringify({
        name: '@org/api',
        version: '1.0.0',
        dependencies: { '@org/shared': 'workspace:*' },
      }),
    );
    await writeFile('api/src/index.ts', "import { Schema } from '@org/shared';\n");

    await writeFile(
      'worker/package.json',
      JSON.stringify({
        name: '@org/worker',
        version: '1.0.0',
        dependencies: { '@org/shared': 'workspace:*' },
      }),
    );
    await writeFile('worker/src/index.ts', "import { Schema } from '@org/shared';\n");

    const repos = {
      libs: '@org/shared',
      api: '@org/api',
      worker: '@org/worker',
    };
    const repoPaths = new Map([
      ['libs', path.join(tmpDir, 'shared')],
      ['api', path.join(tmpDir, 'api')],
      ['worker', path.join(tmpDir, 'worker')],
    ]);

    const result = await extractNodeWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(2);
    const targets = result.links.map((l) => l.to).sort();
    expect(targets).toEqual(['api', 'worker']);
    expect(result.links.every((l) => l.contract === '@org/shared::Schema')).toBe(true);
  });
});
