module OuterMix; end
module OtherMix; end
module Outer
  class Inner
    include OuterMix
    attr_accessor :outer_attr
    def from_outer; end
  end
end
module Other
  class Inner
    include OtherMix
    attr_accessor :other_attr
    def from_other; end
  end
end
# Unambiguous nested class (no same-tail sibling): exercises the routed-property
# (attr_accessor) owner path, which must resolve to the QUALIFIED owner and not
# dangle under qualifiedNodeId. Same-tail routed-property owner identity is a
# separate resolution-side concern (see ruby.test.ts).
module Shapes
  class Circle
    attr_accessor :radius
  end
end
