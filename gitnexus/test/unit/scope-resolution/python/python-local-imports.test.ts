import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pythonProvider } from '../../../../src/core/ingestion/languages/python.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from '../../../integration/resolvers/helpers.js';

describe('Python compiler-local import ownership', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-python-local-imports-'));
    writeFixtureRepo(repoDir, {
      'module_target.py': 'def helper(): return 1\n',
      'closure_target.py': 'def helper(): return 2\n',
      'class_target.py': 'def helper(): return 3\n',
      'empty.py': 'value = 1\n',
      'model.py': 'class User:\n    def save(self): pass\n',
      'comprehension_source.py': 'def items(): return []\n',
      'type_checking.py': `from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from model import User

def type_checking_receiver(user: User):
    user.save()
`,
      'conditional_imports.py': `def conditional_named(flag):
    if flag:
        from module_target import helper
    return helper()

def conditional_namespace(flag):
    if flag:
        import module_target as mod
    return mod.helper()

def try_named():
    try:
        from module_target import helper
    except ImportError:
        pass
    return helper()

def try_identical_imports():
    try:
        import module_target as mod
    except ImportError:
        import module_target as mod
    return mod.helper()

def conflicting_conditional_imports(flag):
    if flag:
        from module_target import helper
    else:
        from closure_target import helper
    return helper()

def mixed_conditional_import(flag, callback):
    if flag:
        from module_target import helper
    else:
        helper = callback
    return helper()

def conflicting_try_imports():
    try:
        from module_target import helper
    except ImportError:
        from closure_target import helper
    return helper()
`,
      'comprehension_iterables.py': `import comprehension_source as y

def comprehension_later_iterable(xs):
    return [y for x in xs for y in y.items()]

def comprehension_first_iterable():
    return [y for y in y.items()]
`,
      'receivers.py': `from model import User
class Holder:
    value = User()
    def bare_class_value(self):
        return value.save()
    def explicit_class_value(self):
        return self.value.save()
`,
      'parameter_default.py': `from module_target import helper
def outer_parameter_default(helper):
    def inner_parameter_default(value=helper()):
        from closure_target import helper
    return inner_parameter_default
`,
      'parameter_annotation.py': `from module_target import helper
def annotated_parameter(value: helper()):
    from closure_target import helper
    return helper()

def outer_annotation(helper):
    def inner_annotation(value: helper()):
        from closure_target import helper
    return inner_annotation
`,
      'import_default.py': `from module_target import helper
def outer_import_default():
    from closure_target import helper
    def inner_import_default(value=helper()):
        from class_target import helper
    return inner_import_default
`,
      'module_default.py': `from module_target import helper
def module_default(value=helper()):
    from closure_target import helper
    return helper()
`,
      'class_default.py': `from module_target import helper
class Defaults:
    from class_target import helper
    def method_default(self, value=helper()):
        from closure_target import helper
        return helper()
`,
      'receiver_defaults.py': `from model import User
def outer_receiver_parameter_default(value):
    def inner_receiver_parameter_default(result=value.save()):
        value = User()
    return inner_receiver_parameter_default
def outer_receiver_import_default():
    value = User()
    def inner_receiver_import_default(result=value.save()):
        value = None
    return inner_receiver_import_default
`,
      'annotated.py': `from module_target import helper
helper: object
def annotation_keeps_module_import():
    return helper()
def annotation_is_function_local():
    helper()
    helper: object
`,
      'type_alias.py': `from module_target import helper
def generic_type_alias():
    helper()
    type helper[T] = T
`,
      'app.py': `from module_target import helper

def before_import():
    return helper()
    from closure_target import helper

def after_import():
    from closure_target import helper
    return helper()

def unresolved_import():
    from unavailable import helper
    return helper()

def missing_export():
    from empty import helper
    return helper()

def parameter(helper):
    return helper()

def tuple_target():
    helper()
    helper, *rest = values

def loop_target():
    helper()
    for helper, other in values: pass

def with_target():
    helper()
    with resource as helper: pass

def exception_target():
    helper()
    try: pass
    except Exception as helper: pass

def match_target(value):
    helper()
    match value:
        case {'name': helper}: pass

def augmented_target():
    helper()
    helper += 1

def deleted_target():
    helper()
    del helper

def walrus_target():
    helper()
    [(helper := item) for item in values]

def comprehension_target(values):
    return [helper() for helper in values]

def comprehension_does_not_leak(values):
    [helper for helper in values]
    return helper()

def comprehension_iterable():
    return [helper for helper in helper()]

def install_global():
    global deferred_helper
    from closure_target import helper as deferred_helper
    return deferred_helper()

def without_installing():
    return deferred_helper()

callback = lambda helper: helper()

def enclosing():
    from closure_target import helper
    class Ordered:
        before = helper()
        from class_target import helper
        after = helper()
        def method(self):
            return helper()
    class ClosureOnly:
        value = helper()
    class Deleted:
        from class_target import helper
        before = helper()
        del helper
        after = helper()
    class AnnotationOnly:
        helper: object
        value = helper()
    class AnnotationKeepsImport:
        from class_target import helper
        helper: object
        value = helper()
    return Ordered
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const targets = (caller: string) =>
    getRelationships(result, 'CALLS')
      .filter((edge) => edge.source === caller && edge.target === 'helper')
      .map((edge) => edge.rel.targetId)
      .sort();

  it('resolves a local import only after it has initialized', () => {
    expect(targets('before_import')).toEqual([]);
    expect(targets('after_import')).toEqual(['Function:closure_target.py:helper']);
  });

  it('uses a TYPE_CHECKING import to resolve an annotated receiver', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.source === 'type_checking_receiver')
        .map((edge) => edge.rel.targetId),
    ).toEqual(['Method:model.py:User.save#0']);
  });

  it.each(['conditional_named', 'conditional_namespace', 'try_named', 'try_identical_imports'])(
    'resolves the sole import identity in %s',
    (caller) => {
      expect(targets(caller)).toEqual(['Function:module_target.py:helper']);
    },
  );

  it.each([
    'conflicting_conditional_imports',
    'mixed_conditional_import',
    'conflicting_try_imports',
  ])('preserves the barrier for competing bindings in %s', (caller) => {
    expect(targets(caller)).toEqual([]);
  });

  it.each(['unresolved_import', 'missing_export'])(
    'does not fall through an unresolved owned import: %s',
    (caller) => expect(targets(caller)).toEqual([]),
  );

  it.each([
    'parameter',
    'tuple_target',
    'loop_target',
    'with_target',
    'exception_target',
    'match_target',
    'augmented_target',
    'deleted_target',
    'walrus_target',
    'comprehension_target',
    'callback',
  ])('respects the compiler-local binder in %s', (caller) => {
    expect(targets(caller)).toEqual([]);
  });

  it('isolates comprehension targets and evaluates the first iterable outside their scope', () => {
    expect(targets('comprehension_does_not_leak')).toEqual(['Function:module_target.py:helper']);
    expect(targets('comprehension_iterable')).toEqual(['Function:module_target.py:helper']);
  });

  it('owns later comprehension targets before evaluating their iterable', () => {
    // CPython raises UnboundLocalError for y.items() in the later for clause:
    // its y is already a comprehension local, not the imported namespace.
    const calls = getRelationships(result, 'CALLS').filter((edge) => edge.target === 'items');
    expect(calls.filter((edge) => edge.source === 'comprehension_later_iterable')).toEqual([]);
    expect(
      calls
        .filter((edge) => edge.source === 'comprehension_first_iterable')
        .map((edge) => edge.rel.targetId),
    ).toEqual(['Function:comprehension_source.py:items']);
  });

  it('does not assume an installer executed for an unrelated global caller', () => {
    expect(targets('without_installing')).toEqual([]);
    expect(targets('install_global')).toEqual(['Function:closure_target.py:helper']);
  });

  it('uses ordered class locals, module fallback, and class-skipping closure lookup', () => {
    expect(targets('Ordered')).toEqual([
      'Function:class_target.py:helper',
      'Function:module_target.py:helper',
    ]);
    expect(targets('method')).toEqual(['Function:closure_target.py:helper']);
    expect(targets('ClosureOnly')).toEqual(['Function:closure_target.py:helper']);
  });

  it('resumes module fallback after deleting a class binding', () => {
    expect(targets('Deleted')).toEqual([
      'Function:class_target.py:helper',
      'Function:module_target.py:helper',
    ]);
  });

  it('distinguishes annotation-only compiler locals from runtime stores', () => {
    expect(targets('annotation_keeps_module_import')).toEqual(['Function:module_target.py:helper']);
    expect(targets('annotation_is_function_local')).toEqual([]);
    expect(targets('AnnotationOnly')).toEqual(['Function:module_target.py:helper']);
    expect(targets('AnnotationKeepsImport')).toEqual(['Function:class_target.py:helper']);
  });

  it('treats a generic type alias name as a compiler-local binding', () => {
    expect(targets('generic_type_alias')).toEqual([]);
  });

  it('skips class locals for bare method names while retaining explicit instance field lookup', () => {
    const calls = getRelationships(result, 'CALLS').filter((edge) => edge.target === 'save');
    expect(calls.filter((edge) => edge.source === 'bare_class_value')).toEqual([]);
    expect(
      calls
        .filter((edge) => edge.source === 'explicit_class_value')
        .map((edge) => edge.rel.targetId),
    ).toEqual(['Method:model.py:User.save#0']);
  });

  it('keeps an outer parameter barrier for a default expression despite an inner import', () => {
    expect(
      getRelationships(result, 'CALLS').filter(
        (edge) => edge.sourceFilePath === 'parameter_default.py' && edge.target === 'helper',
      ),
    ).toEqual([]);
  });

  it('resolves a default expression through the outer import before the inner import executes', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.sourceFilePath === 'import_default.py' && edge.target === 'helper')
        .map((edge) => [edge.source, edge.rel.targetId]),
    ).toEqual([['outer_import_default', 'Function:closure_target.py:helper']]);
  });

  it('resolves parameter annotations outside the function body and retains outer parameter barriers', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter(
          (edge) => edge.sourceFilePath === 'parameter_annotation.py' && edge.target === 'helper',
        )
        .map((edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`)
        .sort(),
    ).toEqual([
      'File:parameter_annotation.py -> Function:module_target.py:helper',
      'Function:parameter_annotation.py:annotated_parameter -> Function:closure_target.py:helper',
    ]);
  });

  it('resolves default-expression receivers in the enclosing environment', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.sourceFilePath === 'receiver_defaults.py' && edge.target === 'save')
        .map((edge) => [edge.source, edge.rel.targetId]),
    ).toEqual([['outer_receiver_import_default', 'Method:model.py:User.save#0']]);
  });

  it('attributes a module-level default to the file and its body call to the function', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.sourceFilePath === 'module_default.py' && edge.target === 'helper')
        .map((edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`)
        .sort(),
    ).toEqual([
      'File:module_default.py -> Function:module_target.py:helper',
      'Function:module_default.py:module_default -> Function:closure_target.py:helper',
    ]);
  });

  it('attributes a method default to the class and its body call to the method', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.sourceFilePath === 'class_default.py' && edge.target === 'helper')
        .map((edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`)
        .sort(),
    ).toEqual([
      'Class:class_default.py:Defaults -> Function:class_target.py:helper',
      'Method:class_default.py:Defaults.method_default#1 -> Function:closure_target.py:helper',
    ]);
  });
});

describe('Python binding directives', () => {
  it('separates synthesized dependency callers from default lookup ownership', () => {
    const parsed = extractParsedFile(
      pythonProvider,
      `from fastapi import Depends
from module_target import helper
def handler(value=Depends(helper)):
    from closure_target import helper
    return helper()
`,
      'dependency.py',
    )!;
    const module = parsed.scopes.find((scope) => scope.kind === 'Module')!;
    const handler = parsed.scopes.find((scope) => scope.kind === 'Function')!;
    const dependency = parsed.referenceSites.find(
      (site) => site.name === 'helper' && site.callerScope !== undefined,
    )!;
    expect(dependency.inScope).toBe(module.id);
    expect(dependency.callerScope).toBe(handler.id);
    const body = parsed.referenceSites.find(
      (site) => site.name === 'helper' && site.kind === 'call' && site.atRange.startLine === 5,
    )!;
    expect(body.inScope).toBe(handler.id);
    expect(body.callerScope).toBeUndefined();
    const factory = parsed.referenceSites.find(
      (site) => site.name === 'Depends' && site.kind === 'call',
    )!;
    expect(factory.inScope).toBe(module.id);
    expect(factory.callerScope).toBeUndefined();
  });

  it.each(['def f():', 'class C:'])(
    'keeps module and child ownership distinct when the file is exactly one %s',
    (header) => {
      const parsed = extractParsedFile(
        pythonProvider,
        `${header}\n    from closure_target import helper\n    value = helper()`,
        'single.py',
      )!;
      const module = parsed.scopes.find((scope) => scope.kind === 'Module')!;
      const child = parsed.scopes.find((scope) => scope.kind !== 'Module')!;
      expect(module.range).toEqual(child.range);
      expect(module.nameClaims?.map((claim) => claim.name)).toEqual([
        header.startsWith('def') ? 'f' : 'C',
      ]);
      expect(module.lookupPolicy?.parentScope).toBeUndefined();
      expect(child.nameClaims?.find((claim) => claim.name === 'helper')?.kind).toBe('import');
      expect(parsed.parsedImports[0]?.declaredAtScope).toBe(child.id);
    },
  );

  it('routes a global import to the module while preserving its deferred execution', () => {
    const parsed = extractParsedFile(
      pythonProvider,
      `def boot():
    global helper
    from module_target import helper
    return helper()
`,
      'global.py',
    )!;
    const module = parsed.scopes.find((scope) => scope.kind === 'Module')!;
    expect(parsed.parsedImports[0]?.declaredAtScope).toBe(module.id);
    expect(parsed.parsedImports[0]?.runsOnlyWhenCalled).toBe(true);
  });

  it('routes nonlocal imports through an intervening function and class to the owning function', () => {
    const parsed = extractParsedFile(
      pythonProvider,
      `def outer():
    helper = None
    def middle():
        class Inner:
            def update(self):
                nonlocal helper
                from module_target import helper
`,
      'nonlocal.py',
    )!;
    const outer = parsed.scopes.find(
      (scope) => scope.kind === 'Function' && scope.range.startLine === 1,
    )!;
    expect(parsed.parsedImports[0]?.declaredAtScope).toBe(outer.id);
  });
});
