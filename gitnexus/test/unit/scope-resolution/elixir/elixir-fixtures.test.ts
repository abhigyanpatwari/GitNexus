import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { elixirProvider } from '../../../../src/core/ingestion/languages/elixir.js';
import {
  getLanguageGrammar,
  loadLanguage,
} from '../../../../src/core/tree-sitter/parser-loader.js';

describe('Elixir scope captures', () => {
  it('keeps clause callsites and arities while semantic declarations coalesce separately', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'lib/nonconventional_name.ex');
    const parsed = extractParsedFile(
      elixirProvider,
      `
      defmodule M do
        def f(:one), do: target(:one)
        def f(:two), do: target(:two)
        def target(value), do: value
      end
    `,
      'lib/nonconventional_name.ex',
    );
    expect(parsed).toBeDefined();
    const targetCalls = parsed?.referenceSites.filter((site) => site.name === 'target') ?? [];
    expect(targetCalls.map((site) => site.atRange.startLine)).toEqual([3, 4]);
    expect(targetCalls.map((site) => site.arity)).toEqual([1, 1]);
  });

  it('captures aliases, constrained imports, pipelines, captures, delegates, and macro identity', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'lib/nonconventional_name.ex');
    const parsed = extractParsedFile(
      elixirProvider,
      `
      defmodule Actual.Name do
        alias External.Service, as: Service
        alias Actual.Name.Nested
        alias Prefix.{One, Two}
        import Helpers, only: [allowed: 1]
        import Filtered, except: [hidden: 1]
        require Required
        use Dynamic
        def run(value), do: value |> allowed() |> Service.call(:flag)
        def captured, do: &local/1
        def qualified_capture, do: &Remote.call/1
        defdelegate forwarded(value), to: Remote, as: :call
        defmacro same(value), do: value
        def same(value), do: value
      end
    `,
      'lib/filename_does_not_define_the_module.ex',
    );
    expect(
      parsed?.localDefs
        .filter((def) => def.qualifiedName === 'Actual.Name.same')
        .map((def) => def.type),
    ).toEqual(expect.arrayContaining(['Function', 'Macro']));
    expect(parsed?.parsedImports.some((imp) => imp.targetRaw === 'Filtered')).toBe(false);
    expect(parsed?.parsedImports.some((imp) => imp.targetRaw === 'Helpers')).toBe(false);
    expect(
      elixirProvider.collectCaptureSideChannel?.('lib/filename_does_not_define_the_module.ex'),
    ).toMatchObject({
      kind: 'elixir',
      importExcepts: [
        expect.objectContaining({ target: 'Filtered', excluded: [{ name: 'hidden', arity: 1 }] }),
      ],
    });
    const calls = parsed?.referenceSites ?? [];
    expect(calls.filter((site) => site.name === 'allowed').map((site) => site.arity)).toEqual([1]);
    expect(
      calls.find((site) => site.name === 'call' && site.explicitReceiver?.name === 'Service'),
    ).toMatchObject({ arity: 2 });
    expect(calls.find((site) => site.name === 'local')).toMatchObject({
      arity: 1,
      callForm: 'free',
    });
    expect(
      calls
        .filter((site) => site.name === 'call' && site.explicitReceiver?.name === 'Remote')
        .map((site) => site.arity),
    ).toEqual([1, 1]);
    expect(calls.find((site) => site.name === 'forwarded')).toBeUndefined();
    const bindings = Object.fromEntries(
      parsed?.scopes.flatMap((scope) =>
        [...scope.typeBindings].map(([name, ref]) => [name, ref.rawName]),
      ) ?? [],
    );
    expect(bindings).toMatchObject({
      Service: 'External.Service',
      Nested: 'Actual.Name.Nested',
      One: 'Prefix.One',
      Two: 'Prefix.Two',
    });
  });

  it('records a `from p in Schema` query fact without relying on Repo calls', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'from-query.ex');
    extractParsedFile(
      elixirProvider,
      'defmodule Queries do\n  def all, do: from p in MyApp.Post\nend',
      'lib/from_query.ex',
    );
    expect(elixirProvider.collectCaptureSideChannel?.('lib/from_query.ex')).toMatchObject({
      kind: 'elixir',
      frameworkFacts: [
        expect.objectContaining({ kind: 'query', method: 'from', model: 'MyApp.Post' }),
      ],
    });
  });

  it('keeps literal atom resource filters while ignoring dynamic filters', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'routes.ex');
    extractParsedFile(
      elixirProvider,
      `defmodule Router do
  resources "/only", Controller, only: :index
  resources "/except", Controller, except: :show
  resources "/only-list", Controller, only: [:index, :show]
  resources "/except-list", Controller, except: [:show, :delete]
  resources "/dynamic", Controller, only: allowed_actions()
end`,
      'routes.ex',
    );
    const routes =
      elixirProvider
        .collectCaptureSideChannel?.('routes.ex')
        ?.frameworkFacts?.filter((fact) => fact.kind === 'route') ?? [];
    expect(routes.filter((fact) => fact.path === '/only')).toHaveLength(1);
    expect(routes.some((fact) => fact.path === '/only/:id')).toBe(false);
    expect(routes.some((fact) => fact.path === '/except/:id' && fact.action === 'show')).toBe(
      false,
    );
    expect(routes.filter((fact) => fact.path.startsWith('/only-list'))).toHaveLength(2);
    expect(routes.some((fact) => fact.path === '/only-list/new')).toBe(false);
    expect(routes.some((fact) => fact.path === '/except-list/:id' && fact.action === 'show')).toBe(
      false,
    );
    expect(
      routes.some((fact) => fact.path.startsWith('/except-list') && fact.action === 'delete'),
    ).toBe(false);
    expect(routes.filter((fact) => fact.path.startsWith('/dynamic'))).toHaveLength(8);
  });

  it('has identical cold and cached-tree ParsedFile output', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'cached.ex');
    const source =
      'defmodule Cached do\n import Filtered, except: [hidden: 1]\n import Helpers, only: [allowed: 1]\n alias Remote.Service, as: Service\n def run(v), do: v |> Service.call()\n end';
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    expect(
      extractParsedFile(elixirProvider, source, 'cached.ex', undefined, parser.parse(source)),
    ).toEqual(extractParsedFile(elixirProvider, source, 'cached.ex'));
  });

  it('treats category-only imports as wildcard imports, not empty allowlists', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'category-import.ex');
    const parsed = extractParsedFile(
      elixirProvider,
      'defmodule M do\n  import Helpers, only: :functions\n  import Macros, only: :macros\nend',
      'category-import.ex',
    );
    expect(parsed?.parsedImports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'wildcard', targetRaw: 'Helpers' }),
        expect.objectContaining({ kind: 'wildcard', targetRaw: 'Macros' }),
      ]),
    );
    expect(elixirProvider.collectCaptureSideChannel?.('category-import.ex')).toMatchObject({
      kind: 'elixir',
      importOnly: [
        expect.objectContaining({ target: 'Helpers', category: 'functions' }),
        expect.objectContaining({ target: 'Macros', category: 'macros' }),
      ],
    });
  });

  it('does not turn category-import text outside import AST nodes into facts or bindings', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'category-import-literals.ex');
    const parsed = extractParsedFile(
      elixirProvider,
      `defmodule M do
        # import Commented, only: :functions
        text = "import Stringified, only: :macros"
        heredoc = """
        import Heredoc, only: :functions
        """
        quote do
          import Quoted, only: :macros
        end
      end`,
      'category-import-literals.ex',
    );
    expect(parsed?.parsedImports).toEqual([]);
    expect(
      elixirProvider.collectCaptureSideChannel?.('category-import-literals.ex'),
    ).toBeUndefined();
    const bindings = parsed?.scopes.flatMap((scope) => [...scope.typeBindings.keys()]) ?? [];
    for (const forbidden of ['Commented', 'Stringified', 'Heredoc', 'Quoted'])
      expect(bindings).not.toContain(forbidden);
  });

  it('extracts defmodule aliases as method owners and ordinary parameters', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'method-owner.ex');
    const source = 'defmodule App.Worker do\n  def run(value), do: value\nend';
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const extracted = elixirProvider.methodExtractor!.extract(
      parser.parse(source).rootNode.namedChild(0)!,
      {
        filePath: 'method-owner.ex',
        language: SupportedLanguages.Elixir,
      },
    );
    expect(extracted).toMatchObject({
      ownerName: 'App.Worker',
      methods: [
        expect.objectContaining({
          name: 'run',
          parameters: [expect.objectContaining({ name: 'value' })],
        }),
      ],
    });
  });

  it('captures behaviours and protocol implementations as heritage facts without lifecycle calls', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'otp.ex');
    const parsed = extractParsedFile(
      elixirProvider,
      `
      defmodule Worker do
        @behaviour Runner
        use GenServer
        def init(state), do: {:ok, state}
      end
      defimpl Printable, for: User do
        def print(user), do: user
      end
    `,
      'lib/otp.ex',
    );
    const heritage = parsed?.referenceSites.filter((site) => site.kind === 'inherits') ?? [];
    expect(heritage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Runner' }),
        expect.objectContaining({
          name: 'Printable',
          explicitReceiver: expect.objectContaining({ name: 'User' }),
        }),
      ]),
    );
    expect(parsed?.referenceSites.find((site) => site.name === 'init')).toBeUndefined();
  });

  it('classifies callback modules as interfaces and ignores quoted callbacks', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'behaviour.ex');
    const parsed = extractParsedFile(
      elixirProvider,
      `defmodule Runner do
  @callback run(term()) :: term()
end
defmodule Quoted do
  quote do
    @callback ignored(term()) :: term()
  end
end`,
      'behaviour.ex',
    );
    expect(parsed?.localDefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ qualifiedName: 'Runner', type: 'Interface' }),
      ]),
    );
    expect(parsed?.localDefs).toEqual(
      expect.arrayContaining([expect.objectContaining({ qualifiedName: 'Quoted', type: 'Class' })]),
    );
  });
});
