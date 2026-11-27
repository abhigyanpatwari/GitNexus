package app;
class App {
  void parameter(models.Outer.Inner value) { value.run(); }
  void local() { models.Outer.Inner value = null; value.run(); }
  void member(models.Outer.Face value) { value.run(); }
}
