package ib;
class Impl implements ia.I {
  void plain(Inner i) { i.save(); }
  void qualified(ia.I.Inner i) { i.save(); }
}