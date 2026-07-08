import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractGoWorkspaceLinks } from '../../../src/core/group/extractors/go-workspace-extractor.js';

describe('GoWorkspaceExtractor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-go-ws-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(relPath: string, content: string) {
    const absPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
  }

  it('discovers cross-module type usage via require', async () => {
    await writeFile('models/go.mod', 'module github.com/org/models\n\ngo 1.21\n');
    await writeFile('models/schema.go', 'package models\n\ntype Schema struct {}\n');

    await writeFile(
      'api/go.mod',
      'module github.com/org/api\n\ngo 1.21\n\nrequire github.com/org/models v0.1.0\n',
    );
    await writeFile(
      'api/main.go',
      'package main\n\nimport "github.com/org/models"\n\nfunc main() {\n\tvar s models.Schema\n\t_ = s\n}\n',
    );

    const repos = {
      'libs/models': 'models',
      'services/api': 'api',
    };
    const repoPaths = new Map([
      ['libs/models', path.join(tmpDir, 'models')],
      ['services/api', path.join(tmpDir, 'api')],
    ]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toEqual({
      from: 'libs/models',
      to: 'services/api',
      type: 'custom',
      contract: 'github.com/org/models::Schema',
      role: 'provider',
    });
  });

  it('handles block require syntax', async () => {
    await writeFile('auth/go.mod', 'module github.com/org/auth\n\ngo 1.21\n');
    await writeFile('auth/token.go', 'package auth\n\ntype Token struct {}\n');

    await writeFile(
      'svc/go.mod',
      'module github.com/org/svc\n\ngo 1.21\n\nrequire (\n\tgithub.com/org/auth v1.0.0\n)\n',
    );
    await writeFile(
      'svc/main.go',
      'package main\n\nimport (\n\t"github.com/org/auth"\n)\n\nfunc handle() auth.Token { return auth.Token{} }\n',
    );

    const repos = { auth: 'auth', svc: 'svc' };
    const repoPaths = new Map([
      ['auth', path.join(tmpDir, 'auth')],
      ['svc', path.join(tmpDir, 'svc')],
    ]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('github.com/org/auth::Token');
  });

  it('handles subpackage imports (module/pkg)', async () => {
    await writeFile('core/go.mod', 'module github.com/org/core\n\ngo 1.21\n');
    await writeFile('core/types/entity.go', 'package types\n\ntype Entity struct {}\n');

    await writeFile(
      'app/go.mod',
      'module github.com/org/app\n\ngo 1.21\n\nrequire github.com/org/core v0.1.0\n',
    );
    await writeFile(
      'app/main.go',
      'package main\n\nimport "github.com/org/core/types"\n\nvar e types.Entity\n',
    );

    const repos = { core: 'core', app: 'app' };
    const repoPaths = new Map([
      ['core', path.join(tmpDir, 'core')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('github.com/org/core::Entity');
  });

  it('handles replace directive with local paths', async () => {
    await writeFile('lib/go.mod', 'module github.com/org/lib\n\ngo 1.21\n');
    await writeFile('lib/config.go', 'package lib\n\ntype Config struct {}\n');

    await writeFile(
      'app/go.mod',
      'module github.com/org/app\n\ngo 1.21\n\nrequire github.com/org/lib v0.0.0\n\nreplace github.com/org/lib => ./lib\n',
    );
    await writeFile(
      'app/main.go',
      'package main\n\nimport "github.com/org/lib"\n\nvar c lib.Config\n',
    );

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('github.com/org/lib::Config');
  });

  it('ignores unexported (lowercase) identifiers', async () => {
    await writeFile('lib/go.mod', 'module github.com/org/lib\n\ngo 1.21\n');
    await writeFile('lib/util.go', 'package lib\n\nfunc helper() {}\ntype Config struct {}\n');

    await writeFile(
      'app/go.mod',
      'module github.com/org/app\n\ngo 1.21\n\nrequire github.com/org/lib v0.1.0\n',
    );
    await writeFile(
      'app/main.go',
      'package main\n\nimport "github.com/org/lib"\n\nvar c lib.Config\n',
    );

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('github.com/org/lib::Config');
  });

  it('does not produce links for aliased imports (V1 false-negative limitation)', async () => {
    await writeFile('shared/go.mod', 'module github.com/org/shared\n\ngo 1.21\n');
    await writeFile('shared/config.go', 'package shared\n\ntype Config struct {}\n');

    await writeFile(
      'app/go.mod',
      'module github.com/org/app\n\ngo 1.21\n\nrequire github.com/org/shared v0.1.0\n',
    );
    await writeFile(
      'app/main.go',
      'package main\n\nimport cfg "github.com/org/shared"\n\nvar c cfg.Config\n',
    );

    const repos = { shared: 'shared', app: 'app' };
    const repoPaths = new Map([
      ['shared', path.join(tmpDir, 'shared')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(0);
  });

  it('skips repos without go.mod', async () => {
    await writeFile('js-app/package.json', '{"name": "js-app"}');

    const repos = { app: 'js-app' };
    const repoPaths = new Map([['app', path.join(tmpDir, 'js-app')]]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(0);
    expect(result.discoveredModules.size).toBe(0);
  });

  it('deduplicates identical type usage from multiple files', async () => {
    await writeFile('lib/go.mod', 'module github.com/org/lib\n\ngo 1.21\n');
    await writeFile('lib/model.go', 'package lib\n\ntype Model struct {}\n');

    await writeFile(
      'app/go.mod',
      'module github.com/org/app\n\ngo 1.21\n\nrequire github.com/org/lib v0.1.0\n',
    );
    await writeFile('app/a.go', 'package main\n\nimport "github.com/org/lib"\n\nvar x lib.Model\n');
    await writeFile('app/b.go', 'package main\n\nimport "github.com/org/lib"\n\nvar y lib.Model\n');

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
  });

  it('discovers multiple types from the same module', async () => {
    await writeFile('lib/go.mod', 'module github.com/org/lib\n\ngo 1.21\n');
    await writeFile(
      'lib/types.go',
      'package lib\n\ntype Request struct {}\ntype Response struct {}\n',
    );

    await writeFile(
      'app/go.mod',
      'module github.com/org/app\n\ngo 1.21\n\nrequire github.com/org/lib v0.1.0\n',
    );
    await writeFile(
      'app/main.go',
      'package main\n\nimport "github.com/org/lib"\n\nfunc handle(r lib.Request) lib.Response { return lib.Response{} }\n',
    );

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractGoWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(2);
    const contracts = result.links.map((l) => l.contract).sort();
    expect(contracts).toEqual(['github.com/org/lib::Request', 'github.com/org/lib::Response']);
  });
});
