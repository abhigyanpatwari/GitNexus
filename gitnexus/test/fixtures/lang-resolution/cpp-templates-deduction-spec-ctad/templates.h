#pragma once
#include <type_traits>
#include <utility>
#include <vector>

// ── B1: One-level peeled template argument deduction + multi-occurrence negative ──

template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void consumeVec(std::vector<T> items) {}

template <class T, std::enable_if_t<std::is_floating_point_v<T>, int> = 0>
void consumeVec(std::vector<T> items) {}

template <class T>
  requires std::is_integral_v<T>
void consumeConstRefVec(const std::vector<T>& items) {}

template <class T>
  requires std::is_floating_point_v<T>
void consumeConstRefVec(const std::vector<T>& items) {}

template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void consumePtr(const T* ptr) {}

template <class T, std::enable_if_t<std::is_floating_point_v<T>, int> = 0>
void consumePtr(const T* ptr) {}

template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void multiParam(T first, T second) {}

template <class T, std::enable_if_t<std::is_floating_point_v<T>, int> = 0>
void multiParam(T first, T second) {}

template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void multiPair(std::pair<T, T> p) {}

template <class T, std::enable_if_t<std::is_floating_point_v<T>, int> = 0>
void multiPair(std::pair<T, T> p) {}

// ── B2: Partial & explicit specialization selection + partial ordering + ambiguity ──

template <class T>
struct S {
  void primaryHit() {}
};

template <class T>
struct S<T*> {
  void ptrSpecHit() {}
};

template <class T>
struct S<const T*> {
  void constPtrSpecHit() {}
};

template <>
struct S<void*> {
  void voidPtrExplicitHit() {}
};

template <class T, class U>
struct Dual {
  void dualPrimaryHit() {}
};

template <class T>
struct Dual<T, int> {
  void leftSpecHit() {}
};

template <class U>
struct Dual<int, U> {
  void rightSpecHit() {}
};

namespace ns {
template <class T>
struct Holder {
  void nsPrimaryHit() {}
};

template <class T>
struct Holder<T*> {
  void nsPtrSpecHit() {}
};
} // namespace ns

// ── B6: CTAD + user-defined deduction guides + unknown-arg fallback ──

template <class T>
struct Box {
  Box(T value) {}
  void boxPrimaryHit() {}
};

template <>
struct Box<int> {
  Box(int value) {}
  void boxIntSpecHit() {}
};

template <class T>
struct Box<T*> {
  Box(T* ptr) {}
  void boxPtrSpecHit() {}
};

template <>
struct Box<double> {
  Box(double d) {}
  void boxGuideSpecHit() {}
};

// User-defined deduction guide routing C-string literals to Box<double>.
Box(const char*) -> Box<double>;

struct PlainRecord {
  PlainRecord(int id) {}
  void plainHit() {}
};

int opaqueSource();
