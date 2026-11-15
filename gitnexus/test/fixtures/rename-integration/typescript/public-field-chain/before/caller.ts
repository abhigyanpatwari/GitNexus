import { Root, Other } from "./model";
export function update() {
  const root = new Root();
  const other = new Other();
  root.branch.leaf.score = root.branch.leaf.score + 1;
  return root.branch.leaf.score + other.score;
}
// score stays in documentation.
const label = "score";
