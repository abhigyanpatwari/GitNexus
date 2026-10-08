import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

describe('Python wildcard definitions and lexical namespace visibility', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-python-namespace-semantics-'));
    writeFixtureRepo(repoDir, {
      'definitions.py':
        'class Worker:\n    def run(self):\n        return 1\ndef run():\n    return 2\n',
      'values.py': 'run = 42\nclass Worker:\n    def run(self):\n        return 1\n',
      'definitions_star.py': 'from definitions import *\n',
      'values_star.py': 'from values import *\n',
      'origin.py':
        'def helper():\n    return 1\ndef _hidden():\n    return 2\nclass Maker:\n    def work(self):\n        return 3\n',
      'pkg/__init__.py': 'from origin import helper as exported, Maker, _hidden\n',
      'pkg/a.py': 'def run():\n    return 3\n',
      'pkg/b.py': 'def other():\n    return 4\n',
      'pkg/nested/__init__.py': 'def other():\n    return 11\n',
      'namespace_pkg/a.py': 'def run():\n    return 5\n',
      'namespace_pkg/b.py': 'def other():\n    return 6\n',
      'star.py': 'from pkg import *\n',
      'multi_star.py': 'from star import *\n',
      'exports.py': '__all__ = ["exported"]\n',
      'assigned_all.py': 'from pkg import exported\n__all__ = ["exported"]\n',
      'imported_all.py': 'from pkg import exported\nfrom exports import __all__\n',
      'local_all.py':
        'from pkg import exported\ndef configure():\n    from exports import __all__\n',
      'assigned_star.py': 'from assigned_all import *\n',
      'imported_star.py': 'from imported_all import *\n',
      'blocked_multi.py': 'from assigned_star import *\n',
      'local_star.py': 'from local_all import *\n',
      'cycle_a.py': 'from cycle_b import *\ndef cyclic():\n    return 7\n',
      'cycle_b.py': 'from cycle_a import *\n',
      'module_target.py': 'def helper():\n    return 8\n',
      'class_target.py': 'def helper():\n    return 9\n',
      'closure_target.py': 'def helper():\n    return 10\n',
      'decoy.py':
        'def run():\n    return 0\ndef exported():\n    return 0\ndef _hidden():\n    return 0\n',
      'module_rebinding.py': `import module_target as mod
from values import run as mod
def module_rebound():
    return mod.helper()
`,
      'module_rebinding_reverse.py': `from values import run as mod
import module_target as mod
def module_rebound_reverse():
    return mod.helper()
`,
      'app.py': `import definitions_star
import values_star
import star
import multi_star
import assigned_star
import imported_star
import blocked_multi
import local_star
import cycle_b
import pkg.a
import namespace_pkg.a
import module_target as mod

def module_definition():
    return definitions_star.run()
def module_value():
    return values_star.run()
def imported_export():
    return star.exported()
def transitive_export():
    return multi_star.exported()
def imported_class():
    return multi_star.Maker().work()
def private_export():
    return multi_star._hidden()
def assigned_exports():
    return assigned_star.exported()
def imported_exports():
    return imported_star.exported()
def transitive_blocked_exports():
    return blocked_multi.exported()
def local_exports():
    return local_star.exported()
def cyclic_export():
    return cycle_b.cyclic()
def sibling_package():
    import pkg.b
    return pkg.a.run()
def sibling_namespace_package():
    import namespace_pkg.b
    return namespace_pkg.a.run()
def named_shadow():
    from origin import Maker as pkg
    return pkg.a.run()
def unresolved_shadow():
    import unavailable as pkg
    return pkg.a.run()
def different_package():
    import namespace_pkg.b as pkg
    return pkg.a.run()
def root_named_module_alias():
    import pkg.b as pkg
    return pkg.other()
def root_named_package_alias():
    import pkg.nested as pkg
    return pkg.other()
def root_named_module_shadow():
    import pkg.b as pkg
    return pkg.a.run()
def root_named_package_shadow():
    import pkg.nested as pkg
    return pkg.a.run()
def root_named_module_path():
    import pkg.b as pkg
    return pkg.b.other()
def root_named_package_path():
    import pkg.nested as pkg
    return pkg.nested.other()

class ClassOnly:
    import class_target as class_mod
    value = class_mod.helper()
    def class_only(self):
        return class_mod.helper()

class WithModule:
    import class_target as mod
    value = mod.helper()
    def module_visible(self):
        return mod.helper()
    def parameter_shadow(self, mod):
        return mod.helper()

def namespace_rebound():
    import module_target as mod
    import class_target as mod
    return mod.helper()
def named_rebound():
    import module_target as mod
    from values import run as mod
    return mod.helper()
def named_rebound_reverse():
    from values import run as mod
    import module_target as mod
    return mod.helper()
def conditional_rebound(flag):
    if flag:
        import module_target as mod
    else:
        from values import run as mod
    return mod.helper()
def conditional_namespaces(flag):
    if flag:
        import module_target as mod
    else:
        import class_target as mod
    return mod.helper()
def compatible_imports():
    import pkg.a
    import pkg.b
    import pkg.a
    pkg.a.run()
    return pkg.b.other()
def duplicate_imports():
    import module_target as mod
    import module_target as mod
    return mod.helper()

def enclosing():
    import closure_target as enclosed_mod
    class Nested:
        import class_target as enclosed_mod
        def closure_visible(self):
            return enclosed_mod.helper()
    return Nested
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60000);

  afterAll(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const callsFrom = (name: string) =>
    getRelationships(result, 'CALLS').filter((edge) => edge.source === name);

  it('keeps the exact module definition when a class method has the same name', () => {
    expect(callsFrom('module_definition').map((edge) => edge.rel.targetId)).toEqual([
      'Function:definitions.py:run',
    ]);
    expect(callsFrom('module_value').map((edge) => edge.rel.targetId)).toEqual([
      'Variable:values.py:run',
    ]);
  });

  it('publishes imported aliases through one or more wildcard barrels', () => {
    for (const name of ['imported_export', 'transitive_export', 'local_exports']) {
      expect(callsFrom(name).map((edge) => edge.rel.targetId)).toEqual([
        'Function:origin.py:helper',
      ]);
    }
    expect(
      callsFrom('imported_class').map(
        (edge) => `${edge.targetLabel}:${edge.targetFilePath}:${edge.target}`,
      ),
    ).toEqual(['Class:origin.py:Maker', 'Method:origin.py:work']);
  });

  it('filters private names and declines explicit module-level __all__ through every hop', () => {
    for (const name of [
      'private_export',
      'assigned_exports',
      'imported_exports',
      'transitive_blocked_exports',
    ]) {
      expect(callsFrom(name), name).toEqual([]);
    }
  });

  it('propagates wildcard exports through a bounded cycle', () => {
    expect(callsFrom('cyclic_export').map((edge) => edge.rel.targetId)).toEqual([
      'Function:cycle_a.py:cyclic',
    ]);
  });

  it('retains compatible outer submodule paths for regular and namespace packages', () => {
    expect(callsFrom('sibling_package').map((edge) => edge.rel.targetId)).toEqual([
      'Function:pkg/a.py:run',
    ]);
    expect(callsFrom('sibling_namespace_package').map((edge) => edge.rel.targetId)).toEqual([
      'Function:namespace_pkg/a.py:run',
    ]);
  });

  it('still suppresses outer paths under named, unresolved, and different namespace imports', () => {
    for (const name of ['named_shadow', 'unresolved_shadow', 'different_package']) {
      expect(callsFrom(name), name).toEqual([]);
    }
  });

  it('binds root-spelled aliases to the imported module or package', () => {
    expect(callsFrom('root_named_module_alias').map((edge) => edge.rel.targetId)).toEqual([
      'Function:pkg/b.py:other',
    ]);
    expect(callsFrom('root_named_package_alias').map((edge) => edge.rel.targetId)).toEqual([
      'Function:pkg/nested/__init__.py:other',
    ]);
  });

  it('does not expose original or outer package paths through root-spelled aliases', () => {
    for (const name of [
      'root_named_module_shadow',
      'root_named_package_shadow',
      'root_named_module_path',
      'root_named_package_path',
    ]) {
      expect(callsFrom(name), name).toEqual([]);
    }
  });

  it('suppresses conflicting imports in module and function scopes regardless of order', () => {
    for (const name of [
      'module_rebound',
      'module_rebound_reverse',
      'namespace_rebound',
      'named_rebound',
      'named_rebound_reverse',
      'conditional_rebound',
      'conditional_namespaces',
    ]) {
      expect(callsFrom(name), name).toEqual([]);
    }
  });

  it('preserves compatible dotted imports and repeated identical aliases in one scope', () => {
    expect(
      callsFrom('compatible_imports')
        .map((edge) => edge.rel.targetId)
        .sort(),
    ).toEqual(['Function:pkg/a.py:run', 'Function:pkg/b.py:other']);
    expect(callsFrom('duplicate_imports').map((edge) => edge.rel.targetId)).toEqual([
      'Function:module_target.py:helper',
    ]);
  });

  it('skips class imports when looking outward from methods', () => {
    expect(callsFrom('class_only')).toEqual([]);
    expect(callsFrom('module_visible').map((edge) => edge.rel.targetId)).toEqual([
      'Function:module_target.py:helper',
    ]);
    expect(callsFrom('closure_visible').map((edge) => edge.rel.targetId)).toEqual([
      'Function:closure_target.py:helper',
    ]);
    expect(callsFrom('parameter_shadow')).toEqual([]);
  });

  it('keeps class imports visible within their own class bodies', () => {
    const classCalls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.targetId === 'Function:class_target.py:helper',
    );
    expect(classCalls).toHaveLength(2);
    expect(classCalls.map((edge) => edge.source).sort()).toEqual(['ClassOnly', 'WithModule']);
  });
});
