module Foo; end
module Baz; end

class Foo::Bar
  def from_foo; end
end

class Baz::Bar
  def from_baz; end
end
