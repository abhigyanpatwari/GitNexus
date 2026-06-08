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

void call_live_member(Gadget& gadget) {
  gadget.touch(1);
}

void call_deleted_member(Gadget& gadget) {
  gadget.touch(1.5);
}

void call_defaulted_constructor() {
  auto gadget = Gadget();
}
