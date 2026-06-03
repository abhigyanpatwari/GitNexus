# Nested mixin module included by its SHORT name (#1982 follow-up).
#
# `Loggable` is nested in `App` (qualifiedName `App.Loggable`), but is included
# by its bare short name `Loggable` from a sibling class inside the same module.
# The structure phase materializes a distinct `App.Loggable` node, but the
# resolution-side mixin lookup keys `graphIdByName` by FULL qualifiedName while
# the `__heritage__` marker carries the bare `arg.text` (`Loggable`) — so the
# IMPLEMENTS edge is silently dropped (0 dangling edges, undetectable). The
# shipped same-tail fixture only uses TOP-LEVEL mixin modules, where the full
# qualifiedName equals the bare name, so it cannot catch this.
module App
  module Loggable
    def log; end
  end

  class Service
    include Loggable
  end
end
