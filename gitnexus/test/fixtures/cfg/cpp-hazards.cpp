// C++ CFG hazard fixture (#2195 U2). Exercises the C core plus the C++-only
// constructs: try/catch, throw, range-for, and lambdas.

#include <vector>
#include <stdexcept>

int if_else(int x) {
  int r;
  if (x > 0) {
    r = 1;
  } else {
    r = -1;
  }
  return r;
}

int try_catch(int x) {
  int result = 0;
  try {
    if (x < 0) {
      throw std::runtime_error("negative");
    }
    result = compute(x);
  } catch (const std::exception &e) {
    result = -1;
    handle(e);
  }
  return result;
}

void throw_no_try(int x) {
  if (x < 0) {
    throw std::runtime_error("bad");
  }
  proceed(x);
}

int range_for(const std::vector<int> &xs) {
  int sum = 0;
  for (int x : xs) {
    sum = sum + x;
  }
  return sum;
}

int with_lambda(int n) {
  auto doubler = [](int v) {
    if (v > 0) {
      return v * 2;
    }
    return 0;
  };
  return doubler(n);
}

// Non-terminating server loop — EXIT must stay reverse-reachable for the CDG pass.
void run_forever() {
  while (true) {
    poll();
  }
}
