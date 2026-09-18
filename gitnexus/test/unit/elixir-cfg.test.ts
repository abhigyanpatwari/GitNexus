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
    expect(result.findings.map((finding) => finding.sink.entryName).sort()).toEqual([
      'eval_string',
      'query!',
    ]);
    expect(result.findings.map((finding) => finding.sinkKind).sort()).toEqual([
      'code-injection',
      'sql-injection',
    ]);
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
    expect(cfg.blocks).toHaveLength(51);
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
    expect(
      cfg.blocks.some(
        (block) =>
          block.text.includes('fallback') &&
          block.statements![0]!.sites?.some((site) => site.kind === 'call'),
      ),
    ).toBe(true);
  });
});
