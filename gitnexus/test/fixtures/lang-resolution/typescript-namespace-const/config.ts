// RV-9: a const declared inside a TS `namespace`. Its binding scope is
// `Namespace`, not `Module`, so the module-level set built for the block-local
// filter did not contain it and its reads were dropped as if it were a local.
//
// The same shape exists in Rust (`mod`), C++ and C# — anywhere a language nests
// an importable value one level below the file root.
export namespace Limits {
  export const NAMESPACED_MAX = 42;

  export function withinNamespace(): number {
    return NAMESPACED_MAX;
  }
}

// CONTROL: a namespace declared INSIDE a function body is a local like anything
// else there, so its const must stay excluded.
export function makeLocalNamespace(): number {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Inner {
    export const innerLocalValue = 7;
  }
  return Inner.innerLocalValue;
}
