#pragma once

class Service {
public:
  void f(int* p);
  void f(bool flag);

  void g(int a, int b);
  void g(int a, ...);

  void h(int a, double b);
  void h(int a, ...);

  void k(int a, ...);

  void run() {
    int* p = nullptr;
    f(nullptr);
    f(p);
    f(42);
    g(1, 2);
    h(1, 'a');
    k(1, 2, 3);
  }
};
