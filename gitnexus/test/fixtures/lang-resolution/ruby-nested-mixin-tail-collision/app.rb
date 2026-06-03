# Two same-tail NESTED mixin modules (App::Loggable + Web::Loggable), each included
# by a sibling class in the same enclosing module (#1991). The structure phase never
# qualified `module` (Trait) node ids, so both collapsed onto one Trait:app.rb:Loggable
# node and the bare-name mixin reference cross-wired IMPLEMENTS (first-wins tail).
# Single-file on purpose: the bare node id embeds file.path, so a cross-file split
# would not collide. S must IMPLEMENTS App::Loggable only; T → Web::Loggable only.
module App
  module Loggable
    def log; end
  end

  class S
    include Loggable
  end
end

module Web
  module Loggable
    def warn; end
  end

  class T
    include Loggable
  end
end
