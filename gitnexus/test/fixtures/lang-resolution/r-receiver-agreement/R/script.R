# One function per cell. A constructor types `x` only when every binding of `x` in the frame
# agrees with it; NULL and constants are neutral.

# Two constructors of different classes, the call between them: R calls User.save. No edge.
a1 <- function() {
  x <- User$new()
  x$save()
  x <- Address$new()
}
# Two constructors, the call after the second: R calls User.save. No edge (limit: last wins is lost).
a2 <- function() {
  x <- Address$new()
  x <- User$new()
  x$save()
}
# An untyped rebinding after the constructor: R calls whatever other() returns. No edge.
b1 <- function() {
  x <- User$new()
  x <- other()
  x$save()
}
# NULL is neutral: the call errors in R if it runs after the NULL. Edge kept.
b2 <- function() {
  x <- User$new()
  x <- NULL
  x$save()
}
# rm(x) removes the binding. No edge.
b3 <- function() {
  x <- User$new()
  rm(x)
  x$save()
}
# A for variable of the same name. No edge.
b4 <- function(xs) {
  x <- User$new()
  for (x in xs) x$save()
}
# `<<-` assigns in an enclosing frame, so the local `x` is still the User. Edge kept.
b5 <- function() {
  x <- User$new()
  x <<- other()
  x$save()
}
# with() is not modelled: x is the list element in R. Wrong edge kept (limit).
b6 <- function() {
  x <- User$new()
  with(list(x = 1), x$save())
}
# Branches that construct different classes. No edge.
c1 <- function(f) {
  if (f) x <- User$new() else x <- Address$new()
  x$save()
}
c2 <- function(f) {
  if (f) {
    x <- Address$new()
  } else {
    x <- User$new()
  }
  x$save()
}
# A right assignment binds no type today (no edge, as at HEAD).
d1 <- function() {
  User$new() -> x
  x$save()
}
# `=` is an assignment. Edge kept.
d2 <- function() {
  x = User$new()
  x$save()
}
# NULL initialisation, then the constructor. Edge kept.
e1 <- function() {
  x <- NULL
  x <- User$new()
  x$save()
}
# The same class constructed twice. Edge kept.
e2 <- function() {
  x <- User$new()
  x$save()
  x <- User$new()
}
# A self-returning method assigned back is another value. No edge (lost).
e4 <- function() {
  x <- User$new()
  x <- x$validate()
  x$save()
}
# A constructor in every loop iteration. Edge kept.
e5 <- function(n) {
  for (i in seq_len(n)) {
    x <- User$new()
    x$save()
  }
}
# Field writes keep the instance (R6 reference semantics). Edges kept.
fw1 <- function() {
  x <- User$new()
  x$a <- 1
  x$save()
}
fw2 <- function() {
  x <- User$new()
  x[["a"]] <- 1
  x$save()
}
fw3 <- function() {
  x <- User$new()
  names(x$a) <- "n"
  x$save()
}
# A replacement call applied to x itself rebinds it to what the setter returns. No edge.
rp1 <- function() {
  x <- User$new()
  class(x) <- "other"
  x$save()
}
# assign() with a literal name binds it in this frame. No edge.
as1 <- function() {
  x <- User$new()
  assign("x", other())
  x$save()
}
# `<<-` does not bind in its own frame: x is free in sa1, so the call is not typed. No edge.
sa1 <- function() {
  x <<- User$new()
  x$save()
}
