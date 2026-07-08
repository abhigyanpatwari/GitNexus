import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractElixirWorkspaceLinks } from '../../../src/core/group/extractors/elixir-workspace-extractor.js';

describe('ElixirWorkspaceExtractor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ex-ws-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(relPath: string, content: string) {
    const absPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
  }

  it('discovers cross-app alias imports', async () => {
    await writeFile(
      'core/mix.exs',
      'defmodule Core.MixProject do\n  use Mix.Project\n  def project do\n    [app: :core, version: "0.1.0"]\n  end\nend\n',
    );
    await writeFile('core/lib/core/schema.ex', 'defmodule Core.Schema do\nend\n');

    await writeFile(
      'web/mix.exs',
      'defmodule Web.MixProject do\n  use Mix.Project\n  def project do\n    [app: :web, version: "0.1.0"]\n  end\n  defp deps do\n    [{:core, in_umbrella: true}]\n  end\nend\n',
    );
    await writeFile(
      'web/lib/web/controller.ex',
      'defmodule Web.Controller do\n  alias Core.Schema\nend\n',
    );

    const repos = { core: 'core', web: 'web' };
    const repoPaths = new Map([
      ['core', path.join(tmpDir, 'core')],
      ['web', path.join(tmpDir, 'web')],
    ]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toEqual({
      from: 'core',
      to: 'web',
      type: 'custom',
      contract: 'Core.Schema',
      role: 'provider',
    });
  });

  it('handles grouped alias (alias MyApp.{ModA, ModB})', async () => {
    await writeFile(
      'shared/mix.exs',
      'defmodule Shared.MixProject do\n  use Mix.Project\n  def project do\n    [app: :shared, version: "0.1.0"]\n  end\nend\n',
    );
    await writeFile('shared/lib/shared/config.ex', 'defmodule Shared.Config do\nend\n');
    await writeFile('shared/lib/shared/logger.ex', 'defmodule Shared.Logger do\nend\n');

    await writeFile(
      'app/mix.exs',
      'defmodule App.MixProject do\n  use Mix.Project\n  def project do\n    [app: :app, version: "0.1.0"]\n  end\n  defp deps do\n    [{:shared, "~> 0.1"}]\n  end\nend\n',
    );
    await writeFile(
      'app/lib/app/main.ex',
      'defmodule App.Main do\n  alias Shared.{Config, Logger}\nend\n',
    );

    const repos = { shared: 'shared', app: 'app' };
    const repoPaths = new Map([
      ['shared', path.join(tmpDir, 'shared')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(2);
    const contracts = result.links.map((l) => l.contract).sort();
    expect(contracts).toEqual(['Shared.Config', 'Shared.Logger']);
  });

  it('handles direct module references (no alias)', async () => {
    await writeFile(
      'auth/mix.exs',
      'defmodule Auth.MixProject do\n  use Mix.Project\n  def project do\n    [app: :auth, version: "0.1.0"]\n  end\nend\n',
    );
    await writeFile('auth/lib/auth/token.ex', 'defmodule Auth.Token do\nend\n');

    await writeFile(
      'api/mix.exs',
      'defmodule Api.MixProject do\n  use Mix.Project\n  def project do\n    [app: :api, version: "0.1.0"]\n  end\n  defp deps do\n    [{:auth, path: "../auth"}]\n  end\nend\n',
    );
    await writeFile(
      'api/lib/api/handler.ex',
      'defmodule Api.Handler do\n  def verify do\n    Auth.Token.verify()\n  end\nend\n',
    );

    const repos = { auth: 'auth', api: 'api' };
    const repoPaths = new Map([
      ['auth', path.join(tmpDir, 'auth')],
      ['api', path.join(tmpDir, 'api')],
    ]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('Auth.Token');
  });

  it('handles underscore app names (my_app -> MyApp)', async () => {
    await writeFile(
      'data-store/mix.exs',
      'defmodule DataStore.MixProject do\n  use Mix.Project\n  def project do\n    [app: :data_store, version: "0.1.0"]\n  end\nend\n',
    );
    await writeFile('data-store/lib/data_store/repo.ex', 'defmodule DataStore.Repo do\nend\n');

    await writeFile(
      'web/mix.exs',
      'defmodule Web.MixProject do\n  use Mix.Project\n  def project do\n    [app: :web, version: "0.1.0"]\n  end\n  defp deps do\n    [{:data_store, in_umbrella: true}]\n  end\nend\n',
    );
    await writeFile('web/lib/web/page.ex', 'defmodule Web.Page do\n  alias DataStore.Repo\nend\n');

    const repos = { store: 'data_store', web: 'web' };
    const repoPaths = new Map([
      ['store', path.join(tmpDir, 'data-store')],
      ['web', path.join(tmpDir, 'web')],
    ]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('DataStore.Repo');
  });

  it('skips repos without mix.exs', async () => {
    await writeFile('js-app/package.json', '{"name": "js-app"}');

    const repos = { app: 'js-app' };
    const repoPaths = new Map([['app', path.join(tmpDir, 'js-app')]]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(0);
    expect(result.discoveredApps.size).toBe(0);
  });

  it('deduplicates identical module refs from multiple files', async () => {
    await writeFile(
      'lib/mix.exs',
      'defmodule Lib.MixProject do\n  use Mix.Project\n  def project do\n    [app: :lib, version: "0.1.0"]\n  end\nend\n',
    );
    await writeFile('lib/lib/lib/config.ex', 'defmodule Lib.Config do\nend\n');

    await writeFile(
      'app/mix.exs',
      'defmodule App.MixProject do\n  use Mix.Project\n  def project do\n    [app: :app, version: "0.1.0"]\n  end\n  defp deps do\n    [{:lib, "~> 0.1"}]\n  end\nend\n',
    );
    await writeFile('app/lib/app/a.ex', 'defmodule App.A do\n  alias Lib.Config\nend\n');
    await writeFile('app/lib/app/b.ex', 'defmodule App.B do\n  alias Lib.Config\nend\n');

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
  });

  it('collapses nested submodules to top-level module contract', async () => {
    await writeFile(
      'core/mix.exs',
      'defmodule Core.MixProject do\n  use Mix.Project\n  def project do\n    [app: :core, version: "0.1.0"]\n  end\nend\n',
    );
    await writeFile('core/lib/core/auth/token.ex', 'defmodule Core.Auth.Token do\nend\n');
    await writeFile('core/lib/core/auth/session.ex', 'defmodule Core.Auth.Session do\nend\n');

    await writeFile(
      'web/mix.exs',
      'defmodule Web.MixProject do\n  use Mix.Project\n  def project do\n    [app: :web, version: "0.1.0"]\n  end\n  defp deps do\n    [{:core, in_umbrella: true}]\n  end\nend\n',
    );
    await writeFile(
      'web/lib/web/ctrl.ex',
      'defmodule Web.Ctrl do\n  alias Core.Auth.Token\n  alias Core.Auth.Session\nend\n',
    );

    const repos = { core: 'core', web: 'web' };
    const repoPaths = new Map([
      ['core', path.join(tmpDir, 'core')],
      ['web', path.join(tmpDir, 'web')],
    ]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('Core.Auth');
  });

  it('does not produce false positives from module references in comments', async () => {
    await writeFile(
      'auth/mix.exs',
      'defmodule Auth.MixProject do\n  use Mix.Project\n  def project do\n    [app: :auth, version: "0.1.0"]\n  end\nend\n',
    );
    await writeFile('auth/lib/auth/token.ex', 'defmodule Auth.Token do\nend\n');

    await writeFile(
      'api/mix.exs',
      'defmodule Api.MixProject do\n  use Mix.Project\n  def project do\n    [app: :api, version: "0.1.0"]\n  end\n  defp deps do\n    [{:auth, path: "../auth"}]\n  end\nend\n',
    );
    await writeFile(
      'api/lib/api/handler.ex',
      'defmodule Api.Handler do\n  # See Auth.Token for details\n  # Auth.Token.verify() is deprecated\n  def handle, do: :ok\nend\n',
    );

    const repos = { auth: 'auth', api: 'api' };
    const repoPaths = new Map([
      ['auth', path.join(tmpDir, 'auth')],
      ['api', path.join(tmpDir, 'api')],
    ]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(0);
  });

  it('handles git and path deps alongside umbrella deps', async () => {
    await writeFile(
      'utils/mix.exs',
      'defmodule Utils.MixProject do\n  use Mix.Project\n  def project do\n    [app: :utils, version: "0.1.0"]\n  end\nend\n',
    );
    await writeFile('utils/lib/utils/helper.ex', 'defmodule Utils.Helper do\nend\n');

    await writeFile(
      'svc/mix.exs',
      'defmodule Svc.MixProject do\n  use Mix.Project\n  def project do\n    [app: :svc, version: "0.1.0"]\n  end\n  defp deps do\n    [{:utils, git: "https://github.com/org/utils.git"}]\n  end\nend\n',
    );
    await writeFile(
      'svc/lib/svc/worker.ex',
      'defmodule Svc.Worker do\n  alias Utils.Helper\nend\n',
    );

    const repos = { utils: 'utils', svc: 'svc' };
    const repoPaths = new Map([
      ['utils', path.join(tmpDir, 'utils')],
      ['svc', path.join(tmpDir, 'svc')],
    ]);

    const result = await extractElixirWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('Utils.Helper');
  });
});
