struct Left {
  void collide();
};

struct Right {
  void collide();
};

struct Ambiguous : Left, Right {};

void ambiguousCall() {
  Ambiguous value;
  value.collide();
}

struct Dominant : Left, Right {
  void collide();
};

void dominantCall() {
  Dominant value;
  value.collide();
}

struct Root {
  void shared();
};

struct VirtualLeft : virtual Root {};
struct VirtualRight : virtual Root {};
struct VirtualDiamond : VirtualLeft, VirtualRight {};

void virtualDiamondCall() {
  VirtualDiamond value;
  value.shared();
}

struct PlainLeft : Root {};
struct PlainRight : Root {};
struct PlainDiamond : PlainLeft, PlainRight {};

void plainDiamondCall() {
  PlainDiamond value;
  value.shared();
}

struct Base {
  void select(int);
};

struct Derived : Base {
  using Base::select;
  void select(double);
};

void usingCall() {
  Derived value;
  value.select(1);
}
