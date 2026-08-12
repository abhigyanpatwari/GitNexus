/**
 * Interface-dispatch fan-out is generic-instantiation aware (#2912).
 *
 * `IValidator<string>` and `IValidator<int>` are one DECLARATION and therefore
 * one subtype list, so an erased fan-out reaches implementors of instantiations
 * the receiver can never hold. Each language here declares two incompatible
 * instantiations of one interface with the SAME method name — the shape the
 * issue was filed with — plus the cases the filter must not break: a generic
 * pass-through implementor, a non-generic interface, and (C#) the predefined
 * alias spellings of one type.
 *
 * Every implementor lives in its own file so a dispatch target can be named by
 * `targetFilePath`: the two `Check` methods are otherwise indistinguishable by
 * node name alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

/** Files a dispatch edge out of `caller` landed in, deduped and sorted. */
function dispatchTargetFiles(result: PipelineResult, caller: string, member: string): string[] {
  const files = getRelationships(result, 'CALLS')
    .filter(
      (edge) =>
        edge.source === caller &&
        edge.target === member &&
        edge.rel.reason === 'interface-dispatch',
    )
    .map((edge) => path.basename(edge.targetFilePath));
  return [...new Set(files)].sort();
}

/** Files ANY resolved call out of `caller` landed in — primary edges included. */
function calledFiles(result: PipelineResult, caller: string, member: string): string[] {
  const files = getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === caller && edge.target === member)
    .map((edge) => path.basename(edge.targetFilePath));
  return [...new Set(files)].sort();
}

describe('C# generic interface dispatch (#2912)', () => {
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-csharp-generic-dispatch-'));
    writeFixtureRepo(root, {
      'IValidator.cs': `namespace Probe;
        public interface IValidator<T> { bool Check(T item); }`,
      'UserValidator.cs': `namespace Probe;
        public record UserValidator : IValidator<string> { public bool Check(string item) => true; }`,
      'IntValidator.cs': `namespace Probe;
        public record IntValidator : IValidator<int> { public bool Check(int item) => true; }`,
      'AliasValidator.cs': `namespace Probe;
        public class AliasValidator : IValidator<String> { public bool Check(String item) => true; }`,
      'Wrapper.cs': `namespace Probe;
        public class Wrapper<T> : IValidator<T> { public bool Check(T item) => true; }`,
      'Runner.cs': `namespace Probe;
        public class Runner {
          public bool Run(IValidator<string> v) => v.Check("x");
          public bool RunInt(IValidator<int> v) => v.Check(1);
        }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not fan a string-instantiated receiver out to the int implementor', () => {
    expect(dispatchTargetFiles(result, 'Run', 'Check')).not.toContain('IntValidator.cs');
  });

  it('still reaches the implementor of the matching instantiation', () => {
    expect(dispatchTargetFiles(result, 'Run', 'Check')).toContain('UserValidator.cs');
  });

  it('mirrors the filter for the other instantiation', () => {
    const intTargets = dispatchTargetFiles(result, 'RunInt', 'Check');
    expect(intTargets).toContain('IntValidator.cs');
    expect(intTargets).not.toContain('UserValidator.cs');
  });

  it('keeps a generic pass-through implementor for BOTH instantiations', () => {
    // `Wrapper<T> : IValidator<T>` is an implementor of every instantiation —
    // T binds to the receiver's argument rather than clashing with it.
    expect(dispatchTargetFiles(result, 'Run', 'Check')).toContain('Wrapper.cs');
    expect(dispatchTargetFiles(result, 'RunInt', 'Check')).toContain('Wrapper.cs');
  });

  it('treats the predefined alias spelling as the same instantiation', () => {
    // `IValidator<String>` ≡ `IValidator<string>`: C# defines the keyword as an
    // alias, so pruning on the spelling would delete a real dispatch target.
    expect(dispatchTargetFiles(result, 'Run', 'Check')).toContain('AliasValidator.cs');
    expect(dispatchTargetFiles(result, 'RunInt', 'Check')).not.toContain('AliasValidator.cs');
  });

  it('still emits the primary edge to the interface declaration', () => {
    expect(calledFiles(result, 'Run', 'Check')).toContain('IValidator.cs');
  });
});

describe('C# non-generic interface dispatch is unaffected (#2912)', () => {
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-csharp-plain-dispatch-'));
    writeFixtureRepo(root, {
      'IGreeter.cs': `namespace Probe;
        public interface IGreeter { string Greet(); }`,
      'Loud.cs': `namespace Probe;
        public class Loud : IGreeter { public string Greet() => "HI"; }`,
      'Quiet.cs': `namespace Probe;
        public class Quiet : IGreeter { public string Greet() => "hi"; }`,
      'Runner.cs': `namespace Probe;
        public class Runner { public string Run(IGreeter g) => g.Greet(); }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fans out to every implementor when no generics are involved', () => {
    expect(dispatchTargetFiles(result, 'Run', 'Greet')).toEqual(['Loud.cs', 'Quiet.cs']);
  });
});

describe('Java generic interface dispatch (#2912)', () => {
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-generic-dispatch-'));
    writeFixtureRepo(root, {
      'Validator.java': `package probe;
        public interface Validator<T> { boolean check(T item); }`,
      'StringValidator.java': `package probe;
        public class StringValidator implements Validator<String> {
          public boolean check(String item) { return true; }
        }`,
      'NumberValidator.java': `package probe;
        public class NumberValidator implements Validator<Integer> {
          public boolean check(Integer item) { return true; }
        }`,
      'Runner.java': `package probe;
        public class Runner {
          public boolean run(Validator<String> v) { return v.check("x"); }
        }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reaches only the implementor of the receiver instantiation', () => {
    const targets = dispatchTargetFiles(result, 'run', 'check');
    expect(targets).toContain('StringValidator.java');
    expect(targets).not.toContain('NumberValidator.java');
  });
});

describe('TypeScript generic interface dispatch (#2912)', () => {
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ts-generic-dispatch-'));
    writeFixtureRepo(root, {
      'validator.ts': `export interface Validator<T> { check(item: T): boolean; }`,
      'string-validator.ts': `import type { Validator } from './validator.js';
        export class StringValidator implements Validator<string> {
          check(item: string): boolean { return true; }
        }`,
      'number-validator.ts': `import type { Validator } from './validator.js';
        export class NumberValidator implements Validator<number> {
          check(item: number): boolean { return true; }
        }`,
      'runner.ts': `import type { Validator } from './validator.js';
        export function run(v: Validator<string>): boolean { return v.check('x'); }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reaches only the implementor of the receiver instantiation', () => {
    const targets = dispatchTargetFiles(result, 'run', 'check');
    expect(targets).toContain('string-validator.ts');
    expect(targets).not.toContain('number-validator.ts');
  });
});
