import { Root, Other } from "./model";
export function update() {
  const root = new Root();
  const other = new Other();
  root.branch.leaf.points = root.branch.leaf.points + 1;
  return root.branch.leaf.points + other.score;
}
// score stays in documentation.
const label = "score";
