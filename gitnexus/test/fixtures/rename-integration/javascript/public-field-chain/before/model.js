class Leaf {
  score = 0;
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
root.branch.leaf.score = root.branch.leaf.score + 1;
const value = root.branch.leaf.score + other.score;
// score stays here.
const label = "score";
