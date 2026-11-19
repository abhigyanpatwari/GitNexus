secret <- function(x) stats::sd(x)

pub <- function() secret(c(1, 2, 3))
