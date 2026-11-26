package p;
import java.util.List;
class Elements {
  void element(List<Äußer.@Ann Ünïcödé /* ü */ > values) { for (var v : values) v.save(); }
  void lineComment(List<Äußer.Ünïcödé // ü
      > values) { for (var v : values) v.save(); }
  void eachLambda(List<Äußer.Ünïcödé> values) { values.forEach(v -> v.save()); }
  void combining(List<Café> values) { for (var v : values) v.save(); }
  void asciiElement(List<Outer.@Ann Inner /* u */ > values) { for (var v : values) v.save(); }
  void asciiLineComment(List<Outer.Inner // u
      > values) { for (var v : values) v.save(); }
  void asciiEachLambda(List<Outer.Inner> values) { values.forEach(v -> v.save()); }
}