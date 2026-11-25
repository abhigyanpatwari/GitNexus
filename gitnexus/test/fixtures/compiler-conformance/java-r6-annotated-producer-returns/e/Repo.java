package e;
class Repo {
  User @Mark [] annotated() { return null; }
  User /* c */ [] blockComment() { return null; }
  User // c
    [] lineComment() { return null; }
  User trailing() @Mark [] { return null; }
  User @Mark [] [] nested() { return null; }
  User @Mark [] split() /* c */ [] { return null; }
  User plain()[] { return null; }
  void callAnnotated() { annotated()[0].save(); }
  void callBlockComment() { blockComment()[0].save(); }
  void callLineComment() { lineComment()[0].save(); }
  void callTrailing() { trailing()[0].save(); }
  void callNested() { nested()[0][0].save(); }
  void callSplit() { split()[0][0].save(); }
  void callPlain() { plain()[0].save(); }
}
