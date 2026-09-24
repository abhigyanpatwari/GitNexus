// The reader lives in its OWN file and imports neither anchor, so no same-file
// or direct-import tier can decide this. What is left is production-vs-test,
// which is exactly the tier under test — with a reader beside the production
// anchor, the same-file tier resolves it either way and the assertion proves
// nothing.
export function readsProductionShape(bag) {
  return bag.productionAndTestField;
}
