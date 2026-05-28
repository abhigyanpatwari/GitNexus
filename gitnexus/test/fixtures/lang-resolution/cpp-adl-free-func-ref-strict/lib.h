#pragma once

namespace api {
  struct Token {
    friend void run_callback(Token t) {}
  };
}

namespace utils {
  void worker(api::Token token);
}
