#pragma once

namespace std {
class ostream {};
extern ostream cout;
}

struct Point {
  Point operator+(Point rhs) const {
    return rhs;
  }
};

std::ostream& operator<<(std::ostream& os, const Point& p);

void runMember(Point a, Point b);
void runFree(Point p);
void runBuiltin();
