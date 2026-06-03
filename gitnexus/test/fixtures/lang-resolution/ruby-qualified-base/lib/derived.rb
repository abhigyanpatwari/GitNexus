require_relative 'outer'

# SCOPED superclass `class C < Outer::Super`: the superclass field holds a
# `scope_resolution` (Outer::Super), not a direct `constant`. The registry-
# primary synth previously dropped this (findChild(superclass,'constant') was
# null) so production silently omitted the EXTENDS edge while the legacy
# @heritage leg captured it (#1951). It must resolve to `Super` by the trailing
# `name:` constant, at parity with normalizeSupertypeName. `include Mixin` flows
# through the independent mixin lane (IMPLEMENTS, unchanged).
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
