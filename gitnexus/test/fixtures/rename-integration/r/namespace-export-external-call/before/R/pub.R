hidden <- function(x) stats::sd(x)

pub <- function() hidden(c(1, 2, 3))
