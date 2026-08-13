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
 * Both ways a receiver gets its type are covered, because they reach the
 * instantiation by different routes: a DECLARED receiver (`Validator<string> v`)
 * carries it on the type binding, while a FOLDED one (`this._validator`,
 * `this._holder.Validator`) is typed by the compound fold, which answers with a
 * class and reports the spelling separately.
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

describe('C# generic dispatch through a FOLDED receiver (#2912)', () => {
  // The dependency-injection shape: the receiver is a field reached through a
  // dot, so it is typed by the compound fold rather than by a type binding.
  // The fold answers with a CLASS, which no longer carries the instantiation —
  // the spelling it typed the position from is what does.
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-csharp-folded-dispatch-'));
    writeFixtureRepo(root, {
      'IValidator.cs': `namespace Probe;
        public interface IValidator<T> { bool Check(T item); }`,
      'UserValidator.cs': `namespace Probe;
        public class UserValidator : IValidator<string> { public bool Check(string item) => true; }`,
      'IntValidator.cs': `namespace Probe;
        public class IntValidator : IValidator<int> { public bool Check(int item) => true; }`,
      'Service.cs': `namespace Probe;
        public class Service {
          private readonly IValidator<string> _validator;
          public Service(IValidator<string> validator) { _validator = validator; }
          public bool Run() => this._validator.Check("x");
        }`,
      'Holder.cs': `namespace Probe;
        public class Holder {
          public IValidator<int> Validator { get; set; }
        }`,
      'ChainRunner.cs': `namespace Probe;
        public class ChainRunner {
          private readonly Holder _holder;
          public ChainRunner(Holder holder) { _holder = holder; }
          public bool RunChain() => this._holder.Validator.Check(1);
        }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('filters a field-typed receiver by its own instantiation', () => {
    const targets = dispatchTargetFiles(result, 'Run', 'Check');
    expect(targets).toContain('UserValidator.cs');
    expect(targets).not.toContain('IntValidator.cs');
  });

  it("filters a two-hop chain by the LAST hop's instantiation", () => {
    // `this._holder.Validator` — the fold walks two members, and it is the
    // second one's declared spelling that types the receiver.
    const targets = dispatchTargetFiles(result, 'RunChain', 'Check');
    expect(targets).toContain('IntValidator.cs');
    expect(targets).not.toContain('UserValidator.cs');
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

describe('Kotlin generic interface dispatch (#2912)', () => {
  // Kotlin needs no per-language wiring: it emits heritage through the shared
  // pre-pass, so the arguments are read off the clause's own spelling. The
  // `class C : Bar<Int>()` shape — a base with a constructor invocation — is
  // the one `stripTrailingCallSuffix` exists for, and is covered here by the
  // supertype being an interface (no call suffix) plus the unit tests on that
  // helper.
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kotlin-generic-dispatch-'));
    writeFixtureRepo(root, {
      'Validator.kt': `package probe
        interface Validator<T> { fun check(item: T): Boolean }`,
      'StringValidator.kt': `package probe
        class StringValidator : Validator<String> {
          override fun check(item: String): Boolean = true
        }`,
      'NumberValidator.kt': `package probe
        class NumberValidator : Validator<Int> {
          override fun check(item: Int): Boolean = true
        }`,
      'Runner.kt': `package probe
        class Runner { fun run(v: Validator<String>): Boolean = v.check("x") }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reaches only the implementor of the receiver instantiation', () => {
    const targets = dispatchTargetFiles(result, 'run', 'check');
    expect(targets).toContain('StringValidator.kt');
    expect(targets).not.toContain('NumberValidator.kt');
  });
});

describe('Kotlin non-generic interface dispatch is unaffected (#2912)', () => {
  // The CONTROL for the case above. Without it, the `not.toContain` there
  // passes just as well when Kotlin emits no dispatch edge at all — which is
  // exactly what Dart, Python and Rust turned out to do for this receiver
  // shape, and why they are not asserted on in this file.
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kotlin-plain-dispatch-'));
    writeFixtureRepo(root, {
      'Greeter.kt': `package probe
        interface Greeter { fun greet(): String }`,
      'Loud.kt': `package probe
        class Loud : Greeter { override fun greet(): String = "HI" }`,
      'Quiet.kt': `package probe
        class Quiet : Greeter { override fun greet(): String = "hi" }`,
      'Runner.kt': `package probe
        class Runner { fun run(g: Greeter): String = g.greet() }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fans out to every implementor when no generics are involved', () => {
    expect(dispatchTargetFiles(result, 'run', 'greet')).toEqual(['Loud.kt', 'Quiet.kt']);
  });
});

describe('Go generic interface dispatch (#2912)', () => {
  // Go reaches the same filter by a different route: implementors are matched
  // STRUCTURALLY rather than by a heritage clause, and the receiver's own
  // `Validator[string]` spelling is what carries the instantiation.
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-go-generic-dispatch-'));
    writeFixtureRepo(root, {
      'validator.go': `package probe

type Validator[T any] interface {
	Check(item T) bool
}`,
      'string_validator.go': `package probe

type StringValidator struct{}

func (s StringValidator) Check(item string) bool { return true }`,
      'number_validator.go': `package probe

type NumberValidator struct{}

func (n NumberValidator) Check(item int) bool { return true }`,
      'runner.go': `package probe

func Run(v Validator[string]) bool { return v.Check("x") }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reaches only the implementor of the receiver instantiation', () => {
    const targets = dispatchTargetFiles(result, 'Run', 'Check');
    expect(targets).toContain('string_validator.go');
    expect(targets).not.toContain('number_validator.go');
  });
});

describe('Go non-generic interface dispatch is unaffected (#2912)', () => {
  let result: PipelineResult;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-go-plain-dispatch-'));
    writeFixtureRepo(root, {
      'greeter.go': `package probe

type Greeter interface {
	Greet() string
}`,
      'loud.go': `package probe

type Loud struct{}

func (l Loud) Greet() string { return "HI" }`,
      'quiet.go': `package probe

type Quiet struct{}

func (q Quiet) Greet() string { return "hi" }`,
      'runner.go': `package probe

func Run(g Greeter) string { return g.Greet() }`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fans out to every implementor when no generics are involved', () => {
    expect(dispatchTargetFiles(result, 'Run', 'Greet')).toEqual(['loud.go', 'quiet.go']);
  });
});
