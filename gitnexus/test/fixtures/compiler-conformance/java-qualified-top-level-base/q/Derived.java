package q;
class Leaf { public void choose() {} }
class Derived extends p.Leaf { void run() { this.choose(); } }
