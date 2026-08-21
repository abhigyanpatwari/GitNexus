// A METHOD-shaped alias member. `schema.ts` declares the `TypeAlias|Method`
// relation pair, but nothing in the corpus emitted one — so the declaration was
// unproven, which is indistinguishable from a missing one until an analyze
// aborts with UndeclaredRelationPairError on a real repo.
export type Dispatcher = {
  handlerCount: number;
  dispatch(event: string): void;
  teardown(): Promise<void>;
};

export function runDispatcher(d: Dispatcher): void {
  d.dispatch('tick');
}
