void choose(double) {}
void choose(int) = delete;

void call_live_free() {
  choose(1.5);
}

void call_deleted_free() {
  choose(1);
}

struct Gadget {
  Gadget() = default;

  void touch(int) {}
  void touch(double) = delete;
};

struct BaseChoice {
  void select(double) = delete;
  void select(int) {}
};

struct DerivedChoice : BaseChoice {
  void call_base_qualified_live() {
    BaseChoice::select(1);
  }
};

struct StaticChoice {
  static void select(double) = delete;
  static void select(int) {}
};

struct DefaultedChoice {
  DefaultedChoice(const DefaultedChoice&) = default;
  DefaultedChoice(int) {}
};

namespace choices {
void select(double) = delete;
void select(int);
}

void call_live_member(Gadget& gadget) {
  gadget.touch(1);
}

void call_deleted_member(Gadget& gadget) {
  gadget.touch(1.5);
}

void call_defaulted_constructor() {
  auto gadget = Gadget();
}

void call_same_arity_defaulted_constructor() {
  DefaultedChoice source(1);
  auto copy = DefaultedChoice(source);
}

void call_inherited_live(DerivedChoice& choice) {
  choice.select(1);
}

void call_inherited_deleted(DerivedChoice& choice) {
  choice.select(1.5);
}

void call_static_live() {
  StaticChoice::select(1);
}

void call_static_deleted() {
  StaticChoice::select(1.5);
}

void call_namespace_live() {
  choices::select(1);
}

void call_namespace_deleted() {
  choices::select(1.5);
}
