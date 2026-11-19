helper <- function(x) x + 1
r <- function(d) lm(as.formula("y ~ helper(x)"), data = d)
