
class Element {
  void save() {}
  public Element clone() { return this; }
  Element[] get() { return null; }
}
class Other { void save() {} }
class T { void save() {} }
class Base { void save() {} }
class Generic<T extends Base> {
  void bounded(T[] values) { values[0].save(); }
}
class Source { Element make() { return new Element(); } }
class User { void save() {} }
class Decoy { void save() {} }
class Service { User[] getUsers() { return null; } }
class DecoyService { Decoy[] getUsers() { return null; } }
class ArraySource {
  Element[] onlyArgument(int selector) { return null; }
  private Element[] hidden() { return null; }
  Element[] varargs(int... selectors) { return null; }
}
class App {
  Element[] onlyArgument(int selector) { return null; }
  void inapplicableNoArg() { onlyArgument()[0].save(); }
  void inapplicableExplicit(ArraySource source) { source.onlyArgument()[0].save(); }
  void inaccessibleExplicit(ArraySource source) { source.hidden()[0].save(); }
  void applicableExplicit(ArraySource source) { source.onlyArgument(1)[0].save(); }
  void varargsExplicit(ArraySource source) { source.varargs()[0].save(); }
  void cloneChain(Element[] values) { values.clone().save(); }
  void partialCloneChain(Element[][] values) { values[0].clone().save(); }
  void elementCloneChain(Element[] values) { values[0].clone().save(); }
  void elementProducer(Service[] services) { services[0].getUsers()[0].save(); }
  void decoyElementProducer(DecoyService[] services) { services[0].getUsers()[0].save(); }
  void arrayProducerReceiver(Service[][] services) { services[0].getUsers()[0].save(); }
  void parenthesizedArray(Element[] values) { ((values))[0].save(); }
  void copyArray(Element[] values) { var copy = values; copy[0].save(); }
  void copyArrayNegative(Element[] values) { var copy = values; copy.save(); }
  void factoryCopySnapshot(Source source, Source replacement) {
    var value = source.make();
    var copy = value;
    value = replacement.make();
    copy.save();
  }
}
