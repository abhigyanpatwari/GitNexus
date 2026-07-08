struct B {
  void inherited();
};

void sink(int value);
void ambiguous(int value);
void ambiguous(double value);
void helper();

namespace tools {
void namespaceHelper();
}

using tools::namespaceHelper;

template <class... Ts>
void logMany(int, Ts... xs) {
  (sink(xs), ...);
}

template <class... Ts>
void foldAmbiguous(Ts... xs) {
  (ambiguous(xs), ...);
}

template <class... B>
struct PlainMix : B... {
  void plainRun() {
    inherited();
  }
};

template <class... B>
struct Mix : B /*pack*/ ... {
  void run() {
    inherited();
    helper();
    namespaceHelper();
  }
};

template <class T>
struct Current {
  void own();

  void run() {
    own();
  }
};

template <class T>
struct UnknownSpecialization {
  typename T::value_type value;

  void run() {
    value.use();
  }
};

void callVariadic() {
  logMany(1, 2, 3);
}
