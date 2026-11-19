# d10: a top-level assignment in the caller's own file is not modelled (documented, R-02): the
# call below reads this value in R, but the unique-name fallback binds the function of d1.R.
helper <- identity
d10_f <- function(x) helper(x)
