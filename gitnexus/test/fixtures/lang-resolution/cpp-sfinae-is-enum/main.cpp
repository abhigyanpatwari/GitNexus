#include <type_traits>

enum Color { Red };

template <class T, std::enable_if_t<std::is_enum_v<T>, int> = 0>
void pick(T value) {}

template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void pick(T value) {}

void run() {
  Color color = Red;
  int n = 0;
  pick(color);
  pick(n);
}
