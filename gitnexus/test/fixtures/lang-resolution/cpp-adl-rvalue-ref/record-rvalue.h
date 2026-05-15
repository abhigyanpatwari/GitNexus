#pragma once

#include "audit.h"

namespace audit {
  void record(Event&& e);
}
