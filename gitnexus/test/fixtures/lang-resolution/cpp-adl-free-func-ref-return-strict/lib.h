#pragma once

namespace api {
  struct Token {
    friend void run_callback(Token t) {}
  };
}

namespace utils {
  api::Token make_token();
}
