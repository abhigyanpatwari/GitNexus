#include <type_traits>

struct S {};

template <class T, std::enable_if_t<std::is_class_v<T>, int> = 0>
void pick(T value) {}

template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void pick(T value) {}

void run() {
  S s;
  int n = 0;
  pick(s);
  pick(n);
}
