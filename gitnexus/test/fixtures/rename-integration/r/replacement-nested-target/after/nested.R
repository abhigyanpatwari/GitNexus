helper <- function(x) x$items

`helper<-` <- function(x, value) {
  x$items <- value
  x
}

z <- list(items = list(a = 1))
helper(z)$a <- 2
names(helper(z)) <- "b"
