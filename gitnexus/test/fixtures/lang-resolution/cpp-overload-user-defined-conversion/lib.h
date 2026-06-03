#pragma once

class Wrap {
public:
  Wrap(int value);
};

class WrapA {
public:
  WrapA(int value);
};

class WrapB {
public:
  WrapB(int value);
};

class ExplicitWrap {
public:
  explicit ExplicitWrap(int value);
};

class Service {
public:
  void f(Wrap value);
  void f(double value);
  void g(Wrap value);
  void h(WrapA value);
  void h(WrapB value);
  void e(Wrap value);
  void e(ExplicitWrap value);

  void run() {
    f(42);
    g(42);
    h(42);
    e(42);
  }
};
