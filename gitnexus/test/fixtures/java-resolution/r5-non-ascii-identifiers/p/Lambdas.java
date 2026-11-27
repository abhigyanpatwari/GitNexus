package p;
interface Handler<T> { void handle(T c); }
interface Handlér { void handle(Plain c); }
interface AsciiHandler { void handle(Plain c); }
interface SubHandlér extends Handlér {}
interface SubAscii extends AsciiHandler {}
class Lambdas {
  void onGeneric(Handler<Café> h) {}
  void onGenericAscii(Handler<Plain> h) {}
  void onNamed(Handlér h) {}
  void onNamedAscii(AsciiHandler h) {}
  void onSub(SubHandlér h) {}
  void onSubAscii(SubAscii h) {}
  void generic() { onGeneric(c -> c.save()); }
  void genericAscii() { onGenericAscii(c -> c.save()); }
  void named() { onNamed(c -> c.save()); }
  void namedAscii() { onNamedAscii(c -> c.save()); }
  void sub() { onSub(c -> c.save()); }
  void subAscii() { onSubAscii(c -> c.save()); }
}