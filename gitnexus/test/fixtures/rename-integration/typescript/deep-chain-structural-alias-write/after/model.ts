export class Leaf { score = 0; }
export class Branch { leaf: Leaf = new Leaf(); }
export class Root { branch: Branch = new Branch(); }
export class Other { score = 9; }
export const shared = new Root();
export class OtherBranch { leaf: Leaf = new Leaf(); }
