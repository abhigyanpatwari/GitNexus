module type STORAGE = sig
  type t
  val save : t -> unit
end

module Make : functor (Store : STORAGE) -> sig
  val run : Store.t -> unit
end

include STORAGE
