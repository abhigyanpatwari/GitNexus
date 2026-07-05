#pragma once

template<class T>
struct Base {
  void method();
};

template<class T>
struct Derived : Base<T> {
  void g() {
    Base<T>::method();
  }
};
