#include <type_traits>

template <class T, std::enable_if_t<std::is_reference_v<T>, int> = 0>
void pick(T value) {}

template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void pick(T value) {}

void run() {
  int n = 0;
  int& r = n;
  pick(r);
  pick(n);
}
