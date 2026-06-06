module UserService : sig
  type user

  val create_user : string -> user
  val greet : user -> unit
end
