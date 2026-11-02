#ifndef QRT_MOD_H
#define QRT_MOD_H

namespace rp {
struct C {
  int m() { return 1; }
};
template <typename T>
struct Box {
  int m() { return 4; }
};
C make();
// Shares its tail with the global Widget below, in the same header.
struct Widget {
  int m() { return 6; }
};
Widget makeWidget();
}  // namespace rp

struct Widget {
  int n() { return 7; }
};

struct D {
  int m() { return 3; }
};
struct E {
  int m() { return 5; }
};

D makeD();
D* makeDp();

#endif
