class Leaf {
  points = 0;
}
class Branch {
  leaf = new Leaf();
}
class Root {
  branch = new Branch();
}
class Other {
  score = 9;
}
const root = new Root();
const other = new Other();
root.branch.leaf.points = root.branch.leaf.points + 1;
const value = root.branch.leaf.points + other.score;
// score stays here.
const label = "score";
