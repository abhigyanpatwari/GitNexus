export namespace Host {
  export interface Inner {
    ok: boolean;
  }

  // The CONTROL for this file. `Host.Inner` has to be reachable at all before
  // its absence from the generic below can mean anything.
  export function readInner(v: Inner): boolean {
    return v.ok;
  }

  // The shadowed reference resolves to a def whose qualified name is
  // `Host.Inner`. A rule that recovers the name by slicing the resolved graph id
  // compares `Host.Inner` against the parameter `Inner`, misses, and keeps
  // exactly the false edge it exists to remove.
  export function hold<Inner>(value: Inner): Inner {
    return value;
  }
}
