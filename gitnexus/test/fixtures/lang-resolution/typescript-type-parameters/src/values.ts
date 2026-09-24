// A VALUE and a TYPE PARAMETER may share a name — TypeScript keeps the type and
// value namespaces apart, so the function `Item` and the parameter `<Item>` are
// different symbols and neither can shadow the other.
export function Item(): void {}

// `render: Item` is a value-ref (#2437), which maps to the same `USES` edge type
// as a type annotation. A shadowing rule keyed on the EDGE TYPE therefore has
// this registration in reach; keyed on the reference KIND it does not. The kind
// is what carries the meaning — the edge type is shared by three of them.
export function useRow<Item>(seed: Item): unknown {
  return { render: Item, seed };
}
