import { assert, expect, it, vi } from 'vitest';
import { getQueryProviderForFile } from '../../src/core/ingestion/languages/query-providers.js';

const classifier = async (owner: string) => {
  const attribution = getQueryProviderForFile('model.py')?.typeImportAttribution;
  assert(attribution);
  return attribution.createClassifier({
    ownerPath: 'model.py',
    name: 'Invoice',
    readOwner: vi.fn(async () => owner),
  });
};
const classify = async (source: string, owner = 'class Invoice: pass\n') =>
  (await classifier(owner))('use.py', source, new Set(['model.py']));

it.each([
  [
    'a closure over an enclosing function import',
    'def outer():\n    import model as m\n    def inner():\n        return m.Invoice\n',
    true,
  ],
  ['a module alias that is also read bare', 'import model as m\nprint(m)\nx = m.Invoice\n', true],
  [
    'an alias declared global by the importing function',
    'def setup():\n    global m\n    import model as m\ndef use():\n    return m.Invoice\n',
    true,
  ],
  ['a spaced dotted receiver', 'import model\nx = model . Invoice\n', true],
  ['a use inside a comprehension', 'import model as m\nxs = [m.Invoice for _ in range(3)]\n', true],
  [
    'a parameter that shadows the alias',
    'import model as m\ndef f(m):\n    return m.Invoice\n',
    undefined,
  ],
  [
    'an import local to a sibling function',
    'def a():\n    import model as m\ndef b():\n    return m.Invoice\n',
    undefined,
  ],
  [
    'a class-body import read from a method',
    'class C:\n    import model as m\n    def f(self):\n        return m.Invoice\n',
    undefined,
  ],
  ['an alias rebound to another value', 'import model as m\nm = other\nx = m.Invoice\n', undefined],
  ['a string annotation', 'import model\ndef f(x: "model.Invoice"): pass\n', undefined],
  ['a reflective getattr on the module', 'import model\nkind = getattr(model, name)\n', undefined],
  ['an unrelated member of the module', 'import model\nx = model.Order\n', false],
] as const)('classifies %s', async (_, source, expected) => {
  expect(await classify(source)).toBe(expected);
});

it.each([
  ['a literal list followed by exec', '__all__ = ["Order"]\nexec(code)\n', undefined],
  ['a namespace update without __all__ text', 'globals().update(values)\n', undefined],
  ['no __all__ and no dynamic namespace', '', true],
  ['a literal list naming the class', '__all__ = ["Invoice"]\n', true],
  ['a literal list without the class', '__all__ = ["Order"]\n', false],
] as const)(
  'checks a dynamic wildcard owner before literal rules: %s',
  async (_, prefix, expected) => {
    expect(await classify('from model import *\n', prefix + 'class Invoice: pass\n')).toBe(
      expected,
    );
  },
);
