import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

function writeFixture(root: string): void {
  const write = (file: string, source: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  write(
    'lib/my_app_web/router.ex',
    `
defmodule MyAppWeb.Router do
  use MyAppWeb, :router
  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
  end
  scope "/api", MyAppWeb do
    pipe_through :browser
    scope "/v1" do
      get "/posts", PostController, :index
      resources "/accounts", AccountController
      resources "/only-accounts", AccountController, only: :index
      resources "/except-accounts", AccountController, except: :show
      live "/dashboard", DashboardLive
      get dynamic_path(), PostController, :missing
    end
  end
  scope "/", MyAppWeb do
    get "/root", PostController, :index
  end
  scope alias: MyAppWeb do
    pipe_through [:browser, :api]
    get "/keyword", PostController, :index
  end
end
`,
  );
  write(
    'lib/my_app_web/controllers/post_controller.ex',
    `
defmodule MyAppWeb.PostController do
  use MyAppWeb, :controller
  def index(conn, _params), do: conn
end
`,
  );
  write(
    'lib/my_app_web/controllers/account_controller.ex',
    `
defmodule MyAppWeb.AccountController do
  use MyAppWeb, :controller
  def index(conn, _params), do: conn
  def show(conn, _params), do: conn
  def new(conn, _params), do: conn
  def create(conn, _params), do: conn
  def update(conn, _params), do: conn
  def delete(conn, _params), do: conn
end
`,
  );
  write(
    'lib/my_app_web/live/dashboard_live.ex',
    `
defmodule MyAppWeb.DashboardLive do
  use MyAppWeb, :live_view
  def mount(_params, _session, socket), do: {:ok, socket}
end
`,
  );
  write(
    'lib/my_app/blog/post.ex',
    `
defmodule MyApp.Blog.Post do
  use Ecto.Schema
  import Ecto.Query
  schema "posts" do
    field :title, :string
    belongs_to :author, MyApp.Accounts.Author
    has_many :comments, MyApp.Blog.Comment
    embeds_one :metadata, MyApp.Blog.Metadata
  end
  def runtime_field, do: field(:status)
end
defmodule MyApp.Blog.Metadata do
  use Ecto.Schema
  embedded_schema do
    field :slug, :string
  end
end
`,
  );
  write(
    'lib/my_app/blog/comment.ex',
    `
defmodule MyApp.Blog.Comment do
  use Ecto.Schema
  schema "comments" do
    field :body, :string
  end
end
defmodule MyApp.Accounts.Author do
  use Ecto.Schema
  schema "authors" do
    field :name, :string
  end
end
`,
  );
  write(
    'lib/my_app/repo.ex',
    `
defmodule MyApp.Repo do
  def all(_query), do: []
  def insert(_model), do: :ok
end
`,
  );
  write(
    'lib/my_app/blog.ex',
    `
defmodule MyApp.Blog do
  import Ecto.Query
  import MyApp.Helpers, only: [f: 1]
  alias MyApp.Repo
  alias MyApp.Blog.Post
  def list_posts do
    from p in MyApp.Blog.Post, where: p.title != ""
    |> Repo.all()
  end
  def create_post, do: Repo.insert(MyApp.Blog.Post)
  def only_call(value), do: f(value)
  import MyApp.Helpers
  import MyApp.Helpers, except: [public_macro: 0]
  def wildcard_public(value), do: public(value)
  def wildcard_private(value), do: private(value)
  def wildcard_private_macro, do: private_macro()
  def except_public(value), do: public(value)
  def except_private(value), do: private(value)
  def except_private_macro, do: private_macro()
  import MyApp.Behaviour
  def callback_call(value), do: required(value)
  def ignored, do: Repo.all(dynamic_schema())
end
`,
  );
  write(
    'lib/my_app/query_only.ex',
    `
defmodule MyApp.QueryOnly do
  import Ecto.Query
  def all, do: from p in MyApp.Blog.Post
end
`,
  );
  write(
    'lib/my_app/behaviour.ex',
    `
defmodule MyApp.Behaviour do
  @callback required(term()) :: term()
end
defmodule MyApp.Implementation do
  @behaviour MyApp.Behaviour
  def required(value), do: value
end
`,
  );
  write(
    'lib/my_app/behaviour_negatives.ex',
    `
defmodule MyApp.ArityBehaviour do
  @callback mismatch(left, right) :: term()
end
defmodule MyApp.DuplicateBehaviour do
  @callback ambiguous(value) :: term()
end
defmodule MyApp.DuplicateBehaviour do
  @callback ambiguous(value) :: term()
end
`,
  );
  write(
    'lib/my_app/behaviour_implementations.ex',
    `
defmodule MyApp.ArityImplementation do
  @behaviour MyApp.ArityBehaviour
  def mismatch(value), do: value
end
defmodule MyApp.AmbiguousImplementation do
  @behaviour MyApp.DuplicateBehaviour
  def ambiguous(value), do: value
end
`,
  );
  write(
    'lib/my_app/helpers.ex',
    `
defmodule MyApp.Helpers do
  def f(value), do: value
  def f(left, right), do: {left, right}
  def public(value), do: value
  defmacro public_macro, do: :ok
  defp private(value), do: value
  defmacrop private_macro, do: :ok
end
`,
  );
  write(
    'lib/my_app/captures.ex',
    `
defmodule MyApp.Captures do
  alias MyApp.Tasks
  def run(fun), do: fun.()
  def example_task, do: run(&Tasks.ExampleTask.run/0)
end
defmodule MyApp.Tasks.ExampleTask do
  def run, do: :ok
end
defmodule MyApp.UnaliasedCaptures do
  def run(fun), do: fun.()
  def example_task, do: run(&Tasks.ExampleTask.run/0)
end
defmodule MyApp.UnaliasedCaptures.Tasks.ExampleTask do
  def run, do: :wrong
end
defmodule MyApp.DifferentRootCaptures do
  alias Elsewhere.Tasks
  def run(fun), do: fun.()
  def example_task, do: run(&Tasks.ExampleTask.run/0)
end
defmodule Elsewhere.Tasks.ExampleTask do
  def run, do: :ok
end
defmodule MyApp.AmbiguousCaptures do
  alias MyApp.AmbiguousTasks
  def run(fun), do: fun.()
  def example_task, do: run(&AmbiguousTasks.ExampleTask.run/0)
end
defmodule MyApp.AmbiguousTasks.ExampleTask do
  def run, do: :one
end
defmodule MyApp.AmbiguousTasks.ExampleTask do
  def run, do: :two
end
defmodule MyApp.PrivateCaptures do
  alias MyApp.PrivateTasks
  def run(fun), do: fun.()
  def example_task, do: run(&PrivateTasks.ExampleTask.run/0)
end
defmodule MyApp.PrivateTasks.ExampleTask do
  defp run, do: :private
end
defmodule MyApp.ArityCaptures do
  alias MyApp.ArityTasks
  def run(fun), do: fun.()
  def example_task, do: run(&ArityTasks.ExampleTask.run/0)
end
defmodule MyApp.ArityTasks.ExampleTask do
  def run(value), do: value
end
defmodule MyApp.AliasOrdering do
  def run(fun), do: fun.()
  def before_alias, do: run(&Tasks.ExampleTask.run/0)
  alias MyApp.Tasks
  def first_alias, do: run(&Tasks.ExampleTask.run/0)
  alias Elsewhere.Tasks
  def rebound_alias, do: run(&Tasks.ExampleTask.run/0)
end
defmodule MyApp.AliasContainment do
  def run(fun), do: fun.()
  def sibling_alias do
    alias MyApp.Tasks
    :ok
  end
  def after_sibling, do: run(&Tasks.ExampleTask.run/0)
  def quoted_alias do
    quote do
      alias MyApp.Tasks
    end
  end
  def after_quote, do: run(&Tasks.ExampleTask.run/0)
  def quoted_capture do
    quote do
      alias MyApp.Tasks
      &Tasks.ExampleTask.run/0
    end
  end
  def after_block do
    if true do
      alias MyApp.Tasks
    end
    run(&Tasks.ExampleTask.run/0)
  end
end
`,
  );
  write(
    'lib/my_app/delegates.ex',
    `
defmodule MyApp.Delegates do
  defdelegate first(value), to: MyApp.DelegateTarget
  defdelegate second(value), to: MyApp.DelegateTarget, as: :different
end
defmodule MyApp.DelegateTarget do
  def first(value), do: value
  def different(value), do: value
end
`,
  );
}

function snapshot(result: PipelineResult) {
  const nodes: Array<{
    label: string;
    name: string;
    qualifiedName?: string;
    filePath?: string;
    startLine?: number;
    method?: string;
    middleware?: unknown;
  }> = [];
  result.graph.forEachNode((node) =>
    nodes.push({
      label: node.label,
      name: String(node.properties.name),
      qualifiedName: node.properties.qualifiedName as string | undefined,
      filePath: node.properties.filePath as string | undefined,
      startLine: node.properties.startLine as number | undefined,
      method: node.properties.method as string | undefined,
      middleware: node.properties.middleware,
    }),
  );
  const relationships: Array<{ type: string; source: string; target: string }> = [];
  result.graph.forEachRelationship((relationship) => {
    relationships.push({
      type: relationship.type,
      source: String(
        result.graph.getNode(relationship.sourceId)?.properties.qualifiedName ??
          result.graph.getNode(relationship.sourceId)?.properties.name,
      ),
      target: String(
        result.graph.getNode(relationship.targetId)?.properties.qualifiedName ??
          result.graph.getNode(relationship.targetId)?.properties.name,
      ),
    });
  });
  return {
    nodes: nodes.sort((a, b) =>
      `${a.label}:${a.qualifiedName ?? a.name}`.localeCompare(
        `${b.label}:${b.qualifiedName ?? b.name}`,
      ),
    ),
    relationships: relationships.sort((a, b) =>
      `${a.type}:${a.source}:${a.target}`.localeCompare(`${b.type}:${b.source}:${b.target}`),
    ),
  };
}

describe('Elixir Phoenix/Ecto pipeline', () => {
  it('emits literal Phoenix and Ecto facts through worker and warm-cache replay', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-elixir-framework-'));
    const storage = path.join(root, 'cache');
    try {
      writeFixture(root);
      const coldCache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storage,
        onDiskKeys: new Set(),
      };
      const cold = await runPipelineFromRepo(root, () => {}, {
        parseCache: coldCache,
        workerPoolSize: 1,
      });
      expect(cold.usedWorkerPool).toBe(true);

      pruneCache(coldCache, coldCache.usedKeys);
      const saved = await saveParseCache(storage, coldCache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        PARSE_CACHE_VERSION,
        new Set(saved),
      );
      const warm = await loadParseCache(storage);
      const replay = await runPipelineFromRepo(root, () => {}, {
        parseCache: warm ?? undefined,
        workerPoolSize: 1,
      });
      expect(replay.usedWorkerPool).toBe(false);
      expect(snapshot(replay)).toEqual(snapshot(cold));

      const routes = snapshot(cold).nodes.filter((node) => node.label === 'Route');
      expect(routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: '/api/v1/posts',
            filePath: 'lib/my_app_web/controllers/post_controller.ex',
            startLine: 10,
          }),
          expect.objectContaining({
            name: '/api/v1/dashboard',
            filePath: 'lib/my_app_web/live/dashboard_live.ex',
            startLine: expect.any(Number),
          }),
          expect.objectContaining({
            name: '/api/v1/accounts/:id',
            filePath: 'lib/my_app_web/controllers/account_controller.ex',
            startLine: expect.any(Number),
          }),
          expect.objectContaining({
            name: '/root',
            filePath: 'lib/my_app_web/controllers/post_controller.ex',
            startLine: expect.any(Number),
          }),
          expect.objectContaining({
            name: '/keyword',
            filePath: 'lib/my_app_web/controllers/post_controller.ex',
            startLine: expect.any(Number),
            middleware: ['browser', 'api'],
          }),
        ]),
      );
      expect(routes).toContainEqual(
        expect.objectContaining({ name: '/api/v1/only-accounts', method: 'GET' }),
      );
      expect(routes.map((route) => route.name)).not.toContain('/api/v1/only-accounts/:id');
      expect(routes).toContainEqual(
        expect.objectContaining({ name: '/api/v1/except-accounts/:id', method: 'PATCH' }),
      );
      expect(routes).not.toContainEqual(
        expect.objectContaining({ name: '/api/v1/except-accounts/:id', method: 'GET' }),
      );
      expect(routes.map((route) => route.name)).not.toContain('//root');
      expect(routes.map((route) => route.name)).not.toContain('dynamic_path');

      const graph = snapshot(cold);
      expect(graph.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'HANDLES_ROUTE',
            source: 'MyAppWeb.PostController.index',
            target: '/api/v1/posts',
          }),
          expect.objectContaining({
            type: 'HANDLES_ROUTE',
            source: 'MyAppWeb.DashboardLive',
            target: '/api/v1/dashboard',
          }),
          expect.objectContaining({
            type: 'HAS_PROPERTY',
            source: 'MyApp.Blog.Post',
            target: 'MyApp.Blog.Post.title',
          }),
          expect.objectContaining({
            type: 'USES',
            source: 'MyApp.Blog.Post',
            target: 'MyApp.Blog.Comment',
          }),
          expect.objectContaining({
            type: 'QUERIES',
            source: 'blog.ex',
            target: 'MyApp.Blog.Post',
          }),
          expect.objectContaining({
            type: 'QUERIES',
            source: 'query_only.ex',
            target: 'MyApp.Blog.Post',
          }),
          expect.objectContaining({
            type: 'CALLS',
            source: 'MyApp.Blog.only_call',
            target: 'MyApp.Helpers.f',
          }),
          expect.objectContaining({
            type: 'CALLS',
            source: 'MyApp.Blog.wildcard_public',
            target: 'MyApp.Helpers.public',
          }),
          expect.objectContaining({
            type: 'CALLS',
            source: 'MyApp.Blog.except_public',
            target: 'MyApp.Helpers.public',
          }),
          expect.objectContaining({
            type: 'CALLS',
            source: 'MyApp.Captures.example_task',
            target: 'MyApp.Tasks.ExampleTask.run',
          }),
          expect.objectContaining({
            type: 'CALLS',
            source: 'MyApp.Delegates.first',
            target: 'MyApp.DelegateTarget.first',
          }),
          expect.objectContaining({
            type: 'CALLS',
            source: 'MyApp.Delegates.second',
            target: 'MyApp.DelegateTarget.different',
          }),
        ]),
      );
      expect(
        graph.relationships.filter(
          (edge) => edge.type === 'CALLS' && edge.source === 'MyApp.Delegates.first',
        ),
      ).toEqual([expect.objectContaining({ target: 'MyApp.DelegateTarget.first' })]);
      const properties = graph.nodes.filter((node) => node.label === 'Property');
      expect(properties).toContainEqual(
        expect.objectContaining({ qualifiedName: 'MyApp.Blog.Post.title' }),
      );
      expect(properties).not.toContainEqual(
        expect.objectContaining({ qualifiedName: 'MyApp.Blog.Post.status' }),
      );
      const callTargets = (source: string) =>
        graph.relationships
          .filter((edge) => edge.type === 'CALLS' && edge.source === source)
          .map((edge) => edge.target);
      expect(callTargets('MyApp.UnaliasedCaptures.example_task')).not.toContain(
        'MyApp.UnaliasedCaptures.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.DifferentRootCaptures.example_task')).toContain(
        'Elsewhere.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.DifferentRootCaptures.example_task')).not.toContain(
        'MyApp.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AmbiguousCaptures.example_task')).not.toContain(
        'MyApp.AmbiguousTasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.PrivateCaptures.example_task')).not.toContain(
        'MyApp.PrivateTasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.ArityCaptures.example_task')).not.toContain(
        'MyApp.ArityTasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AliasOrdering.before_alias')).not.toContain(
        'MyApp.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AliasOrdering.before_alias')).not.toContain(
        'Elsewhere.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AliasOrdering.first_alias')).toContain(
        'MyApp.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AliasOrdering.rebound_alias')).toContain(
        'Elsewhere.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AliasContainment.after_sibling')).not.toContain(
        'MyApp.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AliasContainment.after_quote')).not.toContain(
        'MyApp.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AliasContainment.quoted_capture')).not.toContain(
        'MyApp.Tasks.ExampleTask.run',
      );
      expect(callTargets('MyApp.AliasContainment.after_block')).not.toContain(
        'MyApp.Tasks.ExampleTask.run',
      );
      for (const [source, target] of [
        ['MyApp.Blog.wildcard_private', 'MyApp.Helpers.private'],
        ['MyApp.Blog.wildcard_private_macro', 'MyApp.Helpers.private_macro'],
        ['MyApp.Blog.except_private', 'MyApp.Helpers.private'],
        ['MyApp.Blog.except_private_macro', 'MyApp.Helpers.private_macro'],
        ['MyApp.Blog.callback_call', 'MyApp.Behaviour.required'],
        ['MyApp.Behaviour.required', 'MyApp.Behaviour.required'],
      ])
        expect(graph.relationships).not.toContainEqual(
          expect.objectContaining({ type: 'CALLS', source, target }),
        );
      expect(graph.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'METHOD_IMPLEMENTS',
            source: 'MyApp.Implementation.required',
            target: 'MyApp.Behaviour.required',
          }),
        ]),
      );
      for (const source of [
        'MyApp.ArityImplementation.mismatch',
        'MyApp.AmbiguousImplementation.ambiguous',
      ])
        expect(graph.relationships).not.toContainEqual(
          expect.objectContaining({ type: 'METHOD_IMPLEMENTS', source }),
        );
      expect(
        graph.nodes.filter(
          (node) => node.label === 'Class' && node.qualifiedName === 'MyApp.Blog.Post',
        ),
      ).toHaveLength(1);
      expect(
        graph.nodes.filter(
          (node) => node.label === 'Class' && node.qualifiedName === 'MyApp.Blog.Metadata',
        ),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
