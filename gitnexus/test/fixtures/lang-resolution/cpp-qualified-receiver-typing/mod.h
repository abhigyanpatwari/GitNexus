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
}  // namespace rp

#endif
