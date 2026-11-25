package app;
import a.*;
public class U {
  void viaNew() { new T().run(); }
  void viaParam(T t) { t.run(); }
  T field;
  void viaField() { field.run(); }
}
