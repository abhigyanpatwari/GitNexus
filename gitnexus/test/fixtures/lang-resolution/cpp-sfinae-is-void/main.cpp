#include <type_traits>

template <class T, std::enable_if_t<std::is_void_v<T>, int> = 0>
void pick(T value) {}

template <class T, std::enable_if_t<std::is_pointer_v<T>, int> = 0>
void pick(T value) {}

void run() {
  void* p;
  pick(p);
}
