helper <- function(x) x + 1
r <- function() eval(parse(text = "helper(1)"))
