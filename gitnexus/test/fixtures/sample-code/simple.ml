module UserService = struct
  type user = {
    name : string;
    active : bool;
  }

  let create_user name =
    { name; active = true }

  let greet user =
    print_endline user.name
end

open UserService

let main () =
  let user = create_user "Ada" in
  greet user
