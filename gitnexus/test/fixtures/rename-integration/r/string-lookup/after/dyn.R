worker <- function(x) x + 1

run <- function() do.call("worker", list(1))
