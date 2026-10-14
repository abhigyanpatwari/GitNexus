export class Leaf {
  public score: number = 0;
}
export class Branch {
  public leaf: Leaf = new Other();
}
export class Root {
  public branch: Branch = new Branch();
}
export class Other {
  public score: number = 9;
}
