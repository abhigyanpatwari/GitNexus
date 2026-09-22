import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';
import { extractElixirSemanticGraph } from '../../src/core/ingestion/languages/elixir/semantic-graph.js';

describe('Elixir semantic graph', () => {
  it('coalesces same-arity clauses but preserves arity and macro identity', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'clauses.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const graph = extractElixirSemanticGraph(
      parser.parse(`
      defmodule M do
        def f(:one), do: one()
        def f(:two), do: two()
        def f(a, b), do: pair(a, b)
        defmacro f(x), do: x
      end
    `),
      'lib/nonconventional.ex',
    );
    const callables = graph.nodes.filter(
      (node) => node.label === 'Function' || node.label === 'Macro',
    );
    expect(callables).toHaveLength(3);
    expect(
      callables.filter(
        (node) => node.properties.qualifiedName === 'M.f' && node.label === 'Function',
      ),
    ).toHaveLength(2);
    expect(callables.find((node) => node.label === 'Macro')?.properties.parameterCount).toBe(1);
  });

  it('preserves private visibility and does not materialize quoted declarations', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'quoted.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const graph = extractElixirSemanticGraph(
      parser.parse(`
      defmodule M do
        defp hidden(value), do: value
        quote do
          def generated(value), do: value
          defmodule Generated do
            def run, do: :ok
          end
        end
      end
    `),
      'anything.ex',
    );
    const hidden = graph.nodes.find((node) => node.properties.qualifiedName === 'M.hidden');
    expect(hidden?.properties).toMatchObject({ visibility: 'private', isExported: false });
    for (const name of ['M.generated', 'Generated', 'Generated.run'])
      expect(graph.nodes.map((node) => node.properties.qualifiedName)).not.toContain(name);
  });

  it('does not classify a module as an interface from a quoted callback', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'quoted-callback.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const graph = extractElixirSemanticGraph(
      parser.parse(`defmodule M do
        quote do
          @callback run(term()) :: term()
        end
      end`),
      'lib/quoted_callback.ex',
    );
    expect(graph.nodes.find((node) => node.properties.qualifiedName === 'M')?.label).toBe('Class');
  });

  it('emits canonical zero-arity ordinary and guarded declarations', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'zero-arity.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const graph = extractElixirSemanticGraph(
      parser.parse(`
      defmodule Zero do
        def run, do: :ok
        def guarded when true, do: :ok
        defmacro build, do: :ok
      end
    `),
      'lib/zero.ex',
    );
    expect(
      graph.nodes
        .filter((node) => node.label === 'Function' || node.label === 'Macro')
        .map((node) => node.properties),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualifiedName: 'Zero.run',
          parameterCount: 0,
          requiredParameterCount: 0,
          startLine: 2,
        }),
        expect.objectContaining({
          qualifiedName: 'Zero.guarded',
          parameterCount: 0,
          requiredParameterCount: 0,
        }),
        expect.objectContaining({
          qualifiedName: 'Zero.build',
          parameterCount: 0,
          requiredParameterCount: 0,
        }),
      ]),
    );
    expect(graph.relationships).toContainEqual(
      expect.objectContaining({ type: 'HAS_METHOD', reason: 'elixir module function' }),
    );
  });

  it('keeps repeated modules as separate ambiguous candidates without qualified call edges', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'repeated.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const first = extractElixirSemanticGraph(
      parser.parse('defmodule M do\n def f, do: :one\nend\ndefmodule M do\n def f, do: :two\nend'),
      'lib/same.ex',
    );
    const second = extractElixirSemanticGraph(
      parser.parse('defmodule M do\n def f, do: :other\nend'),
      'lib/other.ex',
    );
    expect(first.nodes.filter((node) => node.properties.qualifiedName === 'M.f')).toHaveLength(2);
    expect(
      new Set(
        [...first.nodes, ...second.nodes]
          .filter((node) => node.properties.qualifiedName === 'M.f')
          .map((node) => node.id),
      ).size,
    ).toBe(3);
    expect(
      [...first.relationships, ...second.relationships].filter(
        (relationship) => relationship.type === 'CALLS',
      ),
    ).toHaveLength(0);
  });

  it('models static behaviour callbacks as an interface contract', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'behaviour.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const graph = extractElixirSemanticGraph(
      parser.parse(`
      defmodule WorkerBehaviour do
        @callback run(term()) :: term()
      end
    `),
      'lib/worker_behaviour.ex',
    );
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Interface',
          properties: expect.objectContaining({ qualifiedName: 'WorkerBehaviour' }),
        }),
        expect.objectContaining({
          label: 'Function',
          properties: expect.objectContaining({
            qualifiedName: 'WorkerBehaviour.run',
            parameterCount: 1,
          }),
        }),
      ]),
    );
    const contract = graph.nodes.find(
      (node) => node.properties.qualifiedName === 'WorkerBehaviour',
    )!;
    expect(
      graph.symbols.find((symbol) => symbol.qualifiedName === 'WorkerBehaviour.run'),
    ).toMatchObject({
      ownerId: contract.id,
    });
  });

  it('records literal Mix metadata without evaluating the project file', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'mix.exs');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const graph = extractElixirSemanticGraph(
      parser.parse(`
      defmodule Demo.MixProject do
        def project, do: [app: :demo, apps_path: "apps", deps: deps()]
        def application, do: [applications: [:kernel], extra_applications: [:logger]]
        defp deps, do: [{:sibling, path: "../sibling"}, {:umbrella, in_umbrella: true}, dynamic()]
      end
    `),
      'mix.exs',
    );
    const metadata = graph.nodes.filter((node) => node.label === 'CodeElement');
    expect(metadata.map((node) => node.properties)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ elixirKind: 'mix-app', app: 'demo' }),
        expect.objectContaining({ elixirKind: 'mix-umbrella', appsPath: 'apps' }),
        expect.objectContaining({ elixirKind: 'mix-application', app: 'kernel' }),
        expect.objectContaining({ elixirKind: 'mix-application', app: 'logger' }),
        expect.objectContaining({
          elixirKind: 'mix-dependency',
          app: 'sibling',
          path: '../sibling',
        }),
        expect.objectContaining({
          elixirKind: 'mix-dependency',
          app: 'umbrella',
          inUmbrella: true,
        }),
      ]),
    );
    expect(metadata.map((node) => node.properties.app)).not.toContain('dynamic');
    expect(
      metadata.find((node) => node.properties.elixirKind === 'mix-app')?.properties.startLine,
    ).toBe(2);
  });

  it('adds static OTP dependency evidence while retaining normal call extraction', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'otp.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const graph = extractElixirSemanticGraph(
      parser.parse(`
      defmodule Worker do end
      defmodule Other do end
      defmodule App do
        def start, do: Supervisor.start_link([Worker, {Other, []}, dynamic_child()], strategy: :one_for_one)
        def boot, do: GenServer.start_link(Worker, [], name: Worker)
        def request, do: GenServer.call({:local, Worker}, :work)
        def notify, do: GenServer.cast(server_name(), :work)
      end
    `),
      'lib/app.ex',
    );
    const evidence = graph.nodes
      .filter((node) => node.label === 'CodeElement')
      .map((node) => node.properties);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ elixirKind: 'supervisor-child', target: 'Worker' }),
        expect.objectContaining({ elixirKind: 'supervisor-child', target: 'Other' }),
        expect.objectContaining({ elixirKind: 'genserver-start_link', target: 'Worker' }),
        expect.objectContaining({ elixirKind: 'genserver-call', target: 'Worker' }),
      ]),
    );
    expect(evidence).not.toContainEqual(
      expect.objectContaining({ elixirKind: 'supervisor-child', target: 'dynamic_child' }),
    );
    expect(evidence).not.toContainEqual(expect.objectContaining({ elixirKind: 'genserver-cast' }));
    expect(graph.relationships.filter((edge) => edge.type === 'DECLARES')).toHaveLength(4);
  });
});
