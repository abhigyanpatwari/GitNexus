import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { providers } from '../../../src/core/ingestion/languages/index.js';
import { getRelationships, runPipelineFromRepo, type PipelineOptions } from './helpers.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-callable-flow-'));
  try {
    fs.writeFileSync(path.join(root, `main.${extension}`), source, 'utf8');
    return await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true, ...options });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  }, 60_000);

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
