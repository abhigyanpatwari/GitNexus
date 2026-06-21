# Qualified mixin argument (`include Outer::Mixin`) — the `::` in arg.text
# collided with the ':'-delimited __heritage__ marker field separator and the
# IMPLEMENTS edge was silently dropped (#1982 follow-up). The marker now embeds
# the dotted form (`Outer.Mixin`) so the split parses correctly and the lookup
# matches the mixin def's qualifiedName.
module Outer
  module Mixin
    def mixed; end
  end
end

class Consumer
  include Outer::Mixin
end
