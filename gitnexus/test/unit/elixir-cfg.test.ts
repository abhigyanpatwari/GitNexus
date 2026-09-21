import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { loadLanguage, getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';
import { createElixirCfgVisitor } from '../../src/core/ingestion/cfg/visitors/elixir.js';
import { collectFunctionCfgs } from '../../src/core/ingestion/cfg/collect.js';
import { computeReachingDefs } from '../../src/core/ingestion/cfg/reaching-defs.js';
import { ELIXIR_TAINT_MODEL } from '../../src/core/ingestion/taint/elixir-model.js';
import { buildTaintImportIndex, matchFunctionSites } from '../../src/core/ingestion/taint/match.js';
import { computeTaintFlows } from '../../src/core/ingestion/taint/propagate.js';

describe('Elixir CFG visitor', () => {
  it('keeps clauses separate and emits local branch edges', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'cfg.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const defs = parser.parse(
      'def f(0), do: :zero\ndef f(x) when x > 0 do\n  case x do\n    y -> y\n  end\nend',
    ).rootNode.namedChildren;
    const visitor = createElixirCfgVisitor();
    const cfg = visitor.buildFunctionCfg(defs[1]!, 'cfg.ex');
    expect(cfg).toBeDefined();
    expect(cfg!.edges.some((edge) => edge.kind === 'cond-true')).toBe(true);
    expect(cfg!.edges.some((edge) => edge.kind === 'cond-false')).toBe(true);
  });

  it('records match bindings and later reads', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'facts.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const def = parser.parse('def f(value) do\n  result = value\n  Code.eval_string(result)\nend')
      .rootNode.namedChildren[0]!;
    const cfg = createElixirCfgVisitor().buildFunctionCfg(def, 'facts.ex')!;
    const assignment = cfg.blocks.find((block) => block.text.includes('result = value'))!;
    const call = cfg.blocks.find((block) => block.text.includes('Code.eval_string'))!;
    expect(assignment.statements![0]!.defs).toHaveLength(1);
    expect(assignment.statements![0]!.uses).toHaveLength(1);
    expect(call.statements![0]!.uses).not.toHaveLength(0);
    expect(call.statements![0]!.sites).toContainEqual(
      expect.objectContaining({ callee: 'Code.eval_string' }),
    );
  });

  it('treats pinned patterns as reads and keeps header facts outside branch bodies', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'pin-header.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const root = parser.parse(`def f(user_id, pair, flag) do
      {^user_id, id} = pair
      if flag do body_only(id) end
    end`).rootNode;
    const cfg = createElixirCfgVisitor().buildFunctionCfg(root.namedChildren[0]!, 'pin-header.ex')!;
    const match = cfg.blocks.find((block) => block.text.includes('{^user_id, id}'))!
      .statements![0]!;
    expect(cfg.bindings[match.uses[0]!]!.name).toBe('user_id');
    expect(cfg.bindings[match.defs[0]!]!.name).toBe('id');
    const header = cfg.blocks.find((block) => block.text.startsWith('if flag'))!.statements![0]!;
    expect(header.uses.map((index) => cfg.bindings[index]!.name)).toEqual(['flag']);
  });

  it('propagates Phoenix parameters to dynamic-eval and raw-SQL text only', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'taint.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const root = parser.parse(`def f(conn, params) do
      code = conn.params["code"]
      sql = params["sql"]
      Code.eval_string(code)
      Repo.query!(sql, [code])
      Repo.query!("select * from posts where id = ?", [sql])
    end`).rootNode;
    const cfg = createElixirCfgVisitor().buildFunctionCfg(root.namedChildren[0]!, 'taint.ex')!;
    const matches = matchFunctionSites(cfg, ELIXIR_TAINT_MODEL, buildTaintImportIndex([]));
    const result = computeTaintFlows(cfg, computeReachingDefs(cfg), matches);
    expect(
      result.findings.map((finding) => [finding.sink.entryName, finding.sinkKind]).sort(),
    ).toEqual([
      ['eval_string', 'code-injection'],
      ['query!', 'sql-injection'],
    ]);
  });

  it('records nested parent sites and taints direct and piped parameter reads', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'nested-sites.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const root = parser.parse(`def f(params) do
      Code.eval_string(wrapper(params["code"]))
      Code.eval_string(params["code"])
      params["code"] |> Code.eval_string
    end`).rootNode;
    const cfg = createElixirCfgVisitor().buildFunctionCfg(
      root.namedChildren[0]!,
      'nested-sites.ex',
    )!;
    const nested = cfg.blocks.find((block) => block.text.includes('wrapper(params'))!
      .statements![0]!.sites!;
    const wrapper = nested.findIndex((site) => site.kind === 'call' && site.callee === 'wrapper');
    const read = nested.findIndex((site) => site.kind === 'member-read');
    const evalSite = nested.findIndex(
      (site) => site.kind === 'call' && site.callee === 'Code.eval_string',
    );
    expect(wrapper).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThanOrEqual(0);
    expect(nested[wrapper]!.parent).toEqual([evalSite, 0]);
    expect(nested[read]!.parent).toEqual([wrapper, 0]);
    const findings = computeTaintFlows(
      cfg,
      computeReachingDefs(cfg),
      matchFunctionSites(cfg, ELIXIR_TAINT_MODEL, buildTaintImportIndex([])),
    ).findings.filter((finding) => finding.sink.entryName === 'eval_string');
    expect(findings).toHaveLength(2);
  });

  it('uses source-range parents for repeated callees and shifted pipe arguments', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'parent-ranges.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const root = parser.parse(`def f(params, input, code) do
      wrapper(wrapper(params["x"]))
      input |> sink(wrapper(code))
      (input |> foo()) + sink()
    end`).rootNode;
    const cfg = createElixirCfgVisitor().buildFunctionCfg(
      root.namedChildren[0]!,
      'parent-ranges.ex',
    )!;
    const repeated = cfg.blocks.find((block) => block.text.includes('wrapper(wrapper'))!
      .statements![0]!.sites!;
    const wrappers = repeated
      .map((site, index) => ({ site, index }))
      .filter(({ site }) => site.kind === 'call' && site.callee === 'wrapper');
    const read = repeated.find((site) => site.kind === 'member-read')!;
    expect(read.parent).toEqual([wrappers[1]!.index, 0]);
    const piped = cfg.blocks.find((block) => block.text.includes('sink(wrapper'))!.statements![0]!
      .sites!;
    const sink = piped.findIndex((site) => site.kind === 'call' && site.callee === 'sink');
    const inner = piped.find((site) => site.kind === 'call' && site.callee === 'wrapper')!;
    expect(inner.parent).toEqual([sink, 1]);
    const addition = cfg.blocks.find((block) => block.text.includes('foo()) + sink'))!
      .statements![0]!.sites!;
    const foo = addition.find((site) => site.kind === 'call' && site.callee === 'foo')!;
    const standaloneSink = addition.find((site) => site.kind === 'call' && site.callee === 'sink')!;
    expect(foo.parent).toBeUndefined();
    expect(standaloneSink.parent).toBeUndefined();
    expect(standaloneSink.args).toBeUndefined();
  });

  it('uses Ecto adapter SQL argument one while preserving Repo SQL argument zero', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'adapter-taint.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const root = parser.parse(`def f(params) do
      sql = params["sql"]
      Ecto.Adapters.SQL.query!(Repo, sql, [])
      Ecto.Adapters.SQL.query!(Repo, "safe", [sql])
      Repo.query!(sql)
    end`).rootNode;
    const cfg = createElixirCfgVisitor().buildFunctionCfg(
      root.namedChildren[0]!,
      'adapter-taint.ex',
    )!;
    const result = computeTaintFlows(
      cfg,
      computeReachingDefs(cfg),
      matchFunctionSites(cfg, ELIXIR_TAINT_MODEL, buildTaintImportIndex([])),
    );
    expect(result.findings.filter((finding) => finding.sinkKind === 'sql-injection')).toHaveLength(
      2,
    );
  });

  it('keeps every anonymous-function clause and matches bare Kernel.apply', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'closure-taint.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const root = parser.parse(`def f(params) do
      code = params["code"]
      fn :eval -> code = params["code"]; apply(code, [], []); value -> Code.eval_string(code) end
    end`).rootNode;
    const cfg = collectFunctionCfgs(root, createElixirCfgVisitor(), 'closure-taint.ex').cfgs.find(
      (candidate) => candidate.blocks.some((block) => block.text.includes('apply(code')),
    )!;
    const findings = computeTaintFlows(
      cfg,
      computeReachingDefs(cfg),
      matchFunctionSites(cfg, ELIXIR_TAINT_MODEL, buildTaintImportIndex([])),
    ).findings;
    expect(cfg.blocks.some((block) => block.text.includes('Code.eval_string'))).toBe(true);
    expect(findings.map((finding) => finding.sink.entryName)).toEqual(['apply']);
  });

  it('does not flow taint sequentially between anonymous-function clauses', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'closure-branches.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const root = parser.parse(`def f(params) do
      fn :source -> code = params["code"]; :ok
         :sink -> Code.eval_string(code)
      end
    end`).rootNode;
    const cfg = collectFunctionCfgs(
      root,
      createElixirCfgVisitor(),
      'closure-branches.ex',
    ).cfgs.find((candidate) =>
      candidate.blocks.some((block) => block.text.includes('Code.eval_string')),
    )!;
    const findings = computeTaintFlows(
      cfg,
      computeReachingDefs(cfg),
      matchFunctionSites(cfg, ELIXIR_TAINT_MODEL, buildTaintImportIndex([])),
    ).findings;
    expect(findings.map((finding) => finding.sink.entryName)).not.toContain('eval_string');
  });

  it('binds guarded default formals by pattern with zero-based indexes only', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'guarded-defaults.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const def = parser.parse(
      'def f(value \\\\ @fallback, other) when is_binary(value) do\n  value <> other\nend',
    ).rootNode.namedChildren[0]!;
    const cfg = createElixirCfgVisitor().buildFunctionCfg(def, 'guarded-defaults.ex')!;
    expect(cfg.bindings.filter((binding) => binding.kind === 'param')).toEqual([
      expect.objectContaining({ name: 'value', formalIndex: 0 }),
      expect.objectContaining({ name: 'other', formalIndex: 1 }),
    ]);
    expect(
      cfg.bindings.filter((binding) => binding.kind === 'param').map((binding) => binding.name),
    ).not.toContain('fallback');
  });

  it('models the structured grammar forms as local control flow', async () => {
    await loadLanguage(SupportedLanguages.Elixir, 'shapes.ex');
    const parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Elixir) as Parameters<Parser['setLanguage']>[0],
    );
    const source = `
def shape(0), do: :zero
def shape(x) when x > 0 do
  if x > 1 do :yes else :no end
  unless x < 9 do :large else :small end
  case x do y when y > 2 -> y; _ -> :other end
  cond do x > 3 -> :big; true -> :small end
  with {:ok, value} <- fetch(x), true <- valid(value) do value else _ -> :bad end
  for value <- values, value > 0, do: value * 2
  try do work(x) rescue error -> error catch _, reason -> reason after cleanup() end
  receive do message -> message after 1000 -> :timeout end
  fn value -> x && value || fallback() end
end`;
    const root = parser.parse(source).rootNode;
    const cfgs = collectFunctionCfgs(root, createElixirCfgVisitor(), 'shapes.ex').cfgs;
    expect(cfgs).toHaveLength(3); // two clauses plus the captured closure
    const cfg = cfgs.find((candidate) =>
      candidate.blocks.some((block) => block.text.includes('receive do')),
    )!;
    expect(cfg.blocks.some((block) => block.text.includes('receive do'))).toBe(true);
    expect(
      new Set(cfg.edges.filter((edge) => edge.kind.startsWith('cond')).map((edge) => edge.from))
        .size,
    ).toBe(21);
    expect(cfg.edges.filter((edge) => edge.kind === 'cond-true')).toHaveLength(15);
    expect(cfg.edges.filter((edge) => edge.kind === 'cond-false')).toHaveLength(21);
    expect(cfg.edges.some((edge) => edge.kind === ('message-delivery' as never))).toBe(false);
    expect(
      cfg.blocks.some(
        (block) => block.text.includes('value <- values') && block.statements![0]!.defs.length > 0,
      ),
    ).toBe(true);
    const closure = cfgs.find((candidate) =>
      candidate.blocks.some((block) => block.text.includes('fallback')),
    )!;
    expect(
      closure.blocks.some((block) =>
        block.statements?.some((statement) =>
          statement.sites?.some((site) => site.kind === 'call'),
        ),
      ),
    ).toBe(true);
  });
});
