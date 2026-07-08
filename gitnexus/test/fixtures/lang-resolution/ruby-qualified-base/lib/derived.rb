require_relative 'outer'

# SCOPED superclass `class C < Outer::Super`: the superclass field holds a
# `scope_resolution` (Outer::Super), not a direct `constant`. An earlier synth
# dropped this (findChild(superclass,'constant') was null) so production silently
# omitted the EXTENDS edge (#1951). It must resolve to `Super` by the trailing
# `name:` constant, per the documented scoped-base reduction. Scope-resolution
# owns these edges since #942. `include Mixin` flows through the independent
# mixin lane (IMPLEMENTS, unchanged).
class C < Outer::Super
  include Mixin

  def run
    base
  end
end

# BARE superclass control `class D < Base` (direct `constant`): the original
# path, kept byte-identical. EXTENDS D -> Base.
class D < Base
  def run
    base
  end
end
