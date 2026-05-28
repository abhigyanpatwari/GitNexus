#pragma once

namespace alpha {

class Token {};

class Other {
public:
  Other(int value);
};

class Service {
public:
  void f(Token value);
  void f(Other value);

  void run() {
    f(42);
  }
};

} // namespace alpha

namespace beta {

class Token {
public:
  Token(int value);
};

} // namespace beta
