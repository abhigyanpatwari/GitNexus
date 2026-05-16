#pragma once

namespace lib {
  struct Foo {
    friend void process(Foo& f) {}
  };
}
