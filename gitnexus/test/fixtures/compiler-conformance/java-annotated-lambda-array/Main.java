class Element { void save() {} }
  class Marker { void save() {} }
  interface ArrayAction { void accept(Element[] values); }
  class App {
    void run() {
      ArrayAction action = (Element @p.Marker [] values) -> values[0].save();
    }
  }
