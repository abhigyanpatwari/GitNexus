struct Outer { struct Inner; };
struct Other { struct Inner; };

struct Outer::Inner {
  void from_outer() {}
};

struct Other::Inner {
  void from_other() {}
};
