struct Outer {
  struct Inner;
};

struct Outer::Inner {
  void inner_method() {}
};

void use() {
  Outer::Inner i;
  i.inner_method();
}
