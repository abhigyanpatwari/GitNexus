#pragma once

class Service {
public:
  // Variant 1 & 3: f(int) vs f(double)
  void f(int x);
  void f(double x);

  // Variant 2: g(int) vs g(long) — both normalize to 'int'
  void g(int x);
  void g(long x);

  // Inline: call sites live inside the class scope so the scope-chain
  // walk finds the Class scope, enabling pickImplicitThisOverload to
  // resolve overloads against the declaration-side Method nodes (which
  // carry distinct parameterTypes and graph-node IDs).
  void run() {
    f(2.5);   // Variant 1: double literal -> f(double) wins (exact > standard)
    f(42);    // Variant 3: int literal -> f(int) wins (exact > standard)
    g(42);    // Variant 2: int/long both normalize to 'int' -> ambiguous
  }
};
