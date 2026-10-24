# One function per cell. Each cell has its own names, so a parameter or a local never carries a
# type from one cell into another unless the cell is about exactly that (the sibling pairs).

# A plain free-function call, the control of the shapes that are not receiver calls.
plain_helper <- function() 1

free_call_control <- function() {
  plain_helper()
}

# Typed receivers.
typed_local <- function() {
  u <- User$new()
  u$save()
}

# The same method name on two classes, and a free function of that name: the owner decides.
same_name_decoy <- function() {
  a <- Address$new()
  a$save()
}

# The S4 spelling of a constructor binds the type environment only, not the scope: no receiver is
# typed by it.
s4_new_spelling <- function() {
  u <- new("User")
  u$save()
}

# Not typed.
untyped_local <- function() {
  u <- make_user()
  u$save()
}

untyped_param <- function(repo) {
  repo$save()
}

# A typed local and an untyped parameter of the same name, in two sibling functions, in both
# orders: the typed function must not lend its type to the untyped one.
sibling_typed_first <- function() {
  svc <- User$new()
  svc$save()
}

sibling_untyped_second <- function(svc) {
  svc$save()
}

sibling_untyped_first <- function(svc) {
  svc$save()
}

sibling_typed_second <- function() {
  svc <- User$new()
  svc$save()
}

# `self` outside an R6 method is not an instance of anything.
self_free <- function() {
  self$climb_up()
}

# Chains with a variable at the base.
chain_dollar <- function(a) {
  a$b$save()
}

chain_new <- function() {
  User$new()$save()
}

# Chains with no variable at the base.
base_call <- function() {
  get_user()$save()
}

base_qualified_new <- function() {
  pkg::User$new()$save()
}

base_subset <- function(x) {
  x[[1]]$f$save()
}
