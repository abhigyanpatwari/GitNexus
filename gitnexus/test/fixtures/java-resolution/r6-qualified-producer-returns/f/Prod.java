package f;
import g.Outer2;
public class Prod {
  Outer.Inner[] samePackage() { return null; }
  Outer2.Inner[] imported() { return null; }
  g.Outer2.Inner[] fullyQualified() { return null; }
  Outer.Inner[][] grid() { return null; }
  Inner[] simple() { return null; }
  protected Outer.Inner[] shared() { return null; }
  void callSamePackage() { samePackage()[0].save(); }
  void callImported() { imported()[0].save(); }
  void callFullyQualified() { fullyQualified()[0].save(); }
  void callGrid() { grid()[0][0].save(); }
  void callSimple() { simple()[0].save(); }
}