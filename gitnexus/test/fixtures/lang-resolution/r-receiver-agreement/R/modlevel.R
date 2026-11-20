# Module-level `u`, rebound by `<<-` in m6: the module binding is no longer one constructor, so
# no function of this file reads it as a User.
u <- User$new()
m1 <- function() u$save()
m2 <- function() {
  u <- other()
  u$save()
}
m3 <- function() {
  u$save()
  u <- other()
}
m4 <- function(xs) {
  for (u in xs) u$save()
}
m5 <- function(u) u$save()
m6 <- function() {
  u <<- other()
  u$save()
}
# with() is not modelled; the call loses its edge only because m6 poisons the module `u` (limit).
m7 <- function() with(list(u = 1), u$save())
m9 <- function() local({ u <- other(); u$save() })
