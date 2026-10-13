import { Root, OtherBranch } from "./model";
const root = new Root();
const alias: OtherBranch = root.branch;
alias.leaf = { score: 12 };
root.branch.leaf.score = root.branch.leaf.score + 1;
