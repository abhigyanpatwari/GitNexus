worker <- function(x) x + 1

run <- function() do.call(r"(worker)", list(1))
