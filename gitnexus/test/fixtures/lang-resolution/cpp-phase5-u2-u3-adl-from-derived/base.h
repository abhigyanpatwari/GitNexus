#pragma once

#include "audit.h"

template<class T>
struct Base {
  void record(audit::Event e);
};
