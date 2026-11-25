package p;
import q.Outer2;
class Use {
  Outer.Inner[] field;
  void parameter(Outer.Inner[] values) { values[0].save(); }
  void local() { Outer.Inner[] values = new Outer.Inner[1]; values[0].save(); }
  void viaField() { field[0].save(); }
  void viaThis() { this.field[0].save(); }
  void importedRoot(Outer2.Inner[] values) { values[0].save(); }
  void fullyQualified(q.Outer2.Inner[] values) { values[0].save(); }
  void simple(Inner[] values) { values[0].save(); }
}