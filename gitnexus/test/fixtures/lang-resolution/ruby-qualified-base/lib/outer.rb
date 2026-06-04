# Module-nested superclass + a top-level bare base + a mixin module.
#   - `Super` is defined inside `Outer`, so a scoped superclass
#     `< Outer::Super` must resolve to it by its trailing bare name (Super).
#   - `Base` is a top-level class used as the bare-superclass control.
#   - `Mixin` is included by C to exercise the (unchanged) mixin lane.
module Outer
  class Super
    def base
      "super"
    end
  end
end

class Base
  def base
    "base"
  end
end

module Mixin
  def mixed
    "mixed"
  end
end
