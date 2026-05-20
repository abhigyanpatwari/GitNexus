#include <type_traits>

template <class T, std::enable_if_t<std::is_const_v<T>, int> = 0>
void pick(T value) {}

template <class T, std::enable_if_t<std::is_volatile_v<T>, int> = 0>
void pick(T value) {}

void run() {
  const int c = 0;
  volatile int v = 0;
  pick(c);
  pick(v);
}
