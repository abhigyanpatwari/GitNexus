# d14: the same with a constant. R skips a non-function at a call, so the outer function is the
# right target here; the edge is the same guess (0.5).
helper <- 5
d14_f <- function(x) helper(x)
