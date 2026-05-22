#include "lib.h"

namespace std {
ostream cout;
}

std::ostream& operator<<(std::ostream& os, const Point& p) {
  return os;
}

void runMember(Point a, Point b) {
  Point c = a + b;
}

void runFree(Point p) {
  std::cout << p;
}

void runBuiltin() {
  int x = 1 + 2;
}

void runBuiltinVariables(int a, int b) {
  int x = a + b;
  int y = a << b;
}
