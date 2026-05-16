#pragma once

namespace utils {
  // A function named `callback` exists in the `utils` namespace. Without the
  // parameter-list guard, passing a function *parameter* also named `callback`
  // would trigger a workspace scan, find utils::callback, contribute `utils`
  // to the ADL set, and emit a false-positive CALLS edge to utils::run_with.
  void callback();
  void run_with(int n);
}
