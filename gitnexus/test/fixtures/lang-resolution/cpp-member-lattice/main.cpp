#include "base.h"

struct Left {
  void collide();
};

struct Right {
  void collide();
};

struct Ambiguous : Left, Right {
  void callThis();
};

void ambiguousCall() {
  Ambiguous value;
  value.collide();
}

void Ambiguous::callThis() {
  this->collide();
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

struct OverrideRoot {
  void overrideMember();
};

struct OverrideLeft : OverrideRoot {
  void overrideMember();
};

struct OverrideRight : OverrideRoot {};
struct OverrideDiamond : OverrideLeft, OverrideRight {};

void nonVirtualOverrideCall() {
  OverrideDiamond value;
  value.overrideMember();
}

struct UsingRoot {
  void inheritedUsing(int);
};

struct UsingMiddle : UsingRoot {
  using UsingRoot::inheritedUsing;
  void inheritedUsing(double);
};

struct UsingLeaf : UsingMiddle {};

void inheritedUsingCall() {
  UsingLeaf value;
  value.inheritedUsing(1);
}

namespace alpha {
struct SameNameBase {
  void qualified(int);
};
}

namespace beta {
struct SameNameBase {
  void qualified(double);
};
}

struct QualifiedBases : alpha::SameNameBase, beta::SameNameBase {
  using alpha::SameNameBase::qualified;
};

void qualifiedUsingCall() {
  QualifiedBases value;
  value.qualified(1);
}

template <typename T>
struct TemplatedOuter {
  template <typename U>
  struct NestedBase {
    void nestedTemplate();
  };
};

struct TemplatedDerived : TemplatedOuter<int>::NestedBase<double> {};

void nestedTemplateCall() {
  TemplatedDerived value;
  value.nestedTemplate();
}

struct CrossFileDerived : CrossFileBase {};

void crossFileCall() {
  CrossFileDerived value;
  value.crossFile();
}
