# Callers INSIDE the package: private names stay reachable.
inner_bare <- function() hidden()
inner_qual <- function() exp::hidden()
