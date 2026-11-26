package q;
class Leaf { public void choose() {} }
class Derived extends p.Leaf { void run() { this.choose(); } }
class Member {}
class UsesInheritedMember extends q.Derived.Member {}
