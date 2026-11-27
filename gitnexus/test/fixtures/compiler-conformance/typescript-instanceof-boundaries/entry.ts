
import { Key, Other, Value } from './owners.js';

export function branches(repo: Key | Value | Other) {
  if (repo instanceof Key) { repo.before(); }
  else { repo.save(); }
}
export function outside(repo: Key | Value) {
  if (repo instanceof Key) { void repo; }
  repo.save();
}
export function unbraced(repo: Key | Value) {
  if (repo instanceof Key) repo.before();
  repo.save();
}
export function reassigned(repo: Key | Value) {
  if (repo instanceof Key) {
    repo.before();
    repo = new Value();
    repo.save();
  }
}
export function sequencedWrite(repo: Key | Value, replacement: Value) {
  if (repo instanceof Key) { repo.before(), repo = replacement, repo.save(); }
}
export function unbracedSequence(repo: Key | Value, replacement: Value) {
  if (repo instanceof Key) repo.before(), repo = replacement, repo.save();
}
export function loopSequence(repo: Key | Value, replacement: Value, repeat: boolean) {
  if (repo instanceof Key) {
    while (repeat) repo.before(), repo = replacement, repo.save();
  }
}
export function conditionalWrite(repo: Key | Value, replace: boolean) {
  if (repo instanceof Key) {
    repo.before();
    if (replace) [repo] = [new Value()];
    repo.save();
  }
}
export function loopWrite(repo: Key | Value, values: Value[]) {
  if (repo instanceof Key) {
    repo.before();
    for (repo of values) repo.save();
  }
}
export function wrappedWrite(repo: Key | Value) {
  if (repo instanceof Key) {
    repo.before();
    (repo) = new Value();
    repo.save();
  }
}
export function escapedWrite(repo: Key | Value) {
  if (repo instanceof Key) {
    repo.before();
    r\u0065po = new Value();
    repo.save();
  }
}
export function shadowWrite(repo: Key | Value) {
  if (repo instanceof Key) {
    { let repo: Value = new Value(); repo = new Value(); repo.save(); }
    repo.before();
  }
}
export function shadowConstructor(repo: Key | Value) {
  if (repo instanceof Key) {
    const Key = Value;
    void Key;
    repo.save();
  }
}
export function deferred(repo: Key | Value) {
  if (repo instanceof Key) {
    const later = () => repo.save();
    repo = new Value();
    return later;
  }
}
export function stableDeferred(repo: Key | Value) {
  if (repo instanceof Key) {
    const stable = () => repo.save();
    return stable;
  }
}
export function closureWrite(repo: Key | Value) {
  function replace() { repo = new Value(); }
  if (repo instanceof Key) {
    replace();
    repo.save();
  }
}

export function reversed(value: Value | Key) { value.save(); }

export namespace Store {
  export let repo: Key | Value = new Key();
  if (repo instanceof Key) {
    repo.before();
    repo = new Value();
    repo.save();
  }
}

class Base { run() {} }
class First extends Base { run() {} }
class Second extends Base { run() {} }
export function declaredBase(value: Base) {
  if (value instanceof First) {
    value = new Second();
    value.run();
  }
}

export function chained(repo: Key | Other | Value) {
  if (repo instanceof Key) repo.save();
  else if (repo instanceof Other) repo.save();
  else repo.save();
}
export function independent(repo: Key | Other | Value, other: Key | Other | Value) {
  if (other instanceof Key) return;
  else if (repo instanceof Other) return;
  else repo.save();
}
export function shadowedChain(repo: Key | Other | Value) {
  if (repo instanceof Key) return;
  else if (repo instanceof Other) return;
  else { const repo: Key = new Key(); repo.save(); }
}
class Last { save() {} }
export function longChain(repo: Key | Other | Value | Last) {
  if (repo instanceof Key) return;
  else if (repo instanceof Other) return;
  else if (repo instanceof Value) return;
  else repo.save();
}
export function mixedGuard(repo: Key | Other | Value, other: Key | Other | Value) {
  if (repo instanceof Key) return;
  else if (other instanceof Value) { repo.save(); return; }
  else if (repo instanceof Other) return;
  else repo.save();
}
export function shadowedCtor(repo: Key | Other | Value) {
  {
    const Key = Other;
    if (repo instanceof Key) return;
    else if (repo instanceof Other) return;
    else repo.save();
  }
}
export function resetChain(repo: Key | Other | Value, replacement: Key | Other | Value) {
  if (repo instanceof Key) return;
  else {
    repo = replacement;
    if (repo instanceof Other) return;
    else repo.save();
  }
}
