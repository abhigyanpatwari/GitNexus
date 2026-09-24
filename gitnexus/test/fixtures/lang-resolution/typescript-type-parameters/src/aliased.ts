import { Item as RowItem } from './values';

// The name WRITTEN here is `RowItem`; the def it resolves to is named `Item`.
// Only the written name can be shadowed, and no spelling of the parameter
// `<Item>` reaches this reference — so substituting the resolved def's name for
// the written one deletes an edge that was never shadowed at all.
export function useAliased<Item>(seed: Item): unknown {
  return { render: RowItem, seed };
}
