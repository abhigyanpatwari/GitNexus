#include <type_traits>

struct S {};

template <class T, std::enable_if_t<std::is_pointer_v<T>, int> = 0>
void pick(T value) {}

template <class T, std::enable_if_t<std::is_class_v<T>, int> = 0>
void pick(T value) {}

void run(S* p, S s) {
  pick(p);
  pick(s);
}
