# Two module-level constructors of different classes: lost (limit: right for calls after load).
w <- User$new()
w <- Address$new()
n1 <- function() w$save()
# A module-level constructor, then another value. No edge.
v <- User$new()
v <- other()
n2 <- function() v$save()
# One module-level constructor: every function of the file reads it.
k <- User$new()
k1 <- function() k$save()
# A local constant is neutral and binds no lexical name, so the call still walks out to the
# module `k` (limit: the call errors in R).
m8 <- function() {
  k <- 5
  k$save()
}
# A function-local rebinding to another value shadows the module `k` (this file has no `<<-`, so
# only the shadow decides). No User edge.
m10 <- function() {
  k <- other()
  k$save()
}
