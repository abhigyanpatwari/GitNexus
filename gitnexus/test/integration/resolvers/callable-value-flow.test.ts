import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { providers } from '../../../src/core/ingestion/languages/index.js';
import { getRelationships, runPipelineFromRepo, type PipelineOptions } from './helpers.js';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  saveParseCache,
  type ParseCache,
} from '../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';

const CALLABLE_FLOW_PROVIDER_COVERAGE = {
  [SupportedLanguages.JavaScript]: 'matrix',
  [SupportedLanguages.TypeScript]: 'dedicated',
  [SupportedLanguages.Python]: 'matrix',
  [SupportedLanguages.Java]: 'matrix',
  [SupportedLanguages.C]: 'dedicated',
  [SupportedLanguages.CPlusPlus]: 'dedicated',
  [SupportedLanguages.CSharp]: 'matrix',
  [SupportedLanguages.Go]: 'matrix',
  [SupportedLanguages.Ruby]: 'matrix',
  [SupportedLanguages.Rust]: 'matrix',
  [SupportedLanguages.PHP]: 'matrix',
  [SupportedLanguages.Kotlin]: 'matrix',
  [SupportedLanguages.Swift]: 'matrix',
  [SupportedLanguages.Dart]: 'matrix',
  [SupportedLanguages.Vue]: 'matrix',
  [SupportedLanguages.Cobol]: 'matrix',
} as const satisfies Record<SupportedLanguages, 'matrix' | 'dedicated'>;

const PROVIDER_FLOW_CASES = [
  {
    language: SupportedLanguages.JavaScript,
    extension: 'js',
    caller: 'invoke',
    target: 'target',
    source: `
function target() {}
function invoke(callback) { callback(); }
const first = target;
const second = first;
invoke(second);
`,
  },
  {
    language: SupportedLanguages.Python,
    extension: 'py',
    caller: 'invoke',
    target: 'target',
    source: `
def target():
    pass
def invoke(callback):
    callback()
first = target
second = first
invoke(second)
`,
  },
  {
    language: SupportedLanguages.Java,
    extension: 'java',
    caller: 'invoke',
    target: 'target',
    source: `
class Demo {
  static void target() {}
  static void invoke(Runnable callback) { callback.run(); }
  static void main(String[] args) {
    Runnable first = Demo::target;
    Runnable second = first;
    invoke(second);
  }
}
`,
  },
  {
    language: SupportedLanguages.Kotlin,
    extension: 'kt',
    caller: 'invoke',
    target: 'target',
    source: `
fun target() {}
fun invoke(callback: () -> Unit) { callback() }
fun main() {
  val first = ::target
  val second = first
  invoke(second)
}
`,
  },
  {
    language: SupportedLanguages.Go,
    extension: 'go',
    caller: 'invoke',
    target: 'target',
    source: `
package main
func target() {}
func invoke(callback func()) { callback() }
func main() {
  first := target
  second := first
  invoke(second)
}
`,
  },
  {
    language: SupportedLanguages.Rust,
    extension: 'rs',
    caller: 'invoke',
    target: 'target',
    source: `
fn target() {}
fn invoke(callback: fn()) { callback(); }
fn main() {
  let first = target;
  let second = first;
  invoke(second);
}
`,
  },
  {
    language: SupportedLanguages.CSharp,
    extension: 'cs',
    caller: 'Invoke',
    target: 'Target',
    source: `
using System;
class Demo {
  static void Target() {}
  static void Invoke(Action callback) { callback(); }
  static void Main() {
    Action first = Target;
    Action second = first;
    Invoke(second);
  }
}
`,
  },
  {
    language: SupportedLanguages.PHP,
    extension: 'php',
    caller: 'invoke',
    target: 'target',
    source: `<?php
function target() {}
function invoke($callback) { $callback(); }
$first = target(...);
$second = $first;
invoke($second);
`,
  },
  {
    language: SupportedLanguages.Ruby,
    extension: 'rb',
    caller: 'invoke',
    target: 'target',
    source: `
def target; end
def invoke(callback); callback.call; end
first = method(:target)
second = first
invoke(second)
`,
  },
  {
    language: SupportedLanguages.Swift,
    extension: 'swift',
    caller: 'invoke',
    target: 'target',
    source: `
func target() {}
func invoke(_ callback: () -> Void) { callback() }
func main() {
  let first = target
  let second = first
  invoke(second)
}
`,
  },
  {
    language: SupportedLanguages.Dart,
    extension: 'dart',
    caller: 'invoke',
    target: 'target',
    source: `
void target() {}
void invoke(void Function() callback) { callback(); }
void main() {
  final first = target;
  final second = first;
  invoke(second);
}
`,
  },
  {
    language: SupportedLanguages.Vue,
    extension: 'vue',
    caller: 'invoke',
    target: 'target',
    source: `
<script setup lang="ts">
function target(): void {}
function invoke(callback: () => void): void { callback(); }
const first = target;
const second = first;
invoke(second);
</script>
`,
  },
  {
    language: SupportedLanguages.Cobol,
    extension: 'cbl',
    caller: 'INVOKE',
    target: 'TARGET',
    source: `
>>SOURCE FORMAT FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. MAIN.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 CALLBACK USAGE PROCEDURE-POINTER.
PROCEDURE DIVISION.
    SET CALLBACK TO ENTRY "TARGET".
    CALL "INVOKE" USING CALLBACK.
    STOP RUN.
END PROGRAM MAIN.

IDENTIFICATION DIVISION.
PROGRAM-ID. INVOKE.
DATA DIVISION.
LINKAGE SECTION.
01 CB USAGE PROCEDURE-POINTER.
PROCEDURE DIVISION USING CB.
    CALL CB.
    GOBACK.
END PROGRAM INVOKE.

IDENTIFICATION DIVISION.
PROGRAM-ID. TARGET.
PROCEDURE DIVISION.
    GOBACK.
END PROGRAM TARGET.
`,
  },
] as const;

async function runSource(extension: string, source: string, options: PipelineOptions = {}) {
  return runSources({ [`main.${extension}`]: source }, options);
}

async function runSources(files: Record<string, string>, options: PipelineOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-callable-flow-'));
  try {
    for (const [filePath, source] of Object.entries(files)) {
      const fullPath = path.join(root, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, source, 'utf8');
    }
    return await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true, ...options });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function callableCallSiteLines(
  result: Awaited<ReturnType<typeof runSource>>,
  source: string,
  target: string,
): number[] {
  return getRelationships(result, 'CALLS')
    .filter(
      (edge) =>
        edge.source === source &&
        edge.target === target &&
        edge.rel.reason === 'callable-value-flow',
    )
    .map((edge) => Number(edge.rel.id.match(/:(\d+):(\d+)$/)?.[1]))
    .sort((left, right) => left - right);
}

function callsFrom(
  result: Awaited<ReturnType<typeof runSource>>,
  source: string,
): Array<{ target: string; reason: string }> {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source)
    .map((edge) => ({ target: edge.target, reason: edge.rel.reason ?? '' }));
}

function callableTargetQualifiedNames(
  result: Awaited<ReturnType<typeof runSource>>,
  source: string,
): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source && edge.rel.reason === 'callable-value-flow')
    .map((edge) => result.graph.getNode(edge.rel.targetId)?.properties.qualifiedName ?? edge.target)
    .sort();
}

function callableTargetIds(
  result: Awaited<ReturnType<typeof runSource>>,
  source: string,
): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source && edge.rel.reason === 'callable-value-flow')
    .map((edge) => edge.rel.targetId)
    .sort();
}

describe('callable value flow', () => {
  it('governs every registered language provider', () => {
    expect(Object.keys(CALLABLE_FLOW_PROVIDER_COVERAGE).sort()).toEqual(
      Object.keys(providers).sort(),
    );
  });

  it.each(PROVIDER_FLOW_CASES)(
    'resolves assign → copy → argument → invoke for $language',
    async ({ extension, source, caller, target }) => {
      const result = await runSource(extension, source);
      expect(callsFrom(result, caller)).toContainEqual({
        target,
        reason: 'callable-value-flow',
      });
    },
    90_000,
  );

  it('resolves C function pointers, pointer copies, pointer-to-pointer loads, and two wrappers', async () => {
    const result = await runSource(
      'c',
      `
void target(void) {}
void callback(void) {}
void installed_target(void) {}
void invoke(void (*callback)(void)) { callback(); }
void outer(void (*cb)(void)) { invoke(cb); }
void install(void (**slot)(void)) { *slot = &installed_target; }

int entry(void) {
  void (*fp)(void) = &target;
  void (*fp2)(void) = fp;
  void (**slot)(void) = &fp2;
  fp();
  (*fp2)();
  (*slot)();
  (**slot)();
  invoke(*slot);
  outer(target);
  void (*installed)(void) = &callback;
  install(&installed);
  installed();
  return 0;
}
`,
    );

    expect(callsFrom(result, 'entry')).toEqual(
      expect.arrayContaining([
        { target: 'target', reason: 'callable-value-flow' },
        { target: 'installed_target', reason: 'callable-value-flow' },
        expect.objectContaining({ target: 'invoke' }),
        expect.objectContaining({ target: 'outer' }),
        expect.objectContaining({ target: 'install' }),
      ]),
    );
    expect(callsFrom(result, 'invoke')).toContainEqual({
      target: 'target',
      reason: 'callable-value-flow',
    });
    expect(callsFrom(result, 'invoke').some((edge) => edge.target === 'callback')).toBe(false);
    expect(callableCallSiteLines(result, 'entry', 'target')).toEqual([13, 14, 15, 16]);
    expect(callableCallSiteLines(result, 'entry', 'installed_target')).toEqual([21]);
    expect(callableCallSiteLines(result, 'invoke', 'target')).toEqual([5]);
  }, 60_000);

  it('joins C prototypes to cross-file definitions without leaking a static decoy', async () => {
    const result = await runSources({
      'target.c': 'void target(void) {}\n',
      'decoy.c': 'static void target(void) {}\n',
      'wrapper.c': 'void invoke(void (*callback)(void)) { callback(); }\n',
      'main.c': `
void target(void);
void invoke(void (*callback)(void));
int main(void) {
  void (*assigned)(void) = target;
  invoke(assigned);
  return 0;
}
`,
    });

    const callbackEdges = getRelationships(result, 'CALLS').filter(
      (edge) =>
        edge.source === 'invoke' &&
        edge.target === 'target' &&
        edge.rel.reason === 'callable-value-flow',
    );
    expect(callbackEdges).toHaveLength(1);
    expect(callbackEdges[0]!.sourceFilePath).toBe('wrapper.c');
    expect(callbackEdges[0]!.targetFilePath).toBe('target.c');
  }, 60_000);

  it('uses a C++ function-pointer signature to select one overload and suppresses untyped overload sets', async () => {
    const result = await runSource(
      'cpp',
      `
void target(int) {}
void target(double) {}

int entry() {
  void (*typed)(int) = &target;
  auto unresolved = target;
  typed(1);
  unresolved(1);
  return 0;
}
`,
    );

    expect(callableTargetQualifiedNames(result, 'entry')).toEqual(['target']);
    expect(callableCallSiteLines(result, 'entry', 'target')).toEqual([8]);
    const targetEdge = getRelationships(result, 'CALLS').find(
      (edge) =>
        edge.source === 'entry' &&
        edge.target === 'target' &&
        edge.rel.reason === 'callable-value-flow',
    );
    expect(result.graph.getNode(targetEdge!.rel.targetId)?.properties.parameterTypes).toEqual([
      'int',
    ]);
  }, 60_000);

  it('retains C++ pointer and member-pointer signatures across split declaration and assignment', async () => {
    const result = await runSource(
      'cpp',
      `
void target(int) {}
void target(double) {}
struct Base {
  virtual void run() const {}
  virtual void run() {}
};
struct Derived : Base {
  void run() const override {}
  void run() override {}
};
void invoke(void (*callback)(int), Derived& value, void (Base::*member)() const) {
  callback(1);
  (value.*member)();
}
int entry() {
  void (*callback)(int);
  callback = &target;
  void (Base::*member)() const;
  member = &Base::run;
  Derived value;
  invoke(callback, value, member);
  return 0;
}
`,
      { skipGraphPhases: false },
    );

    const targets = getRelationships(result, 'CALLS')
      .filter((edge) => edge.source === 'invoke' && edge.rel.reason === 'callable-value-flow')
      .map((edge) => ({
        id: edge.rel.targetId,
        properties: result.graph.getNode(edge.rel.targetId)?.properties,
      }));
    expect(targets).toHaveLength(2);
    expect(
      targets.some(
        ({ id, properties }) =>
          id.includes('target') &&
          JSON.stringify(properties?.parameterTypes) === JSON.stringify(['int']),
      ),
    ).toBe(true);
    expect(
      targets.some(
        ({ id, properties }) => id.includes('Derived.run') && properties?.isConst === true,
      ),
    ).toBe(true);
    expect(
      targets.some(
        ({ id, properties }) =>
          JSON.stringify(properties?.parameterTypes) === JSON.stringify(['double']) ||
          (id.includes('Derived.run') && properties?.isConst !== true),
      ),
    ).toBe(false);
  }, 90_000);

  it('resolves an imported C++ function assigned through an auto pointer', async () => {
    const result = await runSources({
      'target.hpp': 'void target();\n',
      'target.cpp': '#include "target.hpp"\nvoid target() {}\n',
      'main.cpp': '#include "target.hpp"\nint entry() { auto callback = &target; callback(); }\n',
    });

    const targetEdges = getRelationships(result, 'CALLS').filter(
      (edge) =>
        edge.source === 'entry' &&
        edge.target === 'target' &&
        edge.rel.reason === 'callable-value-flow',
    );
    expect(targetEdges).toHaveLength(1);
    expect(result.graph.getNode(targetEdges[0]!.rel.targetId)?.properties.filePath).toBe(
      'target.cpp',
    );
  }, 90_000);

  it('dispatches C++ member pointers through object/reference and pointer receivers to the virtual override', async () => {
    const result = await runSource(
      'cpp',
      `
struct Base {
  virtual void run() {}
};
struct Derived : Base {
  void run() override {}
};

void invoke(Derived& value, void (Base::*member)()) {
  (value.*member)();
  Derived* pointer = &value;
  (pointer->*member)();
}

int entry() {
  Derived value;
  auto member = &Base::run;
  invoke(value, member);
  return 0;
}
`,
      { skipGraphPhases: false },
    );

    const targets = callableTargetIds(result, 'invoke');
    expect(targets).toHaveLength(2);
    expect(new Set(targets)).toEqual(new Set(['Method:main.cpp:Derived.run#0']));
  }, 90_000);

  it('resolves (obj->*ptr)() regardless of tree-sitter ERROR-recovery grouping (#2522 review)', async () => {
    const result = await runSource(
      'cpp',
      `
struct Base {
  virtual void run() {}
};
struct Derived : Base {
  void run() override {}
};

void invoke(Derived& v, void (Base::*ptr)()) {
  Derived* obj = &v;
  (obj->*ptr)();
}

int entry() {
  Derived v;
  auto ptr = &Base::run;
  invoke(v, ptr);
  return 0;
}
`,
      { skipGraphPhases: false },
    );

    const targets = callableTargetIds(result, 'invoke');
    expect(targets).toHaveLength(1);
    expect(new Set(targets)).toEqual(new Set(['Method:main.cpp:Derived.run#0']));
  }, 90_000);

  it('keeps non-virtual C++ member pointers exact and dispatches virtual overload/cv signatures precisely', async () => {
    const result = await runSource(
      'cpp',
      `
struct Base {
  virtual void run(int) {}
  virtual void run(double) {}
  void fixed() {}
  virtual void cv() const {}
  virtual void cv() {}
};
struct Derived : Base {
  void run(int) override {}
  void run(double) override {}
  void fixed() {}
  void cv() const override {}
  void cv() override {}
};

void invoke(
  Derived& value,
  void (Base::*runMember)(int),
  void (Base::*fixedMember)(),
  void (Base::*constMember)() const,
  void (Base::*mutableMember)()
) {
  (value.*runMember)(1);
  (value.*fixedMember)();
  (value.*constMember)();
  (value.*mutableMember)();
}

int entry() {
  Derived value;
  void (Base::*runMember)(int) = &Base::run;
  void (Base::*fixedMember)() = &Base::fixed;
  void (Base::*constMember)() const = &Base::cv;
  void (Base::*mutableMember)() = &Base::cv;
  invoke(value, runMember, fixedMember, constMember, mutableMember);
  return 0;
}
`,
      { skipGraphPhases: false },
    );

    const targets = getRelationships(result, 'CALLS')
      .filter((edge) => edge.source === 'invoke' && edge.rel.reason === 'callable-value-flow')
      .map((edge) => ({
        id: edge.rel.targetId,
        properties: result.graph.getNode(edge.rel.targetId)?.properties,
      }));
    expect(targets).toHaveLength(4);
    expect(
      targets.some(
        ({ id, properties }) =>
          id.includes('Derived.run') &&
          JSON.stringify(properties?.parameterTypes) === JSON.stringify(['int']),
      ),
    ).toBe(true);
    expect(
      targets.some(
        ({ id, properties }) =>
          id.includes('Derived.run') &&
          JSON.stringify(properties?.parameterTypes) === JSON.stringify(['double']),
      ),
    ).toBe(false);
    expect(targets.some(({ id }) => id.includes('Base.fixed'))).toBe(true);
    expect(targets.some(({ id }) => id.includes('Derived.fixed'))).toBe(false);
    expect(
      targets.some(
        ({ id, properties }) => id.includes('Derived.cv') && properties?.isConst === true,
      ),
    ).toBe(true);
    expect(
      targets.some(
        ({ id, properties }) => id.includes('Derived.cv') && properties?.isConst !== true,
      ),
    ).toBe(true);
  }, 90_000);

  it('resolves C++ function references and references to pointer variables', async () => {
    const result = await runSource(
      'cpp',
      `
void target() {}
void invoke(void (&cb)()) { cb(); }

int entry() {
  void (*fp)(void) = &target;
  void (&fr)(void) = target;
  void (*&fpr)(void) = fp;
  fr();
  fpr();
  invoke(fr);
  return 0;
}
`,
    );

    expect(callsFrom(result, 'entry')).toEqual(
      expect.arrayContaining([
        { target: 'target', reason: 'callable-value-flow' },
        expect.objectContaining({ target: 'invoke' }),
      ]),
    );
    expect(callsFrom(result, 'invoke')).toContainEqual({
      target: 'target',
      reason: 'callable-value-flow',
    });
    expect(callableCallSiteLines(result, 'entry', 'target')).toEqual([9, 10]);
    expect(callableCallSiteLines(result, 'invoke', 'target')).toEqual([3]);
  }, 60_000);

  it('propagates a C++ function reference through a cross-file prototype and formal', async () => {
    const result = await runSources({
      'target.cpp': 'void target() {}\n',
      'decoy.cpp': 'static void target() {}\n',
      'wrapper.cpp': `
using Callback = void (*)();
void invoke(Callback callback) { callback(); }
`,
      'main.cpp': `
using Callback = void (*)();
void target();
void invoke(Callback callback);
int main() {
  void (&reference)() = target;
  invoke(reference);
  return 0;
}
`,
    });

    const callbackEdges = getRelationships(result, 'CALLS').filter(
      (edge) =>
        edge.source === 'invoke' &&
        edge.target === 'target' &&
        edge.rel.reason === 'callable-value-flow',
    );
    expect(callbackEdges).toHaveLength(1);
    expect(callbackEdges[0]!.sourceFilePath).toBe('wrapper.cpp');
    expect(callbackEdges[0]!.targetFilePath).toBe('target.cpp');
  }, 60_000);

  it('resolves TypeScript callable assignment, copy, and actual-to-formal invocation', async () => {
    const result = await runSource(
      'ts',
      `
function target(): void {}
function invoke(callback: () => void): void { callback(); }
function outer(cb: () => void): void { invoke(cb); }

const first = target;
const second = first;
second();
outer(second);
`,
    );

    expect(callsFrom(result, 'main.ts')).toEqual(
      expect.arrayContaining([
        { target: 'target', reason: 'callable-value-flow' },
        expect.objectContaining({ target: 'outer' }),
      ]),
    );
    expect(callsFrom(result, 'invoke')).toContainEqual({
      target: 'target',
      reason: 'callable-value-flow',
    });
  }, 60_000);

  it('propagates an imported callable through a cross-file wrapper without selecting a decoy', async () => {
    const result = await runSources({
      'target.ts': `export function target(): void {}`,
      'decoy.ts': `export function target(): void {}`,
      'wrapper.ts': `
export function invoke(callback: () => void): void {
  callback();
}
`,
      'main.ts': `
import { target } from './target';
import { invoke } from './wrapper';
const assigned = target;
invoke(assigned);
`,
    });

    const edge = getRelationships(result, 'CALLS').find(
      (candidate) =>
        candidate.source === 'invoke' &&
        candidate.target === 'target' &&
        candidate.rel.reason === 'callable-value-flow',
    );
    expect(edge).toBeDefined();
    expect(edge!.sourceFilePath).toBe('wrapper.ts');
    expect(edge!.targetFilePath).toBe('target.ts');
    expect(
      getRelationships(result, 'CALLS').some(
        (candidate) => candidate.source === 'invoke' && candidate.targetFilePath === 'decoy.ts',
      ),
    ).toBe(false);
  }, 60_000);

  it('resolves a bound method assigned to a variable and passed into a wrapper', async () => {
    const result = await runSource(
      'ts',
      `
class Worker {
  run(): void {}
}
class Decoy {
  run(): void {}
}
function invoke(callback: () => void): void { callback(); }
const worker = new Worker();
const assigned = worker.run;
invoke(assigned);
`,
    );

    const edge = getRelationships(result, 'CALLS').find(
      (candidate) =>
        candidate.source === 'invoke' &&
        candidate.target === 'run' &&
        candidate.rel.reason === 'callable-value-flow',
    );
    expect(edge).toBeDefined();
    expect(edge!.targetLabel).toBe('Method');
    expect(edge!.rel.targetId).toContain('Worker.run');
  }, 60_000);

  it('does not reinterpret call results passed as arguments as callable designators', async () => {
    const result = await runSource(
      'ts',
      `
function target(): void {}
function factory(): () => void { return target; }
function invoke(callback: () => void): void { callback(); }
invoke(factory());
`,
    );

    expect(callableCallSiteLines(result, 'invoke', 'target')).toEqual([]);
    expect(callableCallSiteLines(result, 'invoke', 'factory')).toEqual([]);
  }, 60_000);

  it('resolves COBOL procedure pointers in sequence-numbered fixed format (#2522 review)', async () => {
    const result = await runSource(
      'cbl',
      `
000100 IDENTIFICATION DIVISION.
000200 PROGRAM-ID. MAIN.
000300 DATA DIVISION.
000400 WORKING-STORAGE SECTION.
000500 01  CALLBACK USAGE IS PROCEDURE-POINTER.
000600 PROCEDURE DIVISION.
000700     SET CALLBACK TO ENTRY "TARGET".
000800     CALL "INVOKE" USING CALLBACK.
000900     STOP RUN.
001000 END PROGRAM MAIN.
001100 IDENTIFICATION DIVISION.
001200 PROGRAM-ID. INVOKE.
001300 DATA DIVISION.
001400 LINKAGE SECTION.
001500 01  CB USAGE IS PROCEDURE-POINTER.
001600 PROCEDURE DIVISION USING CB.
001700     CALL CB.
001800     GOBACK.
001900 END PROGRAM INVOKE.
002000 IDENTIFICATION DIVISION.
002100 PROGRAM-ID. TARGET.
002200 PROCEDURE DIVISION.
002300     GOBACK.
002400 END PROGRAM TARGET.
`,
    );

    expect(callableCallSiteLines(result, 'INVOKE', 'TARGET')).toEqual([18]);
  }, 60_000);

  it('propagates COBOL procedure pointers through SET x TO y copies (#2522 review)', async () => {
    const result = await runSource(
      'cbl',
      `
>>SOURCE FORMAT FREE
IDENTIFICATION DIVISION.
PROGRAM-ID. MAIN.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 P1 USAGE PROCEDURE-POINTER.
01 P2 USAGE PROCEDURE-POINTER.
PROCEDURE DIVISION.
    SET P1 TO ENTRY "TARGET".
    SET P2 TO P1.
    CALL P2.
    STOP RUN.
END PROGRAM MAIN.

IDENTIFICATION DIVISION.
PROGRAM-ID. TARGET.
PROCEDURE DIVISION.
    GOBACK.
END PROGRAM TARGET.
`,
    );

    expect(callableCallSiteLines(result, 'MAIN', 'TARGET')).toEqual([12]);
  }, 60_000);

  it('ignores commented-out COBOL SET statements (#2522 review)', async () => {
    const result = await runSource(
      'cbl',
      `
000100 IDENTIFICATION DIVISION.
000200 PROGRAM-ID. MAIN.
000300 DATA DIVISION.
000400 WORKING-STORAGE SECTION.
000500 01  CALLBACK USAGE IS PROCEDURE-POINTER.
000600 PROCEDURE DIVISION.
000700     SET CALLBACK TO ENTRY "TARGET".
000750*    SET CALLBACK TO ENTRY "MAIN".
000800     CALL "INVOKE" USING CALLBACK.
000900     STOP RUN.
001000 END PROGRAM MAIN.
001100 IDENTIFICATION DIVISION.
001200 PROGRAM-ID. INVOKE.
001300 DATA DIVISION.
001400 LINKAGE SECTION.
001500 01  CB USAGE IS PROCEDURE-POINTER.
001600 PROCEDURE DIVISION USING CB.
001700     CALL CB.
001800     GOBACK.
001900 END PROGRAM INVOKE.
002000 IDENTIFICATION DIVISION.
002100 PROGRAM-ID. TARGET.
002200 PROCEDURE DIVISION.
002300     GOBACK.
002400 END PROGRAM TARGET.
`,
    );

    // The dead SET in the comment must not add MAIN to the callee set.
    expect(callableCallSiteLines(result, 'INVOKE', 'MAIN')).toEqual([]);
    expect(callableCallSiteLines(result, 'INVOKE', 'TARGET')).toEqual([19]);
  }, 60_000);

  it('does not resolve a Rust unit enum variant seeded as a callable value (#2522 review)', async () => {
    const result = await runSource(
      'rs',
      `
enum Shape {
    Square,
}

fn dispatch(cb: fn()) {
    cb();
}

fn entry() {
    let x = Shape::Square;
    let _ = x;
}

fn main() {
    entry();
    dispatch(main);
}
`,
    );

    // Shape::Square is a value, not a callable — the qualified-name guard
    // must keep the over-captured seed edge-free.
    expect(
      getRelationships(result, 'CALLS').filter(
        (edge) => edge.rel.reason === 'callable-value-flow' && edge.target === 'Square',
      ),
    ).toEqual([]);
  }, 60_000);

  it('pairs Go multi-value := positionally instead of cross-wiring (#2522 review)', async () => {
    const result = await runSource(
      'go',
      `package main

func targetFunc() {}
func otherFunc() {}

func entry() {
	a, b := targetFunc, otherFunc
	a()
	b()
}
`,
    );

    expect(callableCallSiteLines(result, 'entry', 'targetFunc')).toEqual([8]);
    expect(callableCallSiteLines(result, 'entry', 'otherFunc')).toEqual([9]);
  }, 60_000);

  it('does not treat a bare Ruby identifier as a callable reference — it is a call (#2522 review)', async () => {
    const result = await runSource(
      'rb',
      `
def process
  'done'
end

def dispatch(cb)
  cb.call
end

action = process
dispatch(action)
`,
    );

    // `action` holds process's RETURN VALUE (a String); a CALLS edge from
    // dispatch to process here is over-linking.
    expect(callableCallSiteLines(result, 'dispatch', 'process')).toEqual([]);
    expect(
      getRelationships(result, 'CALLS').filter(
        (edge) => edge.rel.reason === 'callable-value-flow' && edge.target === 'process',
      ),
    ).toEqual([]);
  }, 60_000);

  it('resolves the C ops-vtable pattern: struct-field pointer stored then called (#2522 review)', async () => {
    const result = await runSource(
      'c',
      `
void handler(int x) {}
struct ops { void (*run)(int); };
int entry(struct ops *o) {
  o->run = handler;
  o->run(1);
  return 0;
}
`,
    );

    expect(callableCallSiteLines(result, 'entry', 'handler')).toEqual([6]);
  }, 60_000);

  it('resolves a file-scope function pointer assigned in one function and called in another (#2522 review)', async () => {
    const result = await runSource(
      'c',
      `
void handler(int x) {}
static void (*fp)(int);
void init(void) { fp = handler; }
void run(void) { fp(1); }
`,
    );

    expect(callableCallSiteLines(result, 'run', 'handler')).toEqual([5]);
  }, 60_000);

  it('binds variable-indexed function-pointer array cells to the array, not the index (#2522 review)', async () => {
    const result = await runSource(
      'c',
      `
void handler(int x) {}
int entry(void) {
  void (*tbl[2])(int);
  int i = 0;
  tbl[i] = handler;
  tbl[i](7);
  return 0;
}
`,
    );

    expect(callableCallSiteLines(result, 'entry', 'handler')).toEqual([7]);
  }, 60_000);

  it('does not store a factory function itself through a C pointer assignment', async () => {
    const result = await runSource(
      'c',
      `
void initial(void) {}
void produced(void) {}
void (*factory(void))(void) { return &produced; }
void install(void (**slot)(void)) { *slot = factory(); }
int entry(void) {
  void (*callback)(void) = &initial;
  install(&callback);
  callback();
  return 0;
}
`,
    );

    expect(callableCallSiteLines(result, 'entry', 'factory')).toEqual([]);
    expect(callableCallSiteLines(result, 'entry', 'initial')).toEqual([9]);
  }, 60_000);

  it('keeps a direct call outside a nested same-name callable binding on ordinary resolution', async () => {
    const result = await runSource(
      'ts',
      `
function target(): void {}
function replacement(): void {}
function entry(): void {
  target();
  {
    const target = replacement;
    target();
  }
}
`,
    );

    expect(
      getRelationships(result, 'CALLS').some(
        (edge) => edge.source === 'entry' && edge.target === 'target',
      ),
    ).toBe(true);
    expect(callableCallSiteLines(result, 'entry', 'replacement')).toEqual([8]);
  }, 60_000);

  it('keeps the declaration as a target when a function is reassigned through its own name and the RHS is unresolvable (#2522 review)', async () => {
    const result = await runSource(
      'js',
      `
import { fancyGreet } from 'external-pkg';
function greet() {}
function entry() {
  greet = fancyGreet;
  greet();
}
`,
    );

    expect(callableCallSiteLines(result, 'entry', 'greet')).toEqual([6]);
  }, 60_000);

  it('unions the declaration with a resolvable reassignment target (inclusion semantics)', async () => {
    const result = await runSource(
      'js',
      `
function greet() {}
function fancy() {}
function entry() {
  greet = fancy;
  greet();
}
`,
    );

    expect(callableCallSiteLines(result, 'entry', 'greet')).toEqual([6]);
    expect(callableCallSiteLines(result, 'entry', 'fancy')).toEqual([6]);
  }, 60_000);

  it.each([
    {
      language: 'Python',
      extension: 'py',
      source: `
def target():
    pass

def entry(enabled):
    if enabled:
        callback = target
    callback()
`,
    },
    {
      language: 'PHP',
      extension: 'php',
      source: `<?php
function target() {}
function entry($enabled) {
    if ($enabled) {
        $callback = target(...);
    }
    $callback();
}
`,
    },
    {
      language: 'Ruby',
      extension: 'rb',
      source: `
def target; end
def entry(enabled)
  if enabled
    callback = method(:target)
  end
  callback.call
end
`,
    },
    {
      language: 'Kotlin',
      extension: 'kt',
      caller: 'invoke',
      source: `
fun target() {}
fun other() {}
fun invoke(callback: () -> Unit) { callback() }
fun entry(enabled: Boolean) {
    var chosen = ::other
    if (enabled) {
        chosen = ::target
    }
    invoke(chosen)
}
`,
    },
    {
      language: 'C#',
      extension: 'cs',
      source: `
class Demo {
    static void target() {}
    static void entry(bool enabled) {
        System.Action callback = () => {};
        if (enabled) {
            callback = target;
        }
        callback();
    }
}
`,
    },
    {
      language: 'Swift',
      extension: 'swift',
      caller: 'invoke',
      source: `
func target() {}
func other() {}
func invoke(_ callback: () -> Void) { callback() }
func entry(enabled: Bool) {
    var chosen = other
    if enabled {
        chosen = target
    }
    invoke(chosen)
}
`,
    },
    {
      language: 'Dart',
      extension: 'dart',
      source: `
void target() {}

void entry(bool enabled) {
  var callback = () {};
  if (enabled) {
    callback = target;
  }
  callback();
}
`,
    },
  ])(
    'keeps function-scoped callable assignments visible outside nested $language blocks',
    async ({ extension, source, caller = 'entry' }) => {
      const result = await runSource(extension, source);
      expect(callsFrom(result, caller)).toContainEqual({
        target: 'target',
        reason: 'callable-value-flow',
      });
    },
    60_000,
  );

  it('does not leak actuals between distinct C++ wrapper overloads', async () => {
    const result = await runSource(
      'cpp',
      `
void target() {}
void invoke(void (*callback)()) { callback(); }
void invoke(void (*callback)(), int) { callback(); }
int entry() {
  invoke(target);
  return 0;
}
`,
    );

    const sourceParameterCounts = getRelationships(result, 'CALLS')
      .filter((edge) => edge.target === 'target' && edge.rel.reason === 'callable-value-flow')
      .map((edge) => result.graph.getNode(edge.rel.sourceId)?.properties.parameterCount)
      .sort();
    expect(sourceParameterCounts).toEqual([1]);
  }, 90_000);

  it('terminates copy cycles and preserves the reachable callable target', async () => {
    const result = await runSource(
      'ts',
      `
function target(): void {}
let first = target;
let second = first;
first = second;
second = first;
second();
`,
    );

    expect(callsFrom(result, 'main.ts')).toContainEqual({
      target: 'target',
      reason: 'callable-value-flow',
    });
  }, 60_000);

  it('suppresses rather than partially emitting an over-cap candidate set', async () => {
    const targets = Array.from({ length: 33 }, (_, index) => `target${index}`);
    const result = await runSource(
      'js',
      [
        ...targets.map((name) => `function ${name}() {}`),
        `let callback = ${targets[0]};`,
        ...targets.slice(1).map((name) => `callback = ${name};`),
        'callback();',
      ].join('\n'),
    );

    expect(callableTargetIds(result, 'main.js')).toEqual([]);
  }, 60_000);

  it('does not steal an ordinary Java method whose name matches a callable protocol', async () => {
    const result = await runSource(
      'java',
      `
class Worker {
  void run() {}
}
class Demo {
  static void entry() {
    Worker worker = new Worker();
    worker.run();
  }
}
`,
    );

    expect(callsFrom(result, 'entry')).toContainEqual(expect.objectContaining({ target: 'run' }));
    expect(
      callsFrom(result, 'entry').some(
        (edge) => edge.target === 'Worker' && edge.reason === 'callable-value-flow',
      ),
    ).toBe(false);
  }, 60_000);

  it('does not treat a callable invocation result as the callable itself', async () => {
    const result = await runSource(
      'ts',
      `
function target(): number { return 1; }
const value = target();
value();
`,
    );

    expect(callsFrom(result, 'main.ts')).not.toContainEqual({
      target: 'target',
      reason: 'callable-value-flow',
    });
  }, 60_000);

  it('replays identical callable-flow semantics from the durable warm parse cache', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-callable-warm-repo-'));
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-callable-warm-store-'));
    try {
      fs.writeFileSync(
        path.join(root, 'main.ts'),
        `
function target(): void {}
function invoke(callback: () => void): void { callback(); }
const assigned = target;
invoke(assigned);
`,
        'utf8',
      );
      const coldCache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storage,
        onDiskKeys: new Set(),
      };
      const cold = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        parseCache: coldCache,
      });
      const savedKeys = await saveParseCache(storage, coldCache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );
      const warmCache = await loadParseCache(storage);
      const warm = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        parseCache: warmCache,
      });
      const project = (result: Awaited<ReturnType<typeof runSource>>) =>
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.rel.reason === 'callable-value-flow')
          .map(
            (edge) =>
              `${edge.sourceFilePath}:${edge.source}->${edge.targetFilePath}:${edge.target}`,
          )
          .sort();
      expect(project(warm)).toEqual(project(cold));
      expect(project(warm)).toEqual(['main.ts:invoke->main.ts:target']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(storage, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps normal/PDG targets identical and stamps calleeIds at the indirect invocation', async () => {
    const source = `
function target(): void {}
function invoke(callback: () => void): void { callback(); }
const assigned = target;
invoke(assigned);
`;
    const normal = await runSource('ts', source);
    const pdg = await runSource('ts', source, { pdg: true });
    const project = (result: Awaited<ReturnType<typeof runSource>>) =>
      callsFrom(result, 'invoke')
        .filter((edge) => edge.reason === 'callable-value-flow')
        .map((edge) => edge.target)
        .sort();
    expect(project(pdg)).toEqual(project(normal));
    expect(project(pdg)).toEqual(['target']);

    const matchingBlocks: Array<Record<string, unknown>> = [];
    pdg.graph.forEachNode((node) => {
      if (
        node.label === 'BasicBlock' &&
        typeof node.properties.text === 'string' &&
        node.properties.text.includes('callback()')
      ) {
        matchingBlocks.push(node.properties);
      }
    });
    expect(matchingBlocks).not.toHaveLength(0);
    expect(
      matchingBlocks.some(
        (properties) =>
          typeof properties.calleeIds === 'string' && properties.calleeIds.includes('target'),
      ),
    ).toBe(true);
  }, 90_000);
});
