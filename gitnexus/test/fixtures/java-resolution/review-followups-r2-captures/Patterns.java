package p;
class Patterns {
  void annotated(Object o) { if (o instanceof @Ann User u) { u.save(); } }
  void qualifiedAnnotated(Object o) { if (o instanceof p.@Ann User u) { u.save(); } }
}