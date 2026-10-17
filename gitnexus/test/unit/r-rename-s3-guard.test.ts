/**
 * The R rename provider refuses a new name `generic.class` that would silently register an S3
 * method. Every dot is a possible split, so `to.json.foo` is a method of `to.json`, and a base
 * generic counts although no indexed source defines it (`print.foo`). Each refusal is paired with
 * a name that only looks similar.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { registersS3Method, rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

type Definition = { readonly name: string; readonly type: string };

/** Run the provider's safety check for renaming `helper` to `newName`, with these definitions. */
function verdictWith(newName: string, defs: readonly Definition[]): string {
  const source = defs.map((d) => `${d.name} <- function(x) x`).join('\n');
  const files = new Map([
    [
      'a.R',
      {
        tree: parser.parse(source),
        parsed: { localDefs: defs.map((d) => ({ qualifiedName: d.name, type: d.type })) },
      },
    ],
  ]);
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: 'helper', filePath: 'a.R' },
    newName,
    files,
    graph: createKnowledgeGraph(),
  } as never);
  return issue ? issue.code : 'ok';
}

/** The same, with every name defined as a plain function. */
const verdict = (newName: string, defined: readonly string[]): string =>
  verdictWith(
    newName,
    defined.map((name) => ({ name, type: 'Function' })),
  );

describe('R rename: the S3 registration guard', () => {
  it('refuses a name whose first dot split is a defined function', () => {
    expect(verdict('area.circle', ['area'])).toBe('unsupported_occurrence');
  });

  it('refuses a name whose later dot split is a defined dotted generic', () => {
    expect(verdict('to.json.foo', ['to.json'])).toBe('unsupported_occurrence');
    expect(verdict('as.data.frame.foo', ['as.data.frame'])).toBe('unsupported_occurrence');
  });

  it('refuses a name with one dot after a defined function of a shorter name', () => {
    expect(verdict('to.json', ['to'])).toBe('unsupported_occurrence');
  });

  it('refuses a method of a base generic that the sources do not define', () => {
    for (const name of ['print.foo', 'format.foo', 'summary.foo', 'plot.foo', 'as.character.foo']) {
      expect(verdict(name, [])).toBe('unsupported_occurrence');
    }
  });

  it('refuses a method of every S3 group generic and of each function a group dispatches', () => {
    const groups: Record<string, string> = {
      group: 'Ops Math Summary Complex matrixOps',
      Math: 'abs sign sqrt floor ceiling trunc round signif exp log expm1 log1p cos sin tan cospi sinpi tanpi acos asin atan cosh sinh tanh acosh asinh atanh lgamma gamma digamma trigamma cumsum cumprod cummax cummin',
      Summary: 'all any sum prod max min range',
      Complex: 'Arg Conj Im Mod Re',
      'is.*': 'is.numeric is.na is.nan is.finite is.infinite is.array is.matrix is.unsorted',
      'as.*':
        'as.complex as.raw as.double as.vector as.list as.matrix as.Date as.POSIXct as.factor',
      common:
        'print format summary plot toString unique rev sort rep seq length names dim levels as.character as.numeric as.data.frame c t mean median head tail merge split within with subset transform update predict residuals coef fitted anova AIC BIC logLik nobs simulate unlist',
    };
    for (const [group, names] of Object.entries(groups)) {
      for (const generic of names.split(' ')) {
        expect(verdict(`${generic}.foo`, []), `${group}: ${generic}.foo`).toBe(
          'unsupported_occurrence',
        );
      }
    }
  });

  it('refuses a method of a group generic at any dot split', () => {
    expect(verdict('Ops.money', [])).toBe('unsupported_occurrence');
    expect(verdict('sum.items.extra', [])).toBe('unsupported_occurrence');
    expect(verdict('as.complex.foo.bar', [])).toBe('unsupported_occurrence');
  });

  it('allows a name that only resembles a group generic or a base generic', () => {
    for (const name of [
      'sums.foo',
      'mysum.foo',
      'Opsy.foo',
      'math.foo',
      'is_numeric.foo',
      'a.sum',
    ]) {
      expect(verdict(name, []), name).toBe('ok');
    }
  });

  it('allows a dotted name when no prefix is a function or a base generic', () => {
    expect(verdict('my.helper', [])).toBe('ok');
    expect(verdict('to.json.foo', [])).toBe('ok');
    expect(verdict('toJson.foo', ['to.json'])).toBe('ok');
  });

  it('treats only functions as generics, not classes or members of the same name', () => {
    // The positive control: the same name defined as a function is refused.
    expect(verdictWith('Widget.foo', [{ name: 'Widget', type: 'Function' }])).toBe(
      'unsupported_occurrence',
    );
    for (const type of ['Class', 'Method', 'Property']) {
      expect(verdictWith('Widget.foo', [{ name: 'Widget', type }]), type).toBe('ok');
    }
    // A name with a Class and a Function of the same spelling is still refused.
    expect(
      verdictWith('Widget.foo', [
        { name: 'Widget', type: 'Class' },
        { name: 'Widget', type: 'Function' },
      ]),
    ).toBe('unsupported_occurrence');
  });

  it('refuses a rename only for the NAMESPACE export of a function, not of a member', () => {
    const inPackage = (label: 'Function' | 'Method' | 'Property' | 'Class') => {
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: `${label}:R/a.R:helper`,
        label,
        properties: { filePath: 'R/a.R', name: 'helper', isExported: true },
      });
      return (
        rRenameProvider.checkSafety?.({
          target: { type: 'Function', qualifiedName: 'helper', filePath: 'R/a.R' },
          newName: 'helper2',
          files: new Map([
            ['R/a.R', { tree: parser.parse('helper <- function(x) x'), parsed: { localDefs: [] } }],
          ]),
          graph,
        } as never)?.code ?? 'ok'
      );
    };
    expect(inPackage('Function')).toBe('unsupported_occurrence');
    expect(inPackage('Method')).toBe('ok');
    expect(inPackage('Property')).toBe('ok');
    expect(inPackage('Class')).toBe('ok');
  });

  it('allows a name with no dot, and a name that merely starts with a dot', () => {
    expect(verdict('print_foo', [])).toBe('ok');
    expect(verdict('.print', [])).toBe('ok');
    expect(verdict('.print.x', [])).toBe('ok');
  });

  it('tests every prefix of the name', () => {
    const defined = new Set(['a.b']);
    expect([
      registersS3Method('a.b.c.d', defined),
      registersS3Method('a.x.b', defined),
      registersS3Method('a.b', defined),
    ]).toEqual([true, false, false]);
  });
});
