import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractPythonWorkspaceLinks } from '../../../src/core/group/extractors/python-workspace-extractor.js';

describe('PythonWorkspaceExtractor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-py-ws-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(relPath: string, content: string) {
    const absPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
  }

  it('discovers cross-package imports via pyproject.toml', async () => {
    await writeFile(
      'models/pyproject.toml',
      '[project]\nname = "shared-models"\nversion = "0.1.0"\ndependencies = []\n',
    );
    await writeFile('models/shared_models/__init__.py', 'class Schema: pass\n');

    await writeFile(
      'api/pyproject.toml',
      '[project]\nname = "api-server"\nversion = "0.1.0"\ndependencies = [\n  "shared-models>=0.1.0",\n]\n',
    );
    await writeFile('api/api_server/main.py', 'from shared_models import Schema\n');

    const repos = { models: 'shared-models', api: 'api-server' };
    const repoPaths = new Map([
      ['models', path.join(tmpDir, 'models')],
      ['api', path.join(tmpDir, 'api')],
    ]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toEqual({
      from: 'models',
      to: 'api',
      type: 'custom',
      contract: 'shared-models::Schema',
      role: 'provider',
    });
  });

  it('discovers imports via setup.py', async () => {
    await writeFile(
      'core/setup.py',
      "from setuptools import setup\nsetup(name='mycore', version='1.0', install_requires=[])\n",
    );
    await writeFile('core/mycore/__init__.py', 'class Engine: pass\n');

    await writeFile(
      'app/setup.py',
      "from setuptools import setup\nsetup(name='myapp', version='1.0', install_requires=['mycore>=1.0'])\n",
    );
    await writeFile('app/myapp/run.py', 'from mycore import Engine\n');

    const repos = { core: 'mycore', app: 'myapp' };
    const repoPaths = new Map([
      ['core', path.join(tmpDir, 'core')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('mycore::Engine');
  });

  it('handles hyphenated package names (normalized to underscore in imports)', async () => {
    await writeFile(
      'lib/pyproject.toml',
      '[project]\nname = "my-utils"\nversion = "0.1.0"\ndependencies = []\n',
    );
    await writeFile('lib/my_utils/__init__.py', 'class Helper: pass\n');

    await writeFile(
      'svc/pyproject.toml',
      '[project]\nname = "my-service"\nversion = "0.1.0"\ndependencies = [\n  "my-utils",\n]\n',
    );
    await writeFile('svc/my_service/main.py', 'from my_utils import Helper\n');

    const repos = { lib: 'my-utils', svc: 'my-service' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['svc', path.join(tmpDir, 'svc')],
    ]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('my-utils::Helper');
  });

  it('handles submodule imports (from pkg.sub import Class)', async () => {
    await writeFile(
      'lib/pyproject.toml',
      '[project]\nname = "datalib"\nversion = "0.1.0"\ndependencies = []\n',
    );
    await writeFile('lib/datalib/models.py', 'class Record: pass\n');

    await writeFile(
      'app/pyproject.toml',
      '[project]\nname = "myapp"\nversion = "0.1.0"\ndependencies = [\n  "datalib",\n]\n',
    );
    await writeFile('app/myapp/main.py', 'from datalib.models import Record\n');

    const repos = { lib: 'datalib', app: 'myapp' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('datalib::Record');
  });

  it('ignores snake_case imports (functions, not types)', async () => {
    await writeFile(
      'lib/pyproject.toml',
      '[project]\nname = "utils"\nversion = "0.1.0"\ndependencies = []\n',
    );
    await writeFile('lib/utils/__init__.py', 'def helper(): pass\nclass Config: pass\n');

    await writeFile(
      'app/pyproject.toml',
      '[project]\nname = "myapp"\nversion = "0.1.0"\ndependencies = [\n  "utils",\n]\n',
    );
    await writeFile('app/myapp/main.py', 'from utils import helper, Config\n');

    const repos = { lib: 'utils', app: 'myapp' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('utils::Config');
  });

  it('skips repos without Python manifest', async () => {
    await writeFile('js-app/package.json', '{"name": "js-app"}');

    const repos = { app: 'js-app' };
    const repoPaths = new Map([['app', path.join(tmpDir, 'js-app')]]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(0);
    expect(result.discoveredPackages.size).toBe(0);
  });

  it('deduplicates identical imports from multiple files', async () => {
    await writeFile(
      'lib/pyproject.toml',
      '[project]\nname = "shared"\nversion = "0.1.0"\ndependencies = []\n',
    );
    await writeFile('lib/shared/__init__.py', 'class Config: pass\n');

    await writeFile(
      'app/pyproject.toml',
      '[project]\nname = "myapp"\nversion = "0.1.0"\ndependencies = [\n  "shared",\n]\n',
    );
    await writeFile('app/myapp/a.py', 'from shared import Config\n');
    await writeFile('app/myapp/b.py', 'from shared import Config\n');

    const repos = { lib: 'shared', app: 'myapp' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
  });

  it('handles aliased imports (from pkg import Foo as Bar)', async () => {
    await writeFile(
      'lib/pyproject.toml',
      '[project]\nname = "models"\nversion = "0.1.0"\ndependencies = []\n',
    );
    await writeFile('lib/models/__init__.py', 'class Entity: pass\n');

    await writeFile(
      'app/pyproject.toml',
      '[project]\nname = "myapp"\nversion = "0.1.0"\ndependencies = [\n  "models",\n]\n',
    );
    await writeFile('app/myapp/main.py', 'from models import Entity as BaseEntity\n');

    const repos = { lib: 'models', app: 'myapp' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('models::Entity');
  });

  it('reads optional-dependencies from pyproject.toml', async () => {
    await writeFile(
      'lib/pyproject.toml',
      '[project]\nname = "extras"\nversion = "0.1.0"\ndependencies = []\n',
    );
    await writeFile('lib/extras/__init__.py', 'class Plugin: pass\n');

    await writeFile(
      'app/pyproject.toml',
      '[project]\nname = "myapp"\nversion = "0.1.0"\ndependencies = []\n\n[project.optional-dependencies]\ndev = [\n  "extras>=0.1",\n]\n',
    );
    await writeFile('app/myapp/main.py', 'from extras import Plugin\n');

    const repos = { lib: 'extras', app: 'myapp' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractPythonWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('extras::Plugin');
  });
});
