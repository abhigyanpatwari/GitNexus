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

# A constructor types a receiver only when every binding of the name in the frame agrees with it.
# Each of these binds the name to something else as well, so the receiver is untyped.
agree_two_classes <- function() {
  ax <- User$new()
  ax$save()
  ax <- Address$new()
}

agree_rebound <- function() {
  bx <- User$new()
  bx <- make_user()
  bx$save()
}

agree_for_variable <- function(xs) {
  fx <- User$new()
  for (fx in xs) fx$save()
}

agree_branches <- function(f) {
  if (f) cx <- User$new() else cx <- Address$new()
  cx$save()
}

# `<<-` binds in an enclosing frame, never in its own: `sx` is free here.
agree_outward <- function() {
  sx <<- User$new()
  sx$save()
}

# A typed receiver reads the public interface: a private method (of the parent) is not on it.
typed_private <- function() {
  pc <- Child$new()
  pc$secret()
}

# `@` on an R6 instance errors in R: no site.
typed_slot_call <- function() {
  su <- User$new()
  su@save()
}

# A generator object does not carry instance methods.
generator_call <- function() {
  User$save()
}
