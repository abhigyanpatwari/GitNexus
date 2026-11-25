package i2; class Svc {
  void ex(Ex e) { e.getCode(); }
  void dto(Dto d) { d.setId("1"); }
  void unsure(Unsure u) { u.setId("1"); }
  void shadowed(GModel m) { m.getName(); }
}