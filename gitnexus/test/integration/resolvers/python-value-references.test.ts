import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './helpers.js';

describe('Python value-reference edges (#3942, #3943)', () => {
  const result = useFixture('python-value-references', {
    'config.py': `TIMEOUT = 30

def helper(x):
    return x
`,
    'app.py': `import asyncio
from config import TIMEOUT, helper

LOCAL_LIMIT = 5

def calls_directly():
    return helper(1)

def uses_constant():
    return TIMEOUT * 2

def uses_local_constant():
    return LOCAL_LIMIT + 1

async def passes_function():
    return await asyncio.to_thread(helper, 1)

def passes_function_sync(items):
    return list(map(helper, items))

def local_helper(x):
    return x

def passes_local_function(items):
    return sorted(items, key=local_helper)
`,
  });

  it.each([
    ['uses_constant', 'TIMEOUT', 'config.py'],
    ['uses_local_constant', 'LOCAL_LIMIT', 'app.py'],
  ])('links %s to the module variable it reads', (source, target, targetFilePath) => {
    expect(getRelationships(result(), 'ACCESSES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source, target, targetFilePath, targetLabel: 'Variable' }),
      ]),
    );
  });

  it.each([
    ['passes_function', 'helper', 'config.py'],
    ['passes_function_sync', 'helper', 'config.py'],
    ['passes_local_function', 'local_helper', 'app.py'],
  ])('links %s to the function it passes as a value', (source, target, targetFilePath) => {
    expect(getRelationships(result(), 'USES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source,
          target,
          targetFilePath,
          targetLabel: 'Function',
          rel: expect.objectContaining({ reason: 'scope-resolution: value-ref' }),
        }),
      ]),
    );
    expect(
      getRelationships(result(), 'CALLS').filter(
        (edge) => edge.source === source && edge.target === target,
      ),
    ).toEqual([]);
  });

  it('preserves the direct-call control', () => {
    expect(getRelationships(result(), 'CALLS')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'calls_directly',
          target: 'helper',
          targetFilePath: 'config.py',
        }),
      ]),
    );
  });
});

describe('Python bare-read positions and lexical ownership', () => {
  const result = useFixture('python-read-positions', {
    'config.py': `TIMEOUT = 30
X: int = 30

def read_annotated_here():
    return X
`,
    'reads.py': `from config import TIMEOUT, X

def compare(n):
    return n < TIMEOUT

def boolean(n):
    return n or TIMEOUT

def return_value():
    return TIMEOUT

def assign_value():
    value = TIMEOUT
    return value

def positional():
    consume(TIMEOUT)

def keyword():
    consume(timeout=TIMEOUT)

def read_annotated_import():
    return X

class Reader:
    def read_method(self):
        return TIMEOUT

class Collision:
    TIMEOUT = 1
    def sibling_writer(self):
        TIMEOUT = 2
        return TIMEOUT
    def read_module(self):
        return TIMEOUT
    def read_member(self):
        return self.TIMEOUT
    def enclosing(self):
        def read_from_closure():
            return TIMEOUT
        return read_from_closure
`,
    'defaults.py': `from config import TIMEOUT

def module_default(value=TIMEOUT):
    return value

def typed_default(value: int=TIMEOUT):
    return value

class Defaults:
    limit = TIMEOUT
    def method_default(self, value=TIMEOUT):
        return value

def outer_default():
    def nested(value=TIMEOUT):
        return value
    return nested
`,
    'shadows.py': `from config import TIMEOUT

def parameter_shadow(TIMEOUT):
    return TIMEOUT + 1

def local_shadow():
    TIMEOUT = 5
    return TIMEOUT + 1

def comprehension_shadow():
    return [TIMEOUT + 1 for TIMEOUT in range(3)]

def closure_shadow(TIMEOUT):
    def inner_shadow():
        return TIMEOUT + 1
    return inner_shadow
`,
    'annotations.py': `class Foo:
    pass

def annotated(x: int | Foo = None) -> Foo | None:
    return x
`,
  });

  it.each([
    'compare',
    'boolean',
    'return_value',
    'assign_value',
    'positional',
    'keyword',
    'read_method',
    'read_module',
    'read_from_closure',
  ])('links %s to the imported module variable', (source) => {
    expect(getRelationships(result(), 'ACCESSES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source,
          target: 'TIMEOUT',
          targetFilePath: 'config.py',
          targetLabel: 'Variable',
        }),
      ]),
    );
  });

  it('preserves explicit member reads on the same class', () => {
    expect(getRelationships(result(), 'ACCESSES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'read_member',
          target: 'TIMEOUT',
          targetFilePath: 'reads.py',
        }),
      ]),
    );
  });

  it.each(['read_annotated_here', 'read_annotated_import'])(
    'links %s to the annotated module property',
    (source) => {
      expect(getRelationships(result(), 'ACCESSES')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source,
            target: 'X',
            targetFilePath: 'config.py',
            targetLabel: 'Property',
          }),
        ]),
      );
    },
  );

  it('attributes defaults and class-body reads to their evaluation scopes', () => {
    const edges = getRelationships(result(), 'ACCESSES').filter(
      (edge) => edge.sourceFilePath === 'defaults.py' && edge.target === 'TIMEOUT',
    );
    expect(edges.map((edge) => [edge.source, edge.sourceLabel])).toEqual(
      expect.arrayContaining([
        ['defaults.py', 'File'],
        ['Defaults', 'Class'],
        ['outer_default', 'Function'],
      ]),
    );
    expect(
      edges.some((edge) =>
        ['module_default', 'typed_default', 'method_default', 'nested'].includes(edge.source),
      ),
    ).toBe(false);
  });

  it('does not link shadowed names to the module variable', () => {
    expect(
      getRelationships(result(), 'ACCESSES').filter(
        (edge) => edge.sourceFilePath === 'shadows.py' && edge.target === 'TIMEOUT',
      ),
    ).toEqual([]);
  });

  it('does not turn union annotations into value reads', () => {
    expect(
      getRelationships(result(), 'ACCESSES').filter(
        (edge) => edge.sourceFilePath === 'annotations.py' && edge.target === 'Foo',
      ),
    ).toEqual([]);
  });
});

describe('Python bare-read lookup limits', () => {
  const result = useFixture('python-read-limits', {
    'sibling.py': `LIMIT = 5
class Siblings:
    def sibling_writer(self):
        LIMIT = 1
        return LIMIT
    def sibling_reader(self):
        return LIMIT + 1
`,
    'global_write.py': `X = 1
def mutate():
    global X
    X = 5
def global_reader():
    return X + 1
`,
    'rebound.py': `X = 1
X = 2
def same_file_reader():
    return X + 1
`,
    'import_rebound.py': `from rebound import X
def imported_reader():
    return X + 1
`,
  });

  it.each(['global_reader', 'imported_reader'])(
    'fails closed for the known %s lookup limit',
    (source) => {
      expect(
        getRelationships(result(), 'ACCESSES').filter((edge) => edge.source === source),
      ).toEqual([]);
    },
  );

  it('resolves the module constant despite a sibling method local with the same name', () => {
    expect(getRelationships(result(), 'ACCESSES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'sibling_reader',
          target: 'LIMIT',
          targetFilePath: 'sibling.py',
        }),
      ]),
    );
  });

  it('still resolves the rebound module variable in its own file', () => {
    expect(getRelationships(result(), 'ACCESSES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'same_file_reader',
          target: 'X',
          targetFilePath: 'rebound.py',
        }),
      ]),
    );
  });
});

describe('Python callable arguments and Depends compatibility', () => {
  const result = useFixture('python-callable-arguments', {
    'config.py': `def helper(x):
    return x
`,
    'callbacks.py': `from config import helper as h

def aliased(items):
    return map(h, items)

def outer():
    def cb(x):
        return x
    register(cb)

class Consumer:
    def pass_method(self, items):
        return map(h, items)
`,
    'noncallables.py': `from config import helper
TIMEOUT = 30
class Foo:
    pass

def parameter(helper, items):
    return map(helper, items)

def local(items):
    helper = len
    return map(helper, items)

def class_value():
    register(Foo)

def constant_value():
    consume(TIMEOUT)
`,
    'depends.py': `from fastapi import Depends
from typing import Annotated

def get_db():
    return None

def get_annotated_db():
    return None

def handler(db=Depends(get_db)):
    return db

def typed_handler(db: object=Depends(get_db)):
    return db

def annotation_handler(db: Annotated[int, Depends(get_annotated_db)]):
    return db
`,
  });

  it.each([
    ['aliased', 'helper', 'config.py'],
    ['outer', 'cb', 'callbacks.py'],
    ['pass_method', 'helper', 'config.py'],
  ])('resolves the callable argument in %s', (source, target, targetFilePath) => {
    expect(getRelationships(result(), 'USES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source,
          target,
          targetFilePath,
          rel: expect.objectContaining({ reason: 'scope-resolution: value-ref' }),
        }),
      ]),
    );
    expect(
      getRelationships(result(), 'CALLS').filter(
        (edge) => edge.source === source && edge.target === target,
      ),
    ).toEqual([]);
  });

  it('withholds callable-reference edges for locals, parameters, classes and constants', () => {
    expect(
      getRelationships(result(), 'USES').filter(
        (edge) =>
          edge.sourceFilePath === 'noncallables.py' &&
          edge.rel.reason === 'scope-resolution: value-ref',
      ),
    ).toEqual([]);
  });

  it('preserves Depends calls without adding references from the default', () => {
    expect(
      getRelationships(result(), 'CALLS')
        .filter((edge) => edge.target === 'get_db')
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(['handler', 'typed_handler']);
    for (const type of ['USES', 'ACCESSES']) {
      expect(getRelationships(result(), type).filter((edge) => edge.target === 'get_db')).toEqual(
        [],
      );
    }
  });

  it('keeps callable values inside annotation metadata', () => {
    expect(getRelationships(result(), 'USES')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'get_annotated_db',
          rel: expect.objectContaining({ reason: 'scope-resolution: value-ref' }),
        }),
      ]),
    );
    expect(
      getRelationships(result(), 'ACCESSES').filter((edge) => edge.target === 'get_annotated_db'),
    ).toEqual([]);
  });
});
