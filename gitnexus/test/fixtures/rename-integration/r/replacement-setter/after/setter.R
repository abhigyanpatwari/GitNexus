helper <- function(x) x$val

`helper<-` <- function(x, value) {
  x$val <- value
  x
}

z <- list(val = 1)
helper(z) <- 5
