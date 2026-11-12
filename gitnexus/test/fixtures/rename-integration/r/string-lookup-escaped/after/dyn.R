worker <- function(x) x + 1

run <- function() do.call("wor\u006ber", list(1))
