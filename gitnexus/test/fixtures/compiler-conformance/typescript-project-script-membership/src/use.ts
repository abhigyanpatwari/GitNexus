import '../examples/side';
export function check(a: Excluded, b: Ignored, c: ImportedSide, d: Listed) {
  a.hit();
  b.hit();
  c.hit();
  d.hit();
}
export function patterns(a: BracketPath, b: SimilarPath, c: ExcludedTree) {
  a.run();
  b.run();
  c.run();
}
export function useIndex(value: PackageIndex) {
  value.run();
}
