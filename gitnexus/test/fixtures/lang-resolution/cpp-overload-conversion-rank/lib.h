#pragma once

class Service {
public:
  // Variant 1 & 3: f(int) vs f(double)
  void f(int x);
  void f(double x);

  // Variant 2: g(int) vs g(long) — both normalize to 'int'
  void g(int x);
  void g(long x);

  // Variant 4: multi-arg tied total score
  void h(int a, int b);
  void h(double a, double b);

  // Variant 5: char-literal promotion (exercises conversion ranker)
  void p(int x);
  void p(double x);

  // Inline: call sites live inside the class scope so the scope-chain
  // walk finds the Class scope, enabling pickImplicitThisOverload to
  // resolve overloads against the declaration-side Method nodes (which
  // carry distinct parameterTypes and graph-node IDs).
  void run() {
    f(2.5);     // Variant 1: double literal -> f(double) wins (exact > standard)
    f(42);      // Variant 3: int literal -> f(int) wins (exact > standard)
    g(42);      // Variant 2: int/long both normalize to 'int' -> ambiguous
    h(42, 2.5); // Variant 4: incomparable — neither dominates the other -> ambiguous
    h('a', 2.5);// Variant 6: asymmetric — h(int,int) better at arg0 (promotion), h(double,double) better at arg1 (exact) -> ambiguous
    p('a');     // Variant 5: char literal -> p(int) wins via promotion (rank 1 < rank 2)
  }
};
