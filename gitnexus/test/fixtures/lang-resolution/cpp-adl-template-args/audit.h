#pragma once

#include <array>
#include <map>
#include <string>
#include <vector>

namespace N {
  struct T {};

  void apply(std::vector<T> v);
  void applyNested(std::map<std::string, std::vector<T>> m);
  void applyArray(std::array<T, 4> a);
  void applyStdConflict(std::vector<T> v);
}

namespace std {
  void applyStdConflict(vector<N::T> v);
}
