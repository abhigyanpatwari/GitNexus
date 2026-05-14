#pragma once

namespace base_lib {
  struct Base {};
  void log(Base);

  struct Root {};
  void trace(Root);
}

namespace middle_lib {
  struct Mid : base_lib::Root {};
}

namespace diamond_lib {
  struct DiamondBase {};
  struct LeftBranch : DiamondBase {};
  struct RightBranch : DiamondBase {};
  void ping(DiamondBase);
}
