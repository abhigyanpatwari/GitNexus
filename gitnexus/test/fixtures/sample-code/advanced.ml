module type STORAGE = sig
  type t
  val save : t -> unit
end

module Make (Store : STORAGE) = struct
  let run item =
    Store.save item
end

module Alias = Make

include Alias
