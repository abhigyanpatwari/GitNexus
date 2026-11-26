import java.util.function.Function;
class A {
  static Function<Integer,Integer> handler = x -> x;
  int caller() { return handler.apply(1); }
}
